import { fileExtension } from "./workspacePreview";

/**
 * A self-contained HTML file drawn as a page, not as source.
 *
 * The document is rebuilt from an allowlist in an inert `DOMParser` document
 * instead of patching the source string: a string patch cannot see how a
 * browser tokenizes `<scr<script>ipt>` or an attribute named `onload`, and the
 * browser does not run scripts or load resources in a document without a
 * browsing context. What survives is only what a static page needs.
 *
 * The preview is not a sandbox by itself. It is meant to render inside
 * `<iframe sandbox="">`, which is what makes this an opaque origin with no
 * scripts, forms, popups or navigation. The strict CSP below is the second
 * boundary: even if an element or a style slipped through, it has nothing it
 * is allowed to fetch.
 */

/**
 * The policy that opens every preview document. Tests pin the exact string.
 *
 * No `frame-ancestors`: it only governs a document served as a response, a
 * `<meta>` delivery is ignored by the browser and logs a console error. The
 * iframe's empty `sandbox` already gives the page an opaque origin, and
 * `default-src 'none'` is what keeps it from framing or fetching anything.
 */
export const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/**
 * Elements a static page may keep. Everything absent is removed with its
 * children — including `a`, `script`, `base`, `form`, `iframe`, `object`,
 * `embed` and `link`, the elements that navigate, submit, execute or fetch.
 * SVG, MathML, `template` and form controls are absent too: they either carry
 * their own URL or execution surface, or they are not part of reading a page.
 */
const PASSIVE_ELEMENTS = new Set([
  "html",
  "head",
  "body",
  "title",
  "meta",
  "style",
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "main",
  "nav",
  "figure",
  "figcaption",
  "table",
  "caption",
  "colgroup",
  "col",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "blockquote",
  "pre",
  "code",
  "em",
  "strong",
  "b",
  "i",
  "u",
  "s",
  "small",
  "sub",
  "sup",
  "mark",
  "br",
  "hr",
  "img",
  "address",
  "cite",
  "q",
  "abbr",
  "dfn",
  "kbd",
  "samp",
  "var",
  "time",
  "wbr",
  "ruby",
  "rt",
  "rp",
  "bdi",
  "bdo",
]);

/**
 * Attributes that carry no URL, no event and no style engine of their own.
 * `style` is listed because it is validated separately; everything not here —
 * every `on*`, `href`, `srcset`, `background`, `poster`, `formaction` — goes.
 */
const GLOBAL_ATTRIBUTES = new Set(["class", "id", "title", "lang", "dir", "hidden", "style"]);

/** Element-specific attributes that are values, not references. */
const ELEMENT_ATTRIBUTES: Record<string, Set<string>> = {
  img: new Set(["src", "alt", "width", "height"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  ol: new Set(["start", "reversed", "type"]),
  li: new Set(["value"]),
  td: new Set(["colspan", "rowspan", "scope"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  time: new Set(["datetime"]),
};

/**
 * `meta http-equiv` values that cannot act on their own. `refresh` is the
 * reason this list exists: it navigates without a script or a link.
 */
const HARMLESS_HTTP_EQUIV = new Set(["content-type", "default-style", "x-ua-compatible"]);

/**
 * Raster image types a data URL may carry. SVG is excluded: it is a document
 * with its own references, and this version promises static bitmaps only.
 */
const DATA_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

/** Case-insensitive `.html` / `.htm`. */
export function isHtmlPath(path: string): boolean {
  const ext = fileExtension(path);
  return ext === "html" || ext === "htm";
}

/**
 * CSS that cannot fetch. A block with an `@import`, a `url()` — or an escape
 * that could spell either — is dropped whole rather than patched: a patched
 * stylesheet is a promise about every syntax the patcher did not think of.
 * `image-set()` is an image URL without the `url()` token and is refused for
 * the same reason.
 */
function cssIsPassive(css: string): boolean {
  if (css.includes("\\")) return false;
  if (/@import/i.test(css)) return false;
  if (/url\s*\(/i.test(css)) return false;
  if (/image-set\s*\(/i.test(css)) return false;
  return true;
}

/**
 * A `data:` URL that is exactly a base64-encoded raster image: a permitted
 * mime type, no parameters beyond `base64`, and a payload of the right
 * alphabet and length. Anything else is a URL this preview cannot verify.
 */
function isDataImage(value: string): boolean {
  const match = /^data:([^,]*),([\s\S]*)$/i.exec(value.trim());
  if (!match) return false;
  const parts = match[1].split(";");
  const mime = parts[0].trim().toLowerCase();
  if (!DATA_IMAGE_TYPES.has(mime)) return false;
  if (parts.length !== 2 || parts[1].trim().toLowerCase() !== "base64") return false;
  const payload = match[2];
  return payload.length > 0 && payload.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(payload);
}

function metaIsPassive(element: Element): boolean {
  const equiv = element.getAttribute("http-equiv");
  return equiv !== null && HARMLESS_HTTP_EQUIV.has(equiv.trim().toLowerCase());
}

function sanitizeAttributes(element: Element): void {
  const name = element.localName;
  const specific = ELEMENT_ATTRIBUTES[name];
  for (const attribute of Array.from(element.attributes)) {
    const attributeName = attribute.name.toLowerCase();
    const allowed = GLOBAL_ATTRIBUTES.has(attributeName) || specific?.has(attributeName);
    if (!allowed) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (attributeName === "style" && !cssIsPassive(attribute.value)) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (attributeName === "src" && !isDataImage(attribute.value)) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (
      (attributeName === "width" || attributeName === "height") &&
      !/^\d{1,5}$/.test(attribute.value.trim())
    ) {
      element.removeAttribute(attribute.name);
    }
  }
}

function sanitizeDocument(doc: Document): void {
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    if (!PASSIVE_ELEMENTS.has(element.localName)) {
      element.remove();
      continue;
    }
    sanitizeAttributes(element);
    if (element.localName === "style" && !cssIsPassive(element.textContent ?? "")) {
      element.remove();
    } else if (element.localName === "meta" && !metaIsPassive(element)) {
      element.remove();
    } else if (element.localName === "img" && !element.hasAttribute("src")) {
      // A source whose URL did not validate is not worth an empty frame.
      element.remove();
    }
  }
}

/**
 * Build the inert document a preview iframe receives, with the strict CSP as
 * its first head element. The source is parsed with `DOMParser`, which has no
 * browsing context: no script runs and no resource is fetched while the
 * allowlist is being applied.
 */
export function buildPreviewDocument(source: string): string {
  const doc = new DOMParser().parseFromString(source, "text/html");
  sanitizeDocument(doc);

  const csp = doc.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", PREVIEW_CSP);
  doc.head.insertBefore(csp, doc.head.firstChild);

  return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
}

/**
 * Whether the built document has nothing a person would call a page. A blank
 * body, whitespace, or only style rules is the empty state; a picture counts,
 * because a data image is visible content with no text.
 */
export function previewDocumentIsEmpty(doc: string): boolean {
  const parsed = new DOMParser().parseFromString(doc, "text/html");
  const body = parsed.body;
  if (!body) return true;
  if (body.querySelector("img")) return false;
  const clone = body.cloneNode(true) as HTMLElement;
  for (const element of Array.from(clone.querySelectorAll("style, script, template"))) {
    element.remove();
  }
  return (clone.textContent ?? "").trim() === "";
}
