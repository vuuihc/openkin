import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

/**
 * `make desktop-icons`, `make desktop-dev`, `make desktop-dist` and every
 * `scripts/desktop-rebuild.sh` run this generator. zlib's deflate output
 * differs between Node builds, so committing one Node's bytes made the next
 * rebuild under another Node rewrite the same PNGs and dirty the checkout —
 * which `release.sh` refuses to ship. The writer therefore compares pixels,
 * not files; these cases run the real script in a throwaway tree and pin that
 * for both encoders (greyscale+alpha and RGB).
 */

/**
 * The generator, found by walking up from the cwd: the desktop suite runs it
 * from `desktop/`, while the claim command runs it from the repo root.
 */
function findGenerator() {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const nested = join(dir, "desktop", "scripts", "gen-icons.mjs");
    if (existsSync(nested)) return nested;
    const local = join(dir, "scripts", "gen-icons.mjs");
    if (existsSync(local)) return local;
    if (dirname(dir) === dir) {
      throw new Error(`gen-icons.mjs not found from ${process.cwd()}`);
    }
  }
}

function crc32(buf: Buffer) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function fixtureTree() {
  const root = mkdtempSync(join(tmpdir(), "kin-gen-icons-"));
  mkdirSync(join(root, "desktop", "scripts"), { recursive: true });
  copyFileSync(
    findGenerator(),
    join(root, "desktop", "scripts", "gen-icons.mjs"),
  );
  return root;
}

function runGenerator(root: string) {
  execFileSync(
    process.execPath,
    [join(root, "desktop", "scripts", "gen-icons.mjs")],
    { stdio: "ignore" },
  );
}

function decodePng(path: string) {
  const png = readFileSync(path);
  let offset = 8;
  let ihdr = Buffer.alloc(0);
  const idat: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") ihdr = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  return { ihdr, raw: inflateSync(Buffer.concat(idat)) };
}

function encodePng(ihdr: Buffer, raw: Buffer, level: number) {
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The two encoders the generator uses, one output each: GA icon + RGB web icon. */
function iconTargets(root: string) {
  return [
    join(root, "desktop", "assets", "icon.png"),
    join(root, "ui", "public", "icons", "icon-192.png"),
  ];
}

describe("the icon generator is pixel-idempotent", () => {
  it("leaves a PNG alone when its pixels already match", () => {
    const root = fixtureTree();
    try {
      runGenerator(root);
      // Same scanlines, different IDAT bytes: what another Node's zlib writes.
      const recompressed = iconTargets(root).map((path) => {
        const { ihdr, raw } = decodePng(path);
        const other = encodePng(ihdr, raw, 1);
        assert.ok(
          !other.equals(readFileSync(path)),
          `${path}: the recompressed fixture matched byte for byte`,
        );
        writeFileSync(path, other);
        return { path, bytes: other };
      });

      runGenerator(root);

      for (const { path, bytes } of recompressed) {
        assert.ok(
          readFileSync(path).equals(bytes),
          `${path} was rewritten although its pixels did not change`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rewrites a PNG when a pixel differs", () => {
    const root = fixtureTree();
    try {
      runGenerator(root);
      const targets = iconTargets(root);
      const expected = targets.map((path) => readFileSync(path));
      targets.forEach((path) => {
        const { ihdr, raw } = decodePng(path);
        const changed = Buffer.from(raw);
        changed[1] = changed[1] ^ 0xff; // first pixel's first channel
        writeFileSync(path, encodePng(ihdr, changed, 9));
      });

      runGenerator(root);

      targets.forEach((path, i) => {
        assert.ok(
          readFileSync(path).equals(expected[i]),
          `${path} kept the tampered pixels`,
        );
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
