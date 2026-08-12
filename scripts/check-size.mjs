#!/usr/bin/env node
// Enforces the size budgets from the PRD: core player (no streaming engine)
// should stay at or under ~30 kB gzipped. Run after `npm run build`.
import { gzipSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CORE_BUDGET_KB = 30;

const target = join(root, "dist/lumen.js");
if (!existsSync(target)) {
  console.error(`Build output not found at ${target}. Run "npm run build" first.`);
  process.exit(1);
}

const code = readFileSync(target);
const gzipKb = gzipSync(code).length / 1024;

console.log(`dist/lumen.js: ${(code.length / 1024).toFixed(1)} kB raw, ${gzipKb.toFixed(2)} kB gzip`);
console.log(`Budget: ${CORE_BUDGET_KB} kB gzip (core, hls.js excluded — it's an external/optional dependency)`);

if (gzipKb > CORE_BUDGET_KB) {
  console.error(`\n✗ Over budget by ${(gzipKb - CORE_BUDGET_KB).toFixed(2)} kB`);
  process.exit(1);
}
console.log(`\n✓ Within budget (${(CORE_BUDGET_KB - gzipKb).toFixed(2)} kB to spare)`);
