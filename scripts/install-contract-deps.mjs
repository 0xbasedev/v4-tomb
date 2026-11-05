import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../contracts/', import.meta.url));
const dependencies = JSON.parse(readFileSync(resolve(root, 'dependencies.json'), 'utf8'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'inherit' });
for (const [name, { repository, revision }] of Object.entries(dependencies)) {
  const destination = resolve(root, 'lib', name);
  if (!existsSync(destination)) {
    mkdirSync(destination, { recursive: true });
    git(destination, 'init', '-q');
    git(destination, 'remote', 'add', 'origin', `https://github.com/${repository}.git`);
  }
  const current = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: destination, encoding: 'utf8' }).stdout ?? '';
  if (current.trim() !== revision) {
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: destination, encoding: 'utf8' });
    if (dirty.trim()) throw new Error(`Refusing to change modified dependency: ${name}`);
    git(destination, 'fetch', '--depth', '1', `https://github.com/${repository}.git`, revision);
    git(destination, 'checkout', '--detach', revision);
  }
  git(destination, 'submodule', 'update', '--init', '--recursive', '--depth', '1');
}
