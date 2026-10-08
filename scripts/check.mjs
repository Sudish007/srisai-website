#!/usr/bin/env node
// scripts/check.mjs — static verification for the Sri Sai Hospital site (spec E1).
// Plain Node, no dependencies. Run from the repo root: `node scripts/check.mjs`.
// Prints PASS/FAIL per check and exits 1 if any check fails.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (f) => readFileSync(resolve(root, f), 'utf8');
let failures = 0;

function report(name, problems) {
  if (problems.length === 0) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}`);
    problems.slice(0, 40).forEach((p) => console.log(`      - ${p}`));
    if (problems.length > 40) console.log(`      … and ${problems.length - 40} more`);
  }
}

// 1. required files
const REQUIRED = ['index.html', 'styles.css', 'app.js', 'i18n.js', 'ui.js', 'content-i18n.js', 'privacy.html', 'terms.html', '.gitignore'];
{
  const problems = REQUIRED.filter((f) => !existsSync(resolve(root, f))).map((f) => `missing ${f}`);
  if (existsSync(resolve(root, '.gitignore')) && !/^\.agents\/?\s*$/m.test(read('.gitignore'))) problems.push('.gitignore does not contain `.agents/`');
  report('1 required files + .gitignore has .agents/', problems);
}

// 2. i18n dictionary parity
let dict = null;
{
  const problems = [];
  try {
    const mod = await import(pathToFileURL(resolve(root, 'i18n.js')).href);
    dict = mod.dict;
    if (!dict?.en || !dict?.hi || !dict?.bho) problems.push('dict.en / dict.hi / dict.bho missing');
  } catch (e) {
    problems.push(`import failed: ${e.message}`);
  }
  if (dict?.en && dict?.hi && dict?.bho) {
    const langs = ['en', 'hi', 'bho'];
    const keys = Object.fromEntries(langs.map((l) => [l, new Set(Object.keys(dict[l]))]));
    for (const l of ['hi', 'bho']) {
      for (const k of keys.en) if (!keys[l].has(k)) problems.push(`${l} missing key ${k}`);
      for (const k of keys[l]) if (!keys.en.has(k)) problems.push(`${l} has extra key ${k}`);
    }
    const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    const ALLOW_SAME = new Set(['shop.rx', 'shop.mrp', 'checkout.upi', 'checkout.upiSub', 'orders.method.upi', 'auth.emailPlaceholder', 'footer.rights']);
    const DEVA = /[\u0900-\u097F]/;
    for (const k of keys.en) {
      for (const l of langs) {
        const v = dict[l][k];
        if (v === undefined) continue;
        if (typeof v !== 'string' || v.trim() === '') problems.push(`${l}.${k} is empty`);
      }
      if (keys.hi.has(k) && vars(dict.hi[k]) !== vars(dict.en[k])) problems.push(`placeholder mismatch en/hi for ${k}`);
      if (keys.bho.has(k) && vars(dict.bho[k]) !== vars(dict.en[k])) problems.push(`placeholder mismatch en/bho for ${k}`);
      if (!k.startsWith('lang.') && !ALLOW_SAME.has(k)) {
        for (const l of ['hi', 'bho']) {
          const v = dict[l][k];
          if (typeof v === 'string' && !DEVA.test(v)) problems.push(`${l}.${k} has no Devanagari: "${v}"`);
        }
      }
    }
    console.log(`      en=${keys.en.size} hi=${keys.hi.size} bho=${keys.bho.size} keys`);
  }
  report('2 i18n.js imports in Node; en/hi/bho key sets, {var} sets, non-empty, Devanagari', problems);
}

// 3. every data-i18n* key in index.html and t('…') key in app.js/ui.js exists in dict.en
{
  const problems = [];
  if (dict?.en) {
    const html = read('index.html');
    for (const m of html.matchAll(/data-i18n(?:-placeholder|-aria|-title)?="([^"]+)"/g)) {
      if (!(m[1] in dict.en)) problems.push(`index.html uses unknown key ${m[1]}`);
    }
    for (const f of ['app.js', 'ui.js']) {
      const src = read(f);
      for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) {
        if (!(m[1] in dict.en)) problems.push(`${f} uses unknown key ${m[1]}`);
      }
    }
  } else problems.push('dict unavailable (see check 2)');
  report('3 data-i18n*/t() keys exist in dict.en', problems);
}

// 4. no leading-slash URLs
{
  const problems = [];
  for (const f of ['index.html', 'privacy.html', 'terms.html', 'styles.css', 'app.js', 'ui.js', 'content-i18n.js']) {
    const src = read(f);
    src.split('\n').forEach((line, i) => {
      if (/(href|src)=["']\/[^/]/.test(line)) problems.push(`${f}:${i + 1} leading-slash href/src`);
      if (/url\(\s*["']?\/[^/]/.test(line)) problems.push(`${f}:${i + 1} leading-slash url()`);
    });
  }
  report('4 no leading-slash URLs', problems);
}

// 5. index.html structure
{
  const problems = [];
  const html = read('index.html');
  if (!/<html lang="en">/.test(html)) problems.push('missing <html lang="en">');
  if (!/<meta name="viewport"/.test(html)) problems.push('missing viewport meta');
  const scripts = html.match(/<script type="module" src="app\.js"><\/script>/g) ?? [];
  if (scripts.length !== 1) problems.push(`expected exactly one module script for app.js, found ${scripts.length}`);
  const footer = html.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? '';
  if (!/href="privacy\.html"/.test(footer)) problems.push('footer lacks href="privacy.html"');
  if (!/href="terms\.html"/.test(footer)) problems.push('footer lacks href="terms.html"');
  const segs = [...html.matchAll(/<div class="seg seg-lang[^"]*"[^>]*>([\s\S]*?)<\/div>/g)];
  if (segs.length < 2) problems.push(`expected ≥2 .seg-lang instances, found ${segs.length}`);
  segs.forEach((s, i) => {
    const langs = [...s[1].matchAll(/class="seg-btn"[^>]*data-lang="(en|hi|bho)"/g)].map((m) => m[1]).sort().join(',');
    if (langs !== 'bho,en,hi') problems.push(`.seg-lang #${i + 1} buttons are [${langs}], expected en/hi/bho`);
  });
  const bb = (html.match(/<nav class="bottombar"[\s\S]*?<\/nav>/)?.[0] ?? '').match(/class="bb-item"/g) ?? [];
  if (bb.length !== 5) problems.push(`bottombar should have 5 .bb-item, found ${bb.length}`);
  report('5 index.html structure (lang, viewport, one module script, footer legal links, seg-lang ×≥2, bottombar ×5)', problems);
}

