import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  assertActionAllowed,
  assertAllowedURL,
  assertPathWithinRoot,
  isPrivateDestination,
  requiresApproval,
  redactURL,
  type ApprovalGate,
  type BrowserAction,
  type BrowserPolicyConfig,
  sanitizeActionForEvidence,
} from "./policy.js";
import { evidence, redactError, type EvidenceRecord } from "./evidence.js";

export class BrowserWorker {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly records: EvidenceRecord[] = [];
  private evidenceBytes = 0;
  private allowMutations = false;

  constructor(
    private readonly config: BrowserPolicyConfig,
    private readonly approve: ApprovalGate = async () => false,
  ) {}

  async start(): Promise<void> {
    await mkdir(this.config.download_dir, { recursive: true });
    await mkdir(this.config.upload_dir, { recursive: true });
    this.browser = await chromium.launch({
      headless: true,
      downloadsPath: this.config.download_dir,
    });
    this.context = await this.browser.newContext({
      acceptDownloads: true,
      serviceWorkers: "block",
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
      } catch {
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
      this.appendEvidence(
        evidence("network_error", redactError(request.failure()?.errorText ?? "request failed"), {
          url: redactURL(request.url()),
        }),
      );
    });
  }

  async run(action: BrowserAction): Promise<void> {
    if (!this.page) throw new Error("browser worker is not started");
    assertActionAllowed(action, this.config);
    if (
      requiresApproval(action, this.config)
    ) {
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
          const stream = await download.createReadStream();
          if (!stream) throw new Error("download stream is unavailable");
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of stream) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.byteLength;
            if (size > this.config.max_download_bytes) {
              stream.destroy();
              throw new Error("download exceeds configured size limit");
            }
            chunks.push(bytes);
          }
          const target = path.join(this.config.download_dir, action.filename);
          await writeFile(target, Buffer.concat(chunks), { flag: "wx" });
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
    } finally {
      this.allowMutations = false;
    }
  }

  get evidence(): EvidenceRecord[] {
    return [...this.records];
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
    this.context = null;
    this.browser = null;
    this.page = null;
  }

  private appendEvidence(record: EvidenceRecord): void {
    const configuredRecords = Number(process.env.KIN_BROWSER_MAX_EVIDENCE_RECORDS);
    const configuredBytes = Number(process.env.KIN_BROWSER_MAX_EVIDENCE_BYTES);
    const maxRecords = Number.isFinite(configuredRecords) && configuredRecords > 0
      ? configuredRecords
      : 128;
    const maxBytes = Number.isFinite(configuredBytes) && configuredBytes > 0
      ? configuredBytes
      : 5 * 1024 * 1024;
    if (this.records.length >= maxRecords || this.evidenceBytes + record.size > maxBytes) return;
    this.records.push(record);
    this.evidenceBytes += record.size;
  }
}
