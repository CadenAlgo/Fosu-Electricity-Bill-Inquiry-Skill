#!/usr/bin/env node
/**
 * Build/refresh the room catalog (building -> floor -> room -> dropdown codes).
 *
 *   node scripts/catalog.mjs [--out data/rooms.json] [--conc 6] [--summary]
 *
 * The site only exposes cascading dropdowns, so a full catalog costs roughly
 * one request per floor. It changes rarely, so build it once and reuse it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog } from './lib/catalog.mjs';
import { DEFAULT_BASE } from './lib/site.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = { out: path.join(ROOT, 'data', 'rooms.json'), conc: 6, summary: false, base: DEFAULT_BASE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--conc') out.conc = Number(argv[++i]);
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--summary') out.summary = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('usage: node scripts/catalog.mjs [--out data/rooms.json] [--conc 6] [--base URL] [--summary]');
  process.exit(0);
}

const t0 = Date.now();
let lastLine = '';
const catalog = await buildCatalog({
  base: args.base,
  concurrency: args.conc,
  onProgress: (p) => {
    const line = `  ${p.done}/${p.total}  ${p.building}${p.error ? '  FAILED: ' + p.error : ''}`;
    if (line !== lastLine && process.stderr.isTTY) {
      lastLine = line;
      process.stderr.write(`\r${line.padEnd(64)}`);
    }
  },
});
if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(64) + '\r');

fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(catalog, null, 1));

const failed = catalog.buildings.filter((b) => b.error);
console.log(`catalog: ${catalog.counts.buildings} buildings, ${catalog.counts.floors} floors, ${catalog.counts.rooms} rooms in ${Date.now() - t0}ms`);
console.log(`written: ${args.out}`);
if (failed.length) console.log(`WARNING: ${failed.length} building(s) failed: ${failed.map((b) => b.label).join(', ')}`);

if (args.summary) {
  for (const b of catalog.buildings) {
    const rooms = b.floors[0]?.rooms ?? [];
    const sample = rooms.slice(0, 3).map((r) => `${r.label}=${r.value}`).join(' ');
    const last = rooms.at(-1);
    console.log(
      `${b.label.padEnd(5)} code=${b.value} floors=${String(b.floors.length).padStart(2)} ` +
        `[${b.floors.map((f) => f.label).join(', ')}]`
    );
    console.log(`      rooms(${rooms.length}): ${sample} ... ${last ? `${last.label}=${last.value}` : ''}`);
  }
}
