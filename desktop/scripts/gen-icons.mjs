/**
 * Generate macOS template tray icons and a simple app icon without extra deps.
 * Template icons: black glyphs on transparent background (macOS tints them).
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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

/** Solid black rounded square "K" for app icon (RGBA via GA, then we only need GA). */
function paintAppIcon(x, y, size) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.42;
  const dx = x - cx + 0.5;
  const dy = y - cy + 0.5;
  const dist = Math.sqrt(dx * dx + dy * dy);
  // soft circle background (white-ish for template? app icons need color —
  // for electron-builder a simple monochrome circle is fine as placeholder)
  if (dist > r) return { g: 0, a: 0 };
  // fill dark
  const k = paintK(x, y, size);
  if (k.a > 0) return { g: 255, a: 255 }; // white K
  return { g: 40, a: 255 }; // dark fill
}

const assets = join(root, "assets");
mkdirSync(assets, { recursive: true });

writeGrayAlphaPng(join(assets, "trayTemplate.png"), 16, paintK);
writeGrayAlphaPng(join(assets, "trayTemplate@2x.png"), 32, paintK);
writeGrayAlphaPng(join(assets, "icon.png"), 512, paintAppIcon);

console.log("desktop: icons written to assets/");
