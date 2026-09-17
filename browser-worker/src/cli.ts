import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { BrowserWorker } from "./runner.js";
import type { BrowserAction, BrowserPolicyConfig } from "./policy.js";
import { redactError } from "./evidence.js";

type ActionRequest = {
  id: string;
  type: "action";
  action: BrowserAction;
};

type ApprovalResponse = {
  id: string;
  type: "approval";
  approved: boolean;
};

const config: BrowserPolicyConfig = {
  allowed_domains: (process.env.KIN_BROWSER_DOMAINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  download_dir: process.env.KIN_BROWSER_DOWNLOAD_DIR ?? "/tmp/kin-browser-downloads",
  upload_dir: process.env.KIN_BROWSER_UPLOAD_DIR ?? "/tmp/kin-browser-uploads",
  max_download_bytes: Number(process.env.KIN_BROWSER_MAX_DOWNLOAD_BYTES ?? 10 * 1024 * 1024),
  require_approval_for_side_effects: true,
};

const approvals = new Map<string, (approved: boolean) => void>();
let activeRequestID = "";
const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const worker = new BrowserWorker(config, async (action) => {
  const id = activeRequestID;
  if (!id) return process.env.KIN_BROWSER_APPROVE === "1";
  output({ id, type: "approval_required", action });
  return new Promise<boolean>((resolve) => approvals.set(id, resolve));
});
await worker.start();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const requests: Promise<void>[] = [];
let actionQueue = Promise.resolve();
input.on("line", (line) => {
  if (!line.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = null;
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    "type" in parsed &&
    parsed.type === "approval"
  ) {
    requests.push(handleLine(line));
    return;
  }
  const next = actionQueue.then(() => handleLine(line));
  actionQueue = next;
  requests.push(next);
});
await new Promise<void>((resolve) => input.once("close", resolve));
await Promise.all(requests);
await worker.close();

async function handleLine(line: string): Promise<void> {
  let message: ActionRequest | ApprovalResponse | BrowserAction;
  try {
    message = JSON.parse(line) as ActionRequest | ApprovalResponse | BrowserAction;
  } catch (error) {
    output({ type: "result", id: "", ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }

  if ("type" in message && message.type === "approval") {
    const resolve = approvals.get(message.id);
    if (resolve) {
      approvals.delete(message.id);
      resolve(message.approved);
    }
    return;
  }

  const request = "action" in message
    ? message
    : { id: randomUUID(), type: "action" as const, action: message };
  const before = worker.evidence.length;
  activeRequestID = request.id;
  try {
    await worker.run(request.action);
    output({
      id: request.id,
      type: "result",
      ok: true,
      evidence: worker.evidence.slice(before).map(toWireEvidence),
    });
  } catch (error) {
    output({
      id: request.id,
      type: "result",
      ok: false,
      error: redactError(error instanceof Error ? error.message : String(error)),
      evidence: worker.evidence.slice(before).map(toWireEvidence),
    });
  } finally {
    activeRequestID = "";
  }
}

function toWireEvidence(record: {
  kind: string;
  name?: string;
  mime?: string;
  size: number;
  sha256: string;
  body?: Buffer;
  metadata?: Record<string, unknown>;
}) {
  return {
    kind: record.kind,
    name: record.name,
    mime: record.mime,
    size: record.size,
    sha256: record.sha256,
    body_base64: record.body?.toString("base64") ?? "",
    metadata: record.metadata,
  };
}
