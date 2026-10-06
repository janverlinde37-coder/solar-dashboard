// Runs every test_*.js in this folder. Exit code is non-zero if any fail.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter((f) => /^test_.*\.js$/.test(f)).sort();
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8' });
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) bad++;
}
console.log(bad ? `${bad} of ${files.length} test files FAILED` : `All ${files.length} test files passed`);
process.exit(bad ? 1 : 0);
