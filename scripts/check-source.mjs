import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { REPO } from '../src/config.mjs';

const forbiddenName = /^(?:credentials\.json|\.credentials\.json.*|account-emails\.json|usage_history\.jsonl|\.env(?:\..*)?|AGENTS\.md|status\.json|.*\.state\.json)$/i;
const patterns = [
  ['OAuth/API token', /sk-ant-(?:oat01|ort01|api03)-[A-Za-z0-9_-]{12,}/],
  ['Google API key', /AIza[A-Za-z0-9_-]{30,}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{25,}/],
  ['personal Windows home', /C:[\\/]+Users[\\/]+jooye/i],
  ['personal email', /[A-Za-z0-9._%+-]+@(?:gmail|naver|hotmail)\.com/i]
];
let failed = false, files = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'coverage'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(file); continue; }
    files++;
    if (forbiddenName.test(entry.name)) { console.error(`Forbidden runtime file: ${path.relative(REPO, file)}`); failed = true; }
    const text = fs.readFileSync(file, 'utf8');
    for (const [label, regex] of patterns) if (regex.test(text)) {
      console.error(`${label} in ${path.relative(REPO, file)} (value withheld)`); failed = true;
    }
    if (file.endsWith('.mjs')) {
      const check = spawnSync(process.execPath, ['--check', file], { windowsHide: true, encoding: 'utf8' });
      if (check.status !== 0) { console.error(check.stderr); failed = true; }
    }
    if (file.endsWith('.html')) {
      for (const match of text.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
        try { new vm.Script(match[1]); } catch (error) { console.error(error.message); failed = true; }
      }
    }
  }
}
walk(REPO);
if (failed) process.exitCode = 1;
else console.log(`Source syntax and secret-pattern checks passed (${files} files).`);
