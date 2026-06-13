const { spawnSync } = require('node:child_process');
const { mkdirSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const tsc = spawnSync(
  process.execPath,
  ['node_modules/typescript/lib/tsc.js', '-p', 'tsconfig.test.json'],
  { stdio: 'inherit' }
);

if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1);
}

mkdirSync('.tmp-tests', { recursive: true });
writeFileSync(join('.tmp-tests', 'package.json'), '{"type":"commonjs"}\n');

const testFiles = findTestFiles(join('.tmp-tests', 'tests'));
const testRun = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });

process.exit(testRun.status ?? 1);

function findTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return findTestFiles(path);
    }

    return entry.name.endsWith('.test.js') ? [path] : [];
  });
}
