/**
 * Generate the Kin artwork every shell ships, without extra deps:
 *   - macOS tray template icons (black glyphs, transparent background)
 *   - the app icon: dark square with a white "K"
 *       desktop/assets/icon.png + icon.icns  (Electron dock/Finder)
 *       mobile/.../AppIcon-1024.png           (iOS; opaque, edge to edge)
 *
 * One painter, three files: the phone app and the menu-bar app are the same
 * product and must not drift into two different icons.
 */
import { deflateSync } from "node:zlib";
import {
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(root, "..");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Write a grayscale+alpha PNG (8-bit, color type 4). */
function writeGrayAlphaPng(path, size, paint) {
  const stride = 1 + size * 2; // filter byte + GA per pixel
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0; // none filter
    for (let x = 0; x < size; x++) {
      const { g, a } = paint(x, y, size);
      const i = row + 1 + x * 2;
      raw[i] = g;
      raw[i + 1] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 4; // greyscale+alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

/** Write an 8-bit RGB PNG with no alpha channel (color type 2). */
function writeRgbPng(path, size, paint) {
  const stride = 1 + size * 3; // filter byte + RGB per pixel
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0; // none filter
    for (let x = 0; x < size; x++) {
      const { r, g, b } = paint(x, y, size);
      const i = row + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour, no alpha: the App Store rejects an icon that has one
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

/** "K" glyph for tray template (black, transparent bg). */
function paintK(x, y, size) {
  const pad = size * 0.12;
  const left = pad;
  const right = size - pad;
  const top = pad;
  const bottom = size - pad;
  const stemR = left + size * 0.28;
  const midY = size / 2;
  const t = Math.max(1, Math.round(size * 0.12));

  let on = false;
  // vertical stem
  if (x >= left && x < stemR && y >= top && y <= bottom) on = true;
  // upper arm of K
  if (y <= midY) {
    const dx = x - stemR;
    const dy = midY - y;
    if (dx >= 0 && Math.abs(dx - dy * 0.95) < t && x <= right) on = true;
  } else {
    const dx = x - stemR;
    const dy = y - midY;
    if (dx >= 0 && Math.abs(dx - dy * 0.95) < t && x <= right) on = true;
  }
  return on ? { g: 0, a: 255 } : { g: 0, a: 0 };
}

/**
 * Coverage (0..1) of a rounded rectangle — macOS-style app-icon shape.
 * Corner radius ~22% of side; small outer margin for Dock/Finder mask.
 */
function roundedRectCoverage(px, py, size) {
  const margin = size * 0.04;
  const radius = size * 0.22;
  const left = margin;
  const top = margin;
  const right = size - 1 - margin;
  const bottom = size - 1 - margin;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const hw = (right - left) / 2;
  const hh = (bottom - top) / 2;

  // Signed distance to rounded box (negative = inside).
  const qx = Math.abs(px - cx) - (hw - radius);
  const qy = Math.abs(py - cy) - (hh - radius);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const dist =
    Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - radius;

  if (dist <= -0.5) return 1;
  if (dist >= 0.5) return 0;
  return 1 - (dist + 0.5);
}

/** Dark rounded-square app icon with white "K". */
function paintAppIcon(x, y, size) {
  const cover = roundedRectCoverage(x + 0.5, y + 0.5, size);
  if (cover <= 0) return { g: 0, a: 0 };

  const k = paintK(x, y, size);
  const g = k.a > 0 ? 255 : 40; // white K on near-black fill
  const a = Math.round(255 * cover);
  return { g, a };
}

/**
 * The same artwork, edge to edge, for iOS: the system draws the rounded
 * corners itself, so an icon that arrives pre-rounded would end up with a dark
 * square floating inside the mask. The glyph is inset to the share of the
 * canvas it covers on the desktop icon, where the mask does that cropping.
 */
function paintIosAppIcon(x, y, size) {
  const inset = size * 0.14;
  const k = paintK(x - inset, y - inset, size - inset * 2);
  const v = k.a > 0 ? 255 : 40;
  return { r: v, g: v, b: v };
}

/** Build icon.icns from a master PNG via sips + iconutil (macOS only). */
function writeIcns(pngPath, icnsPath) {
  if (process.platform !== "darwin") {
    console.warn("desktop: skip icon.icns (not macOS)");
    return;
  }
  const iconset = join(tmpdir(), `kin-icon-${process.pid}.iconset`);
  try {
    rmSync(iconset, { recursive: true, force: true });
    mkdirSync(iconset, { recursive: true });

    // Standard macOS iconset sizes (1x + 2x).
    const entries = [
      [16, "icon_16x16.png"],
      [32, "icon_16x16@2x.png"],
      [32, "icon_32x32.png"],
      [64, "icon_32x32@2x.png"],
      [128, "icon_128x128.png"],
      [256, "icon_128x128@2x.png"],
      [256, "icon_256x256.png"],
      [512, "icon_256x256@2x.png"],
      [512, "icon_512x512.png"],
      [1024, "icon_512x512@2x.png"],
    ];

    for (const [px, name] of entries) {
      const out = join(iconset, name);
      execFileSync(
        "sips",
        ["-z", String(px), String(px), pngPath, "--out", out],
        { stdio: "ignore" },
      );
    }

    execFileSync("iconutil", ["-c", "icns", iconset, "-o", icnsPath], {
      stdio: "ignore",
    });
  } finally {
    rmSync(iconset, { recursive: true, force: true });
  }
}

const assets = join(root, "assets");
mkdirSync(assets, { recursive: true });

writeGrayAlphaPng(join(assets, "trayTemplate.png"), 16, paintK);
writeGrayAlphaPng(join(assets, "trayTemplate@2x.png"), 32, paintK);

const iconPng = join(assets, "icon.png");
writeGrayAlphaPng(iconPng, 512, paintAppIcon);
writeIcns(iconPng, join(assets, "icon.icns"));

const iosIcon = join(
  repoRoot,
  "mobile",
  "ios",
  "App",
  "App",
  "Assets.xcassets",
  "AppIcon.appiconset",
  "AppIcon-1024.png",
);
mkdirSync(dirname(iosIcon), { recursive: true });
writeRgbPng(iosIcon, 1024, paintIosAppIcon);

console.log("desktop: icons written to assets/ (rounded-square app icon)");
console.log("mobile: iOS app icon written to Assets.xcassets/AppIcon.appiconset");
