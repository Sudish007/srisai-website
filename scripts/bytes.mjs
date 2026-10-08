#!/usr/bin/env node
// scripts/bytes.mjs — byte accounting for the shipped files (raw + gzip level 6, like GitHub Pages).
// Plain Node, no dependencies. Run from the repo root: `node scripts/bytes.mjs`.
// The BASELINE column is the pre-v2 measurement recorded in .agents/tasks/spec-v2.md §0.

import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';

const root = process.cwd();
const FILES = ['index.html', 'styles.css', 'app.js', 'i18n.js', 'ui.js', 'content-i18n.js', 'sw.js', 'manifest.webmanifest', 'icon.svg'];
const BASELINE = { // spec §0 (before this task); content-i18n.js and later files did not exist
  'index.html': [20949, 4587], 'styles.css': [61045, 12202], 'app.js': [123941, 33427], 'i18n.js': [72069, 14152], 'ui.js': [8747, 3000],
};
const BASELINE_TOTAL = [286751, 67368];

const gz = (buf) => gzipSync(buf, { level: 6 }).length;
const fmt = (n) => n.toLocaleString('en-US').padStart(8);
const row = (name, raw, g, base) => {
  const b = base ? `${fmt(base[0])} ${fmt(base[1])}` : `${''.padStart(8)} ${''.padStart(8)}`;
  console.log(`${name.padEnd(22)}${fmt(raw)} ${fmt(g)}   ${b}`);
};

console.log(`${'file'.padEnd(22)}${'raw'.padStart(8)} ${'gzip'.padStart(8)}   ${'base raw'.padStart(8)} ${'base gz'.padStart(8)}`);
let tr = 0, tg = 0;
for (const f of FILES) {
  const p = resolve(root, f);
  if (!existsSync(p)) { console.log(`${f.padEnd(22)}  (missing)`); continue; }
  const buf = readFileSync(p);
  const g = gz(buf);
  tr += buf.length; tg += g;
  row(f, buf.length, g, BASELINE[f]);
}
row('TOTAL', tr, tg, BASELINE_TOTAL);

const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const crit = html.match(/<style id="critical">([\s\S]*?)<\/style>/)?.[1] ?? '';
console.log('');
row('inline critical CSS', Buffer.byteLength(crit, 'utf8'), gz(Buffer.from(crit, 'utf8')));
const blocking = (html.replace(/<noscript>[\s\S]*?<\/noscript>/g, '').match(/<link[^>]*rel="stylesheet"[^>]*>/g) ?? []).filter((l) => !/media="print"/.test(l));
console.log(`render-blocking external stylesheets: ${blocking.length}${blocking.length ? '\n  ' + blocking.join('\n  ') : ''}`);
