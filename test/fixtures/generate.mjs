#!/usr/bin/env node
/**
 * Fixture generator.
 *
 * Produces small PNGs with KNOWN timestamps and KNOWN topics, so tests can
 * assert "this query returns this image" without needing real screenshots.
 *
 * Constraints (AGENT.md, GOAL.md C2):
 * - Writes tiny files. Disk on this box is not a budget.
 * - No model downloads, no native image libraries. PNGs are written by hand as
 *   uncompressed zlib streams so this runs with zero dependencies.
 * - Fully deterministic: a seeded PRNG and a fixed date, so the same fixture
 *   set is produced every run.
 *
 * Usage:
 *   node test/fixtures/generate.mjs                 # default set
 *   node test/fixtures/generate.mjs --count 1000    # benchmark set
 *   node test/fixtures/generate.mjs --out /tmp/fix  # custom location
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const OUT_DIR = flag("out", join(import.meta.dirname, "generated"));
const COUNT = Number(flag("count", "24"));

/** Fixed reference date so mtimes never drift. 2026-09-15T10:00 local. */
const BASE = new Date(2026, 8, 15, 10, 0, 0).getTime();
const DAY = 86_400_000;

/** mulberry32 — small, fast, deterministic. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Topics chosen so semantic retrieval is testable: a query using words that do
 * NOT appear in the target text must still rank that image highly.
 */
const TOPICS = [
  { name: "paging-tlb", text: "Paging and TLB. Page table lookup on every access.", keywords: ["paging", "tlb", "page", "table"] },
  { name: "cache-miss", text: "Cache miss penalty. Associative sets and replacement.", keywords: ["cache", "miss", "penalty", "replacement"] },
  { name: "cpu-pipeline", text: "Instruction pipeline hazards, forwarding, and stalls.", keywords: ["pipeline", "hazard", "forwarding"] },
  { name: "isa-design", text: "Instruction set architecture: registers and addressing modes.", keywords: ["isa", "registers", "addressing"] },
  { name: "branch-prediction", text: "Branch prediction with two-bit saturating counters.", keywords: ["branch", "prediction", "counters"] },
  { name: "memory-ordering", text: "Memory consistency models, fences, and reordering.", keywords: ["memory", "consistency", "fences"] },
  { name: "virtual-memory", text: "Virtual memory translation and page faults.", keywords: ["virtual", "translation", "faults"] },
  { name: "io-interrupt", text: "Interrupt handling and device DMA transfer.", keywords: ["interrupt", "dma", "device"] },
];

/**
 * Semantic trap pairs: the query words differ from the document words, so
 * keyword-only search fails and only embedding similarity can succeed.
 */
const TRAPS = [
  { query: "memory management", expect: "paging-tlb" },
  { query: "making the processor go faster", expect: "branch-prediction" },
  { query: "storing data temporarily for speed", expect: "cache-miss" },
];

/**
 * Write an uncompressed-colour PNG (filter type 0 per scanline).
 * Hand-rolled so this has zero dependencies.
 */
function writePng(path, width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  // A "text band" of varying pixels across the top ~20% of the frame, over a
  // flat background. Real screenshots are mostly flat with text on top, which
  // is why they compress well; a full-frame gradient is pathologically
  // incompressible and produced 148 KB fixtures (3.8 MB for 27 files).
  const textRows = Math.max(1, Math.floor(height * 0.2));
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      if (y < textRows) {
        raw[o++] = (rgb[0] + x * 7) & 0xff;
        raw[o++] = (rgb[1] + y * 11) & 0xff;
        raw[o++] = (rgb[2] + x * 3) & 0xff;
      } else {
        raw[o++] = 0xf0;
        raw[o++] = 0xf0;
        raw[o++] = 0xf0;
      }
    }
  }

  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  writeFileSync(path, png);
}

function main() {
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const rand = mulberry32(1337);
  const manifest = [];

  for (let i = 0; i < COUNT; i++) {
    const topic = TOPICS[i % TOPICS.length];
    // Spread across ~3 months so temporal assertions have something to bite on.
    const mtime = new Date(BASE - Math.floor(rand() * 90) * DAY - Math.floor(rand() * DAY));
    const path = join(OUT_DIR, `${String(i).padStart(4, "0")}-${topic.name}.png`);

    // 480x270 ≈ a downscaled lecture slide. Sized so the output lands in the
    // tens of KB, the range real screenshots occupy and above the noise filter's
    // MIN_BYTES floor. At 32x24 these compressed to 1.3 KB and were all rejected.
    writePng(path, 480, 270, [i % 255, (i * 7) % 255, topic.name.length % 255]);
    manifest.push({ file: path.split("/").pop(), topic: topic.name, text: topic.text, keywords: topic.keywords, mtime: mtime.toISOString() });
  }

  // Deliberately bad fixtures the noise filter must reject (P1 DONE conditions).
  // Solid colour but ABOVE the size floor, so it isolates the solid-colour
  // rejection from the too-small rejection. Two separate defects, two fixtures.
  const tiny = join(OUT_DIR, "noise-solid.png");
  writePng(tiny, 480, 270, [7, 7, 7]);
  writeFileSync(join(OUT_DIR, "noise-too-small.bin"), Buffer.alloc(64, 1)); // 64 bytes

  // Exact duplicate of fixture 0000, under a different name.
  writePng(join(OUT_DIR, "noise-duplicate.png"), 480, 270, [0 % 255, (0 * 7) % 255, TOPICS[0].name.length % 255]);

  writeFileSync(
    join(OUT_DIR, "manifest.json"),
    JSON.stringify({ generatedAt: new Date(BASE).toISOString(), count: COUNT, topics: TOPICS, traps: TRAPS, manifest }, null, 2)
  );

  console.log(`wrote ${COUNT + 3} files to ${OUT_DIR}`);
  console.log(`manifest: ${join(OUT_DIR, "manifest.json")}`);
}

main();