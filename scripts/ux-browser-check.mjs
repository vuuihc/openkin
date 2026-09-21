#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(repoRoot, ".tmp/ux-browser-check");
const profileDir = resolve(outDir, "chrome-profile");
const baseURL = process.env.KIN_UX_BASE_URL || "http://127.0.0.1:7777";
const chromePath =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = Number(process.env.KIN_UX_CDP_PORT || "9333");
const routes = [
  { name: "settings", path: "/settings" },
  { name: "new-chat", path: "/new" },
];
const widths = [390, 768, 1024, 1440];

function redactSensitive(value) {
  return String(value).replace(
    /([?&])(token|room|key)=([^&#\s]+)/gi,
    (_match, prefix, key) => `${prefix}${key}=<redacted>`,
  ).replace(
    /(%3[fF]|%26)(token|room|key)%3[dD].*?(?=(?:%26|[&#\s])|$)/g,
    (_match, prefix, key) => `${prefix}${key}%3D%3Credacted%3E`,
  );
}

function pageURL(path) {
  const url = new URL(baseURL);
  url.pathname = path;
  return url.toString();
}

function requestJSON(url, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(url, options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(
            new Error(
              `${redactSensitive(url)} returned ${res.statusCode}: ${redactSensitive(body)}`,
            ),
          );
          return;
        }
        try {
          resolvePromise(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForChrome() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await requestJSON(`http://127.0.0.1:${port}/json/version`);
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    }
  }
  throw new Error(`Chrome DevTools did not start on port ${port}`);
}

function createTarget(url) {
  return requestJSON(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });
}

class DevToolsSocket {
  constructor(wsURL) {
    this.wsURL = new URL(wsURL);
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.consoleIssues = [];
  }

  async connect() {
    const key = randomBytes(16).toString("base64");
    const path = `${this.wsURL.pathname}${this.wsURL.search}`;
    this.socket = net.connect(Number(this.wsURL.port), this.wsURL.hostname);
    await new Promise((resolvePromise, reject) => {
      this.socket.once("error", reject);
      this.socket.once("connect", resolvePromise);
    });
    this.socket.write(
      [
        `GET ${path} HTTP/1.1`,
        `Host: ${this.wsURL.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "\r\n",
      ].join("\r\n"),
    );
    await new Promise((resolvePromise, reject) => {
      let header = Buffer.alloc(0);
      const onData = (chunk) => {
        header = Buffer.concat([header, chunk]);
        const end = header.indexOf("\r\n\r\n");
        if (end === -1) return;
        this.socket.off("data", onData);
        const text = header.subarray(0, end).toString("utf8");
        if (!text.startsWith("HTTP/1.1 101")) {
          reject(new Error(`WebSocket upgrade failed: ${text.split("\r\n")[0]}`));
          return;
        }
        const rest = header.subarray(end + 4);
        if (rest.length > 0) this.onData(rest);
        resolvePromise();
      };
      this.socket.on("data", onData);
      this.socket.once("error", reject);
    });
    this.socket.on("data", (chunk) => this.onData(chunk));
  }

  close() {
    this.socket?.end();
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    this.socket.write(encodeFrame(Buffer.from(payload, "utf8")));
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15_000).unref();
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const parsed = decodeFrame(this.buffer);
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.used);
      if (parsed.opcode === 8) {
        this.close();
        return;
      }
      if (parsed.opcode !== 1) continue;
      this.onMessage(parsed.payload.toString("utf8"));
    }
  }

  onMessage(text) {
    const message = JSON.parse(text);
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.consoleAPICalled") {
      const type = message.params?.type;
      if (type === "error" || type === "warning") {
        this.consoleIssues.push({
          source: "console",
          level: type,
          text: redactSensitive(
            (message.params.args ?? [])
              .map((arg) => arg.description ?? arg.value ?? "")
              .join(" "),
          ),
        });
      }
    }
    if (message.method === "Log.entryAdded") {
      const entry = message.params?.entry;
      if (entry?.level === "error" || entry?.level === "warning") {
        this.consoleIssues.push({
          source: entry.source || "log",
          level: entry.level,
          text: redactSensitive(entry.text || ""),
        });
      }
    }
  }
}

function encodeFrame(payload) {
  const length = payload.length;
  const headerLength = length < 126 ? 6 : length < 65536 ? 8 : 14;
  const frame = Buffer.alloc(headerLength + length);
  frame[0] = 0x81;
  if (length < 126) {
    frame[1] = 0x80 | length;
    randomBytes(4).copy(frame, 2);
    maskPayload(payload, frame.subarray(2, 6), frame, 6);
  } else if (length < 65536) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
    randomBytes(4).copy(frame, 4);
    maskPayload(payload, frame.subarray(4, 8), frame, 8);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
    randomBytes(4).copy(frame, 10);
    maskPayload(payload, frame.subarray(10, 14), frame, 14);
  }
  return frame;
}

function maskPayload(payload, mask, frame, offset) {
  for (let i = 0; i < payload.length; i += 1) {
    frame[offset + i] = payload[i] ^ mask[i % 4];
  }
}

function decodeFrame(buffer) {
  let offset = 2;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const masked = (buffer[1] & 0x80) !== 0;
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return null;
  let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  }
  return { opcode, payload, used: offset + maskLength + length };
}

async function runCheck(route, width) {
  const target = await createTarget(pageURL(route.path));
  const client = new DevToolsSocket(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    await client.send("Page.navigate", { url: pageURL(route.path) });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1800));
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    const file = resolve(outDir, `${route.name}-${width}.png`);
    await writeFile(file, Buffer.from(screenshot.data, "base64"));
    return {
      route: route.name,
      width,
      screenshot: file,
      consoleIssues: client.consoleIssues,
    };
  } finally {
    client.close();
  }
}

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  chrome.stderr.on("data", () => undefined);
  try {
    await waitForChrome();
    const results = [];
    for (const route of routes) {
      for (const width of widths) {
        results.push(await runCheck(route, width));
      }
    }
    const report = {
      baseURL: redactSensitive(pageURL("/")),
      generatedAt: new Date().toISOString(),
      results,
    };
    await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));
    const issueCount = results.reduce((count, result) => count + result.consoleIssues.length, 0);
    console.log(`Wrote UX screenshots and report to ${outDir}`);
    if (issueCount > 0) {
      console.error(`Console warnings/errors detected: ${issueCount}`);
      process.exitCode = 1;
    }
  } finally {
    chrome.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
