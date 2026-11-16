import { createHash } from "node:crypto";
import { redactURL } from "./policy.js";

export type EvidenceRecord = {
  kind: "screenshot" | "console_error" | "network_error" | "action";
  name?: string;
  mime?: string;
  size: number;
  sha256: string;
  body?: Buffer;
  metadata?: Record<string, unknown>;
};

export function evidence(
  kind: EvidenceRecord["kind"],
  body: Buffer | string,
  metadata?: Record<string, unknown>,
): EvidenceRecord {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    kind,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    body: bytes,
    metadata,
  };
}

export function redactError(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(password|token|secret|api[_-]?key|authorization)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, redactURL)
    .replace(/(?:^|[\s("'`])\/(?:[^/\s"'`]+\/)+[^/\s"'`]+/g, "$1[PATH_REDACTED]");
}
