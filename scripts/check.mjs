#!/usr/bin/env node
/**
 * Zero-dependency repository health & regression gate for dsh-workflow-canvas.
 * Run via `npm run check` (also executed in GitHub Actions CI).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const ok = [];

function pass(msg) {
  ok.push(msg);
  console.log(`  ✔ ${msg}`);
}

function fail(msg) {
  errors.push(msg);
  console.error(`  ✘ ${msg}`);
}

function readUtf8(relPath) {
  return readFileSync(path.join(ROOT, relPath), 'utf8');
}

function flattenKeys(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenKeys(v, full));
    } else {
      out.push(full);
    }
  }
  return out.sort();
}

function stripBalancedBlock(src, markerRegex) {
  const m = markerRegex.exec(src);
  if (!m) return null;
  const openIdx = src.indexOf('{', m.index);
  if (openIdx < 0) return null;
  let depth = 0;
  let quote = null;
  let escape = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(0, m.index) + src.slice(i + 1);
      }
    }
  }
  return null;
}

function loadClientTestExports(clientSrc) {
  let loaded = null;
  const sandbox = {
    window: {
      __ModuleLoader__: { load(mod) { loaded = mod; } },
      localStorage: { getItem: () => null, setItem: () => {} },
    },
    console, Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean,
    RegExp, Infinity, encodeURIComponent, decodeURIComponent,
  };
  vm.runInNewContext(clientSrc, sandbox);
  if (!loaded || typeof loaded.factory !== 'function') {
    throw new Error('client.js failed to register via __ModuleLoader__.load');
  }
  const mod = loaded.factory((name) => {
    if (name === 'react') {
      return {
        createElement: () => null,
        useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
        useRef: (v) => ({ current: v }),
        useEffect: () => {},
        Component: class {},
        Fragment: Symbol('Fragment'),
      };
    }
    throw new Error('unexpected require: ' + name);
  });
  return { loaded, exports: mod.__test };
}

console.log('Running dsh-workflow-canvas repository checks...\n');

// 1. JS Syntax Checks
for (const file of ['index.js', 'client.js']) {
  const res = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { encoding: 'utf8' });
  if (res.status === 0) pass(`Syntax OK: ${file}`);
  else fail(`Syntax error in ${file}: ${(res.stderr || res.stdout || '').trim()}`);
}

// 2. JSON Validity & Locale Manifest Parity
let pkg = null;
try {
  pkg = JSON.parse(readUtf8('package.json'));
  pass(`Valid JSON: package.json (v${pkg.version})`);
} catch (err) {
  fail(`Invalid package.json: ${err.message}`);
}

let zhLocale = null;
let enLocale = null;
try {
  zhLocale = JSON.parse(readUtf8('locale/zh.json'));
  enLocale = JSON.parse(readUtf8('locale/en.json'));
  const zhKeys = flattenKeys(zhLocale);
  const enKeys = flattenKeys(enLocale);
  if (JSON.stringify(zhKeys) === JSON.stringify(enKeys)) {
    pass(`Locale manifest parity OK (${zhKeys.length} keys)`);
  } else {
    fail(`locale/zh.json vs locale/en.json key mismatch: zh=[${zhKeys}] en=[${enKeys}]`);
  }
  for (const [lang, loc] of [['zh', zhLocale], ['en', enLocale]]) {
    const detailPath = loc && loc.meta && loc.meta.detail;
    if (detailPath && !existsSync(path.join(ROOT, detailPath))) {
      fail(`locale/${lang}.json meta.detail missing on disk: ${detailPath}`);
    }
  }
} catch (err) {
  fail(`Locale JSON error: ${err.message}`);
}

// 3 & 4. client.js I18N Parity, Zero Unused I18N Keys, Zero Unused S.* Style Keys
const clientSrc = readUtf8('client.js');
try {
  const { loaded, exports: clientTest } = loadClientTestExports(clientSrc);
  if (pkg && loaded.id !== pkg.name) {
    fail(`client.js module id "${loaded.id}" !== package.json name "${pkg.name}"`);
  }
  const { I18N, S } = clientTest;
  const zhKeys = Object.keys(I18N.zh).sort();
  const enKeys = Object.keys(I18N.en).sort();
  const onlyZh = zhKeys.filter((k) => !Object.prototype.hasOwnProperty.call(I18N.en, k));
  const onlyEn = enKeys.filter((k) => !Object.prototype.hasOwnProperty.call(I18N.zh, k));
  const typeMismatches = zhKeys.filter(
    (k) => Object.prototype.hasOwnProperty.call(I18N.en, k) && typeof I18N.zh[k] !== typeof I18N.en[k]
  );
  if (!onlyZh.length && !onlyEn.length && !typeMismatches.length) {
    pass(`client.js I18N zh/en parity OK (${zhKeys.length} keys)`);
  } else {
    if (onlyZh.length) fail(`I18N keys missing in en: ${onlyZh.join(', ')}`);
    if (onlyEn.length) fail(`I18N keys missing in zh: ${onlyEn.join(', ')}`);
    if (typeMismatches.length) fail(`I18N zh/en value type mismatch: ${typeMismatches.join(', ')}`);
  }

  const withoutI18N = stripBalancedBlock(clientSrc, /\bconst I18N\s*=\s*\{/);
  if (!withoutI18N) {
    fail('Could not locate const I18N block in client.js');
  } else {
    const unusedI18N = zhKeys.filter((k) => {
      const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return !new RegExp(`['"]${escaped}['"]`).test(withoutI18N);
    });
    if (!unusedI18N.length) pass(`Zero unused I18N keys (${zhKeys.length} checked)`);
    else fail(`Unused I18N keys in client.js: ${unusedI18N.join(', ')}`);
  }

  const styleKeys = Object.keys(S);
  const withoutS = stripBalancedBlock(clientSrc, /\bconst S\s*=\s*\{/);
  if (!withoutS) {
    fail('Could not locate const S block in client.js');
  } else {
    const unusedStyles = styleKeys.filter((k) => {
      const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return !new RegExp(`\\bS(?:\\.${escaped}\\b|\\[['"]${escaped}['"]\\])`).test(withoutS);
    });
    if (!unusedStyles.length) pass(`Zero unused S.* style keys (${styleKeys.length} checked)`);
    else fail(`Unused S.* style keys in client.js: ${unusedStyles.join(', ')}`);
  }
} catch (err) {
  fail(`client.js vm check failed: ${err.message}`);
}

// 5. Local Markdown Links & Image Paths
const mdFiles = [
  'README.md',
  'README.zh.md',
  'skills/workflow-canvas/SKILL.md',
  ...readdirSync(path.join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
];
let checkedLinks = 0;
const brokenLinks = [];
for (const relMd of mdFiles) {
  const content = readUtf8(relMd);
  const baseDir = path.dirname(path.join(ROOT, relMd));
  const targets = [];
  for (const m of content.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    targets.push(m[1]);
  }
  for (const m of content.matchAll(/\bsrc=["']([^"']+)["']/g)) {
    targets.push(m[1]);
  }
  for (const raw of targets) {
    if (/^(?:https?:|mailto:|file:|data:|#)/i.test(raw)) continue;
    const clean = raw.split('#')[0].split('?')[0];
    if (!clean) continue;
    checkedLinks++;
    const resolved = path.resolve(baseDir, clean);
    if (!existsSync(resolved)) {
      brokenLinks.push(`${relMd} -> ${raw}`);
    }
  }
}
if (!brokenLinks.length) pass(`Local markdown links OK (${checkedLinks} links across ${mdFiles.length} docs)`);
else fail(`Broken local doc links:\n    - ${brokenLinks.join('\n    - ')}`);

// 6. Host Backward-Compatibility Guard
if (pkg) {
  const inject = (pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject) || [];
  const riskyInject = inject.filter((id) => /session|subagent|command/i.test(id));
  if (!riskyInject.length) {
    pass(`dsh.client.inject backward-compatible (${inject.length} baseline entries)`);
  } else {
    fail(`Risky hard inject entries (resolve optional ctx.remote lazily instead): ${riskyInject.join(', ')}`);
  }
}

// 7. npm Tarball Size & Hygiene Gate
const packRes = spawnSync('npm pack --dry-run --json', {
  cwd: ROOT,
  shell: true,
  encoding: 'utf8',
});
if (packRes.status !== 0) {
  fail(`npm pack --dry-run failed: ${(packRes.stderr || packRes.stdout || '').trim()}`);
} else {
  try {
    const parsed = JSON.parse(packRes.stdout);
    const info = Array.isArray(parsed) ? parsed[0] : parsed;
    const packedPaths = (info.files || []).map((f) => f.path);
    const forbidden = packedPaths.filter((p) =>
      p.startsWith('docs/images/') ||
      p.startsWith('.agents/') ||
      p.startsWith('scripts/') ||
      p.startsWith('test/') ||
      p.startsWith('.dsh/') ||
      p.startsWith('promo/') ||
      p === 'AGENTS.md'
    );
    const required = [
      'index.js',
      'client.js',
      'cordis.patch.yml',
      'package.json',
      'icon.svg',
      'locale/zh.json',
      'locale/en.json',
      'docs/DETAIL.md',
      'skills/workflow-canvas/SKILL.md',
    ];
    const missingReq = required.filter((r) => !packedPaths.includes(r));
    const MAX_TARBALL_BYTES = 512 * 1024;
    const MAX_UNPACKED_BYTES = 1536 * 1024;
    if (forbidden.length) fail(`Forbidden files in npm tarball: ${forbidden.join(', ')}`);
    if (missingReq.length) fail(`Missing required files in npm tarball: ${missingReq.join(', ')}`);
    if (info.size > MAX_TARBALL_BYTES) {
      fail(`npm tarball too large: ${(info.size / 1024).toFixed(1)} KB > ${MAX_TARBALL_BYTES / 1024} KB`);
    }
    if (info.unpackedSize > MAX_UNPACKED_BYTES) {
      fail(`npm unpackedSize too large: ${(info.unpackedSize / 1024).toFixed(1)} KB > ${MAX_UNPACKED_BYTES / 1024} KB`);
    }
    if (!forbidden.length && !missingReq.length && info.size <= MAX_TARBALL_BYTES && info.unpackedSize <= MAX_UNPACKED_BYTES) {
      pass(
        `npm tarball hygiene & budget OK (${packedPaths.length} files, ` +
        `${(info.size / 1024).toFixed(1)} KB packed / ${(info.unpackedSize / 1024).toFixed(1)} KB unpacked)`
      );
    }
  } catch (err) {
    fail(`Could not parse npm pack --dry-run --json output: ${err.message}`);
  }
}

console.log('');
if (errors.length) {
  console.error(`FAILED: ${errors.length} check(s) failed (${ok.length} passed).`);
  process.exit(1);
}
console.log(`ALL CHECKS PASSED (${ok.length}/${ok.length}).`);
