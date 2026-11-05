// Syntax check all JS sources (no deps).
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['server', 'tests', 'scripts'];
const files = [];
function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.js') || f.endsWith('.mjs')) files.push(p);
  }
}
for (const r of roots) {
  try { walk(r); } catch { /* dir may not exist */ }
}
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed += 1;
    console.error(`SYNTAX FAIL: ${f}\n${e.stderr?.toString() || e.message}`);
  }
}
console.log(`checked ${files.length} files, ${failed} failures`);
process.exit(failed ? 1 : 0);
