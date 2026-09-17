import path from "node:path";
import net from "node:net";
import dns from "node:dns/promises";
export class BrowserPolicyError extends Error {
    constructor(message) {
        super(message);
        this.name = "BrowserPolicyError";
    }
}
function normalizeHost(host) {
    return host.trim().toLowerCase().replace(/\.$/, "");
}
export function isAllowedDomain(hostname, allowedDomains) {
    const host = normalizeHost(hostname);
    return allowedDomains.some((raw) => {
        const domain = normalizeHost(raw);
        return host === domain || host.endsWith(`.${domain}`);
    });
}
export function assertAllowedURL(raw, allowedDomains) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new BrowserPolicyError("url is invalid");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new BrowserPolicyError("only http(s) URLs are allowed");
    }
    if (!isAllowedDomain(url.hostname, allowedDomains)) {
        throw new BrowserPolicyError(`domain is not allowlisted: ${url.hostname}`);
    }
    return url;
}
export function isPrivateHost(hostname) {
    const host = normalizeHost(hostname);
    if (host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        host.endsWith(".test")) {
        return true;
    }
    if (net.isIPv4(host)) {
        const octets = host.split(".").map(Number);
        return octets[0] === 10 ||
            (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
            (octets[0] === 192 && octets[1] === 168) ||
            octets[0] === 127 ||
            octets[0] === 169 && octets[1] === 254;
    }
    if (net.isIPv6(host)) {
        const lower = host.toLowerCase();
        return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") ||
            lower.startsWith("fe8") || lower.startsWith("fe9") ||
            lower.startsWith("fea") || lower.startsWith("feb");
    }
    return false;
}
export async function isPrivateDestination(hostname) {
    if (isPrivateHost(hostname) || net.isIP(hostname))
        return isPrivateHost(hostname);
    try {
        const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
        return addresses.some((entry) => isPrivateHost(entry.address));
    }
    catch {
        return true;
    }
}
function assertSafeFilename(filename) {
    const trimmed = filename.trim();
    if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) {
        throw new BrowserPolicyError("filename must be a single safe path component");
    }
    return trimmed;
}
export function assertActionAllowed(action, config) {
    switch (action.type) {
        case "navigate":
            assertAllowedURL(action.url, config.allowed_domains);
            break;
        case "download":
            assertAllowedURL(action.url, config.allowed_domains);
            assertSafeFilename(action.filename);
            break;
        case "upload":
            if (action.path.includes("..") || action.path.includes("\0")) {
                throw new BrowserPolicyError("upload path is invalid");
            }
            break;
        case "click":
        case "fill":
        case "press":
        case "screenshot":
            break;
        default:
            throw new BrowserPolicyError("unsupported browser action");
    }
}
export function requiresApproval(action, config) {
    if (!config.require_approval_for_side_effects)
        return false;
    return action.type === "click" ||
        action.type === "press" ||
        action.type === "upload" ||
        (action.type === "download" && action.sensitive === true);
}
export function assertPathWithinRoot(rawPath, root) {
    const resolvedRoot = path.resolve(root);
    const resolvedPath = path.resolve(rawPath);
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new BrowserPolicyError("path is outside the configured boundary");
    }
    return resolvedPath;
}
export function redactURL(raw) {
    try {
        const url = new URL(raw);
        const sensitive = new Set(["token", "secret", "password", "api_key", "apikey", "authorization"]);
        for (const key of url.searchParams.keys()) {
            if (sensitive.has(key.toLowerCase()))
                url.searchParams.set(key, "[REDACTED]");
        }
        return url.toString();
    }
    catch {
        return "[INVALID_URL]";
    }
}
export function sanitizeActionForEvidence(action) {
    if (action.type === "navigate" || action.type === "download") {
        return { ...action, url: redactURL(action.url) };
    }
    if (action.type === "fill" || action.type === "upload") {
        return {
            type: action.type,
            selector: action.selector,
            sensitive: action.sensitive === true,
        };
    }
    return { ...action };
}