// 6. no alert/confirm/prompt in JS (ui.confirm({...}) is allowed)
{
  const problems = [];
  for (const f of ['app.js', 'ui.js', 'i18n.js', 'content-i18n.js']) {
    const src = read(f);
    src.split('\n').forEach((line, i) => {
      if (/\balert\s*\(/.test(line)) problems.push(`${f}:${i + 1} alert(`);
      if (/\bprompt\s*\(/.test(line)) problems.push(`${f}:${i + 1} prompt(`);
      if (/\bconfirm\s*\((?!\s*\{)/.test(line)) problems.push(`${f}:${i + 1} confirm( (use ui.confirm({…}))`);
    });
  }
  report('6 no alert()/confirm()/prompt() in JS', problems);
}

// 7. node --check
{
  const problems = [];
  for (const f of ['app.js', 'ui.js', 'i18n.js', 'content-i18n.js']) {
    try { execFileSync(process.execPath, ['--check', resolve(root, f)], { stdio: 'pipe' }); }
    catch (e) { problems.push(`${f}: ${String(e.stderr || e.message).trim().split('\n')[0]}`); }
  }
  report('7 node --check app.js ui.js i18n.js content-i18n.js', problems);
}

// 8. privacy/terms headings intact
{
  const problems = [];
  const expect = { 'privacy.html': ['Privacy Policy', 10], 'terms.html': ['Terms of Service', 12] };
  for (const [f, [h1, h2n]] of Object.entries(expect)) {
    const src = read(f);
    if (!new RegExp(`<h1[^>]*>\\s*${h1}\\s*</h1>`).test(src)) problems.push(`${f}: <h1>${h1}</h1> missing`);
    const n = (src.match(/<h2[\s>]/g) ?? []).length;
    if (n !== h2n) problems.push(`${f}: expected ${h2n} <h2>, found ${n}`);
    if (!/<link rel="stylesheet" href="styles\.css">/.test(src)) problems.push(`${f}: does not link styles.css`);
  }
  report('8 privacy/terms h1 text + h2 counts (10/12) + styles.css link', problems);
}

// 9. content-i18n.js dictionary (admin-content translations) + tc() behaviour
{
  const problems = [];
  const DEVA = /[\u0900-\u097F]/;
  const slots = (s) => [...String(s).matchAll(/\{(\d)\}/g)].map((m) => m[1]).sort().join(',');
  try {
    const { DICT, TEMPLATES, tc } = await import(pathToFileURL(resolve(root, 'content-i18n.js')).href);
    const entries = Object.entries(DICT ?? {});
    if (entries.length < 50) problems.push(`DICT has ${entries.length} entries, expected ≥ 50`);
    for (const [k, v] of entries) {
      for (const l of ['hi', 'bho']) {
        const s = v?.[l];
        if (typeof s !== 'string' || s.trim() === '') problems.push(`DICT["${k}"].${l} is empty`);
        else if (!DEVA.test(s)) problems.push(`DICT["${k}"].${l} has no Devanagari: "${s}"`);
      }
    }
    if (!Array.isArray(TEMPLATES)) problems.push('TEMPLATES is not an array');
    (TEMPLATES ?? []).forEach((tpl, i) => {
      if (!(tpl.re instanceof RegExp)) problems.push(`TEMPLATES[${i}].re is not a RegExp`);
      for (const l of ['hi', 'bho']) {
        if (typeof tpl[l] !== 'string' || !DEVA.test(tpl[l])) problems.push(`TEMPLATES[${i}].${l} missing or no Devanagari`);
      }
      if (slots(tpl.hi) !== slots(tpl.bho)) problems.push(`TEMPLATES[${i}] {n} sets differ between hi and bho`);
    });
    // behavioural
    for (const l of ['hi', 'bho']) if (!DEVA.test(tc('Gynaecology', l))) problems.push(`tc('Gynaecology','${l}') is not Devanagari`);
    if (tc('Dr. Sarita Singh', 'hi') !== 'Dr. Sarita Singh') problems.push('tc() altered a doctor name');
    const t1 = tc('Medical Officer , Govt. of Bihar', 'hi');
    const t2 = tc('Medical Officer,  Govt. of Bihar', 'hi');
    if (t1 !== t2 || !DEVA.test(t1)) problems.push(`doctor title variants differ or not Devanagari: "${t1}" / "${t2}"`);
    const fd = tc('Free delivery above ₹999 · Classical formulations', 'bho');
    if (!fd.includes('₹999') || !DEVA.test(fd) || /Classical/.test(fd)) problems.push(`template 'Free delivery' failed: "${fd}"`);
    const up = tc('Up to 30% off Churna & Powders', 'hi');
    if (!up.includes('30%') || !up.includes('चूर्ण')) problems.push(`template 'Up to % off' failed: "${up}"`);
    if (tc('anything', 'en') !== 'anything') problems.push("tc('anything','en') changed the input");
    console.log(`      content entries=${entries.length} templates=${(TEMPLATES ?? []).length}`);
  } catch (e) {
    problems.push(`import failed: ${e.message}`);
  }
  report('9 content-i18n.js: ≥50 DICT entries with hi+bho Devanagari, TEMPLATES shape, tc() behaviour', problems);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
