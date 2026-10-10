#!/usr/bin/env node
/**
 * docs:audit — detect stale or missing documentation.
 *
 * The problem this solves: a description document silently drifts from the code
 * it describes. Markers alone ("STUB") cannot detect that, because a document
 * written once and never touched still says "current" while the code underneath
 * has moved three times.
 *
 * So each description doc records the content hash of the code it described.
 * When src/ changes and the hash no longer matches, the doc is STALE by
 * evidence rather than by opinion.
 *
 * Exit codes: 0 = clean, 1 = problems found.
 *
 * Usage:
 *   node scripts/docs-audit.mjs            # report
 *   node scripts/docs-audit.mjs --write    # refresh hashes for docs marked current
 *   node scripts/docs-audit.mjs --json     # machine-readable
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");
const DOCS = join(ROOT, "docs");

/** Files that describe code. Anything non-doc, non-ignored counts. */
const CODE_GLOBS = ["src/**/*"];

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const JSON_OUT = args.includes("--json");

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

/** Stable hash of the code tree: sorted relpath + file content. */
function codeFingerprint() {
  const files = walk(SRC).sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(relative(ROOT, f).split(sep).join("/"));
    h.update(readFileSync(f));
  }
  return { hash: h.digest("hex"), fileCount: files.length };
}

function readMarker(path) {
  const text = readFileSync(path, "utf8");
  const stubOpen = text.match(/<!--\s*STUB:status=([a-z-]+)\s*-->/);
  const docOpen = text.match(/<!--\s*DOC:status=([a-z-]+)\s*-->/);
  const open = stubOpen ? ["STUB", stubOpen[1]] : docOpen ? ["DOC", docOpen[1]] : null;
  return {
    open,
    closed: /<!--\s*\/STUB\s*-->/.test(text),
    hashClaim: text.match(/<!--\s*code-hash:\s*([a-f0-9]{64})\s*-->/),
    text,
  };
}

/** A description doc claiming "current" must be wrapped in markers and hashed. */
function audit() {
  const fp = codeFingerprint();
  const files = existsSync(DOCS) ? readdirSync(DOCS).filter((f) => f.endsWith(".md")) : [];
  const findings = [];
  const docs = [];

  for (const name of files.sort()) {
    const path = join(DOCS, name);
    if (name === "README.md") continue; // index, exempt

    const m = readMarker(path);

    // Strip markers before checking for prose, so the stub banner text
    // does not count as content.
    const body = m.text
      .replace(/<!--[^>]*-->/g, "")
      .replace(/^>.*$/gm, "")
      .trim();
    const hasRealProse = body.replace(/[#\-*`|>\s]/g, "").length > 200;

    if (!m.open) {
      findings.push({
        doc: `docs/${name}`,
        level: "error",
        msg: "no status marker. Add <!-- STUB:status=not-written --> or <!-- DOC:status=current -->.",
      });
      continue;
    }

    const [kind, status] = m.open;

    if (kind === "STUB") {
      if (status !== "not-written") {
        findings.push({
          doc: `docs/${name}`,
          level: "warn",
          msg: `STUB marker has status "${status}"; expected "not-written".`,
        });
      }
      if (!m.closed) {
        findings.push({
          doc: `docs/${name}`,
          level: "warn",
          msg: "STUB is not closed with <!-- /STUB -->.",
        });
      }
      docs.push({ doc: `docs/${name}`, status: "STUB", codeHashMatch: "n/a" });
      continue;
    }

    // DOC:status=current
    docs.push({ doc: `docs/${name}`, status: "CURRENT", codeHashMatch: "unknown" });

    if (!m.closed) {
      findings.push({
        doc: `docs/${name}`,
        level: "error",
        msg: "claims DOC:status=current but still contains a <!-- /STUB --> close marker.",
      });
    }
    if (!m.hashClaim) {
      findings.push({
        doc: `docs/${name}`,
        level: "warn",
        msg: "claims current but records no code-hash. Run with --write after verifying it against the code.",
      });
    } else if (m.hashClaim[1] !== fp.hash) {
      findings.push({
        doc: `docs/${name}`,
        level: "error",
        msg: `STALE: describes code hash ${m.hashClaim[1].slice(0, 12)}…, code is now ${fp.hash.slice(0, 12)}…. Re-read the code and update, then --write.`,
      });
    } else {
      docs[docs.length - 1].codeHashMatch = "match";
    }

    if (!hasRealProse) {
      findings.push({
        doc: `docs/${name}`,
        level: "error",
        msg: "claims current but has almost no content.",
      });
    }
  }

  // Required docs must exist.
  for (const required of ["runbook.md", "architecture.md"]) {
    if (!files.includes(required)) {
      findings.push({ doc: `docs/${required}`, level: "error", msg: "required doc is missing." });
    }
  }

  return { fingerprint: fp, docs, findings };
}

function refreshHashes() {
  const fp = codeFingerprint();
  const files = existsSync(DOCS) ? readdirSync(DOCS).filter((f) => f.endsWith(".md")) : [];
  const updated = [];
  for (const name of files) {
    const path = join(DOCS, name);
    if (name === "README.md") continue;
    const text = readFileSync(path, "utf8");
    if (!/<!--\s*DOC:status=current\s*-->/.test(text)) continue;
    const claim = text.match(/<!--\s*code-hash:\s*[a-f0-9]{64}\s*-->/);
    const marker = `<!-- code-hash: ${fp.hash} -->`;
    if (claim) {
      writeFileSync(path, text.replace(claim[0], marker));
      updated.push(name);
    } else {
      writeFileSync(path, text.replace(/<!--\s*DOC:status=current\s*-->/, `<!-- DOC:status=current -->\n${marker}`));
      updated.push(name);
    }
  }
  return { fingerprint: fp, updated };
}

if (WRITE) {
  const { fingerprint, updated } = refreshHashes();
  if (JSON_OUT) {
    console.log(JSON.stringify({ mode: "write", fingerprint, updated }, null, 2));
  } else {
    console.log(`Code fingerprint: ${fingerprint.hash.slice(0, 16)}… (${fingerprint.fileCount} files)`);
    if (updated.length === 0) {
      console.log("No docs marked current — nothing to refresh.");
    } else {
      for (const n of updated) console.log(`refreshed hash: docs/${n}`);
      console.log("\nNote: --write marks docs as matching the code. It does NOT verify");
      console.log("      they are accurate. Read the code first.");
    }
  }
  process.exit(0);
}

const { fingerprint, docs, findings } = audit();

if (JSON_OUT) {
  console.log(JSON.stringify({ fingerprint, docs, findings }, null, 2));
} else {
  console.log(`Code fingerprint: ${fingerprint.hash.slice(0, 16)}… (${fingerprint.fileCount} files in src/)\n`);
  for (const d of docs) console.log(`  ${d.status.padEnd(8)} docs/${d.doc.replace("docs/", "")}  [${d.codeHashMatch}]`);
  console.log("");
  if (findings.length === 0) {
    console.log("docs OK — no stale or malformed documentation.");
  } else {
    for (const f of findings) {
      const tag = f.level === "error" ? "ERROR" : "WARN ";
      console.log(`${tag} ${f.doc}\n      ${f.msg}`);
    }
    console.log(`\n${findings.length} finding(s).`);
  }
}

process.exit(findings.some((f) => f.level === "error") ? 1 : 0);