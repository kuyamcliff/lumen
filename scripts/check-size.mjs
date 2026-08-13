#!/usr/bin/env node
/**
 * Enforces the size budget from the PRD.
 *
 * "Core" means everything a page downloads just to show a player: the
 * entry chunk plus every chunk it *statically* imports. Lazily-imported
 * chunks (the MKV/FLV remuxers, the DASH engine, the ads plugin) are
 * reported separately, because a page only pays for them if it uses them
 * — which is the whole point of splitting them out.
 */
import { gzipSync } from "node:zlib";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const CORE_BUDGET_KB = 30;

if (!existsSync(join(dist, "lumen.js"))) {
  console.error('Build output not found. Run "npm run build" first.');
  process.exit(1);
}

const gzipKb = (file) => gzipSync(readFileSync(file)).length / 1024;

/** Collects the entry chunk and everything reachable through static imports. */
function collectStaticGraph(entry) {
  const seen = new Set();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    const source = readFileSync(file, "utf8");
    // Static imports always bind through `from "./x.js"`, or are bare
    // side-effect imports. A dynamic `import("./x.js")` matches neither,
    // which is exactly the distinction the budget cares about.
    const patterns = [/\bfrom\s*["'](\.[^"']+)["']/g, /(?:^|[;\n])\s*import\s*["'](\.[^"']+)["']/g];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        queue.push(join(dirname(file), match[1]));
      }
    }
  }
  return seen;
}

const entry = join(dist, "lumen.js");
const core = collectStaticGraph(entry);
const coreKb = [...core].reduce((sum, file) => sum + gzipKb(file), 0);

const allChunks = readdirSync(dist)
  .filter((name) => name.endsWith(".js"))
  .map((name) => join(dist, name));
const lazy = allChunks.filter((file) => !core.has(file) && /-[A-Za-z0-9_-]{8}\.js$/.test(basename(file)));

console.log("Core (entry + static imports):");
for (const file of [...core].sort()) {
  console.log(`  ${basename(file).padEnd(34)} ${gzipKb(file).toFixed(2)} kB gzip`);
}
console.log(`  ${"total".padEnd(34)} ${coreKb.toFixed(2)} kB gzip`);

if (lazy.length > 0) {
  console.log("\nLazy chunks (downloaded only when used):");
  for (const file of lazy.sort()) {
    console.log(`  ${basename(file).padEnd(34)} ${gzipKb(file).toFixed(2)} kB gzip`);
  }
}

console.log(`\nBudget: ${CORE_BUDGET_KB} kB gzip for the core.`);
if (coreKb > CORE_BUDGET_KB) {
  console.error(`\n✗ Over budget by ${(coreKb - CORE_BUDGET_KB).toFixed(2)} kB`);
  process.exit(1);
}
console.log(`✓ Within budget (${(CORE_BUDGET_KB - coreKb).toFixed(2)} kB to spare)`);
