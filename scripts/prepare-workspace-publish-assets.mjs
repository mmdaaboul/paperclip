// Shared native release preparation. The Git bootstrap reaches this through
// prepare-bundled-package after building the server's dependency closure.
import { cpSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeSkills = [
  ['server', '@paperclipai/server'],
  ['packages/adapters/claude-local', '@paperclipai/adapter-claude-local'],
  ['packages/adapters/codex-local', '@paperclipai/adapter-codex-local'],
];

export function prepareWorkspacePublishAssets(sourceRoot, { prepared = false } = {}) {
  const root = realpathSync(sourceRoot);
  const directory = path => {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) {
      throw new Error(`Unsafe native publish asset directory: ${path}`);
    }
  };
  directory(resolve(root, 'skills'));
  // Validate every destination before the native UI producer or any copy runs.
  for (const [dir, name] of runtimeSkills) {
    const target = resolve(root, dir);
    directory(target);
    const pkg = JSON.parse(readFileSync(resolve(target, 'package.json'), 'utf8'));
    if (pkg.name !== name || !pkg.files?.includes('skills')) {
      throw new Error(`Native release skills contract changed for ${dir}`);
    }
    try { directory(resolve(target, 'skills')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // release.sh prepares once before concurrent pack readers start. Its explicit
  // prepared path must remain read-only, rather than race those readers.
  if (prepared) {
    directory(resolve(root, 'server/ui-dist'));
    const index = lstatSync(resolve(root, 'server/ui-dist/index.html'));
    if (!index.isFile() || index.isSymbolicLink()) throw new Error('Native UI publish output missing');
    for (const [dir] of runtimeSkills) directory(resolve(root, dir, 'skills'));
    return;
  }
  execFileSync('bash', [resolve(root, 'scripts/prepare-server-ui-dist.sh')], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, PAPERCLIP_RELEASE_REUSE_UI_DIST: '1' },
  });
  for (const [dir] of runtimeSkills) {
    const target = resolve(root, dir, 'skills');
    rmSync(target, { recursive: true, force: true });
    cpSync(resolve(root, 'skills'), target, { recursive: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [root] = process.argv.slice(2);
  if (!root) throw new Error('Usage: prepare-workspace-publish-assets.mjs SOURCE_ROOT');
  prepareWorkspacePublishAssets(root);
}
