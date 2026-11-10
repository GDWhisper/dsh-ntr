import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const CAP = 1000;
const SCAN_DIRS = ['src', 'tests', 'presets'];
const EXTS = new Set(['.ts', '.tsx', '.mjs']);
const baseline = JSON.parse(readFileSync(join(root, 'scripts', 'file-size-baseline.json'), 'utf8'));

function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (EXTS.has(extname(ent.name))) yield p;
  }
}

function lineCount(text) {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

const errors = [];
const warnings = [];
const seen = new Set();
let scanned = 0;

for (const dir of SCAN_DIRS) {
  const abs = join(root, dir);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const rel = relative(root, file).split('\\').join('/');
    seen.add(rel);
    scanned++;
    const lines = lineCount(readFileSync(file, 'utf8'));
    const locked = baseline[rel];
    if (locked === undefined) {
      if (lines > CAP) errors.push(`${rel}: ${lines} 行，新文件上限 ${CAP} 行——拆分，不许进基线`);
    } else if (lines > locked) {
      errors.push(`${rel}: ${lines} 行，基线锁定 ${locked} 行——只许缩不许长`);
    } else if (lines <= CAP) {
      warnings.push(`${rel}: 已降到 ${lines} 行（≤${CAP}），从基线删除该条目`);
    }
  }
}
for (const rel of Object.keys(baseline)) {
  if (!seen.has(rel)) warnings.push(`${rel}: 文件已不存在，从基线删除该条目`);
}

for (const w of warnings) console.warn(`[size] 提醒：${w}`);
if (errors.length > 0) {
  for (const e of errors) console.error(`[size] 超限：${e}`);
  process.exit(1);
}
console.log(`[size] 通过：扫描 ${scanned} 个文件，上限 ${CAP} 行，基线锁定 ${Object.keys(baseline).length} 个存量文件。`);