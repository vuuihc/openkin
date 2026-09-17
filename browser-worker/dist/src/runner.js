import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { assertActionAllowed, assertAllowedURL, assertPathWithinRoot, isPrivateDestination, requiresApproval, redactURL, sanitizeActionForEvidence, } from "./policy.js";
import { evidence, redactError } from "./evidence.js";
export class BrowserWorker {
    config;
    approve;
    browser = null;
    context = null;
    page = null;
    records = [];
    evidenceBytes = 0;
    allowMutations = false;
    constructor(config, approve = async () => false) {
        this.config = config;
        this.approve = approve;
    }
    async start() {
        await mkdir(this.config.download_dir, { recursive: true });
        await mkdir(this.config.upload_dir, { recursive: true });
        this.browser = await chromium.launch({
            headless: true,
            downloadsPath: this.config.download_dir,
        });
        this.context = await this.browser.newContext({
            acceptDownloads: true,
        });
        await this.context.route("**/*", async (route) => {
            const rawURL = route.request().url();
            if (rawURL.startsWith("about:") || rawURL.startsWith("data:") || rawURL.startsWith("blob:")) {
                await route.continue();
                return;
            }
            try {
                const url = assertAllowedURL(rawURL, this.config.allowed_domains);
                if (await isPrivateDestination(url.hostname)) {
                    throw new Error("private destinations are not allowed");
                }
                const method = route.request().method().toUpperCase();
                if (!["GET", "HEAD", "OPTIONS"].includes(method) && !this.allowMutations) {
                    throw new Error("page mutation requires an approved browser action");
                }
                await route.continue();
            }
            catch {
                await route.abort("blockedbyclient");
            }
        });
        await this.context.routeWebSocket("**/*", async (websocket) => {
            await websocket.close({ code: 1008, reason: "WebSockets are disabled by browser policy" });
        });
        this.page = await this.context.newPage();
        this.page.on("console", (msg) => {
            if (msg.type() === "error") {
                this.appendEvidence(evidence("console_error", redactError(msg.text())));
            }
        });
        this.page.on("requestfailed", (request) => {
            this.appendEvidence(evidence("network_error", redactError(request.failure()?.errorText ?? "request failed"), {
                url: redactURL(request.url()),
            }));
        });
    }
    async run(action) {
        if (!this.page)
            throw new Error("browser worker is not started");
        assertActionAllowed(action, this.config);
        if (requiresApproval(action, this.config)) {
            if (this.config.require_approval_for_side_effects && !(await this.approve(action))) {
                throw new Error("browser action denied by approval policy");
            }
            this.allowMutations = true;
        }
        try {
            switch (action.type) {
                case "navigate":
                    await this.page.goto(action.url, { waitUntil: "domcontentloaded" });
                    break;
                case "click":
                    await this.page.locator(action.selector).click();
                    break;
                case "fill":
                    await this.page.locator(action.selector).fill(action.value);
                    break;
                case "press":
                    await this.page.locator(action.selector).press(action.key);
                    break;
                case "upload":
                    await this.page
                        .locator(action.selector)
                        .setInputFiles(assertPathWithinRoot(action.path, this.config.upload_dir));
                    break;
                case "download": {
                    const downloadPromise = this.page.waitForEvent("download");
                    await this.page.goto(action.url, { waitUntil: "domcontentloaded" });
                    const download = await downloadPromise;
                    const target = path.join(this.config.download_dir, action.filename);
                    await download.saveAs(target);
                    const size = (await stat(target)).size;
                    if (size > this.config.max_download_bytes) {
                        await rm(target, { force: true });
                        throw new Error("download exceeds configured size limit");
                    }
                    break;
                }
                case "screenshot": {
                    const body = await this.page.screenshot({ fullPage: true, type: "png" });
                    this.appendEvidence({
                        ...evidence("screenshot", body, { name: action.name ?? "page" }),
                        name: action.name,
                        mime: "image/png",
                    });
                    break;
                }
            }
            this.appendEvidence(evidence("action", JSON.stringify(sanitizeActionForEvidence(action))));
        }
        finally {
            this.allowMutations = false;
        }
    }
    get evidence() {
        return [...this.records];
    }
    async close() {
        await this.context?.close();
        await this.browser?.close();
        this.context = null;
        this.browser = null;
        this.page = null;
    }
    appendEvidence(record) {
        const configuredRecords = Number(process.env.KIN_BROWSER_MAX_EVIDENCE_RECORDS);
        const configuredBytes = Number(process.env.KIN_BROWSER_MAX_EVIDENCE_BYTES);
        const maxRecords = Number.isFinite(configuredRecords) && configuredRecords > 0
            ? configuredRecords
            : 128;
        const maxBytes = Number.isFinite(configuredBytes) && configuredBytes > 0
            ? configuredBytes
            : 5 * 1024 * 1024;
        if (this.records.length >= maxRecords || this.evidenceBytes + record.size > maxBytes)
            return;
        this.records.push(record);
        this.evidenceBytes += record.size;
    }
}
