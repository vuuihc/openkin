import { createHash } from "node:crypto";
import { redactURL } from "./policy.js";
export function evidence(kind, body, metadata) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return {
        kind,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        body: bytes,
        metadata,
    };
}
export function redactError(text) {
    return text
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
        .replace(/(password|token|secret|api[_-]?key|authorization)=([^&\s]+)/gi, "$1=[REDACTED]")
        .replace(/https?:\/\/[^\s"'<>]+/gi, redactURL)
        .replace(/(?:^|[\s("'`])\/(?:[^/\s"'`]+\/)+[^/\s"'`]+/g, "$1[PATH_REDACTED]");
}
