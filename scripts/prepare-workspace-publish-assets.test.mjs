import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareWorkspacePublishAssets } from './prepare-workspace-publish-assets.mjs';
import { materializeBundledPublishManifest, materializePublishManifest, sourceWorkspaceVersions } from './prepare-bundled-package.mjs';
import { getReleasePackages } from './release-package-map.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const fixture = () => mkdtempSync(join(tmpdir(), 'native-publish-assets-'));
function workspace() {
  const root = fixture();
  for (const dir of ['scripts', 'ui/dist', 'skills', 'server', 'packages/adapters/claude-local', 'packages/adapters/codex-local']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  cpSync(join(source, 'prepare-server-ui-dist.sh'), join(root, 'scripts/prepare-server-ui-dist.sh'));
  writeFileSync(join(root, 'ui/dist/index.html'), '<html>qualified native UI</html>');
  writeFileSync(join(root, 'skills/skill.md'), 'native runtime skills');
  for (const [dir, name] of [['server', '@paperclipai/server'], ['packages/adapters/claude-local', '@paperclipai/adapter-claude-local'], ['packages/adapters/codex-local', '@paperclipai/adapter-codex-local']]) {
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name, files: ['skills'] }));
  }
  return root;
}

test('actual native UI producer reuses built output and stages all three release skills packages', () => {
  const root = workspace();
  prepareWorkspacePublishAssets(root);
  assert.equal(readFileSync(join(root, 'server/ui-dist/index.html'), 'utf8'), '<html>qualified native UI</html>');
  for (const dir of ['server', 'packages/adapters/claude-local', 'packages/adapters/codex-local']) {
    assert.equal(readFileSync(join(root, dir, 'skills/skill.md'), 'utf8'), 'native runtime skills');
  }
  assert.equal(existsSync(join(root, 'packages/adapters/cursor-local')), false);
});

test('changed native release contract refuses before UI producer or destination writes', () => {
  const root = workspace();
  writeFileSync(join(root, 'packages/adapters/codex-local/package.json'), JSON.stringify({ name: 'changed', files: ['skills'] }));
  assert.throws(() => prepareWorkspacePublishAssets(root), /contract changed/);
  assert.equal(existsSync(join(root, 'server/ui-dist')), false);
  assert.equal(existsSync(join(root, 'server/skills')), false);
});

test('symlinked runtime skills destination refuses before native producer', () => {
  const root = workspace();
  symlinkSync(join(root, 'skills'), join(root, 'server/skills'));
  assert.throws(() => prepareWorkspacePublishAssets(root), /Unsafe native/);
  assert.equal(existsSync(join(root, 'server/ui-dist')), false);
});

test('prepared release reader verifies assets without replacing files or directories', () => {
  const root = workspace(); prepareWorkspacePublishAssets(root);
  const paths = ['server/ui-dist', 'server/ui-dist/index.html', 'server/skills', 'server/skills/skill.md', 'packages/adapters/claude-local/skills', 'packages/adapters/codex-local/skills'];
  const identity = () => paths.map(path => { const s = lstatSync(join(root, path)); return [s.dev, s.ino, s.mtimeMs, s.ctimeMs, s.size]; });
  const before = identity();
  prepareWorkspacePublishAssets(root, { prepared: true });
  prepareWorkspacePublishAssets(root, { prepared: true });
  assert.deepEqual(identity(), before);
});

test('prepared release path refuses missing output rather than starting a producer', () => {
  const root = workspace();
  assert.throws(() => prepareWorkspacePublishAssets(root, { prepared: true }), /ENOENT/);
  assert.equal(existsSync(join(root, 'server/ui-dist')), false);
  assert.equal(existsSync(join(root, 'server/skills')), false);
});

test('actual npm pack skips removed source hooks while clean consumer postinstall still runs', () => {
  const root = fixture(), pkg = join(root, 'producer'), consumer = join(root, 'consumer');
  mkdirSync(pkg); mkdirSync(consumer);
  const manifest = { name: 'native-packaging-lifecycle-fixture', version: '1.0.0', files: ['runtime.cjs'],
    scripts: { prepack: 'node -e "process.exit(91)"', postpack: 'node -e "process.exit(92)"', postinstall: 'node runtime.cjs' } };
  writeFileSync(join(pkg, 'runtime.cjs'), 'require("node:fs").writeFileSync("consumer-postinstall-ran", "yes");');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(manifest));
  const npm = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C', HOME: root,
    TMPDIR: process.env.TMPDIR ?? tmpdir(), npm_config_cache: join(root, 'cache'), npm_config_userconfig: '/dev/null',
    npm_config_globalconfig: join(root, 'absent-global.npmrc'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_offline: 'true' };
  const run = (args, cwd) => execFileSync(process.execPath, [npm, ...args], { cwd, env, timeout: 30000, stdio: 'pipe', maxBuffer: 65536 });
  assert.throws(() => run(['pack', '--pack-destination', root], pkg), error => error.status === 91);
  const staged = materializeBundledPublishManifest(manifest, { omitSourcePackHooks: true });
  assert.equal(manifest.scripts.prepack, 'node -e "process.exit(91)"');
  assert.equal(staged.scripts.postinstall, 'node runtime.cjs');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(staged));
  run(['pack', '--pack-destination', root], pkg);
  const tarballs = readdirSync(root).filter(name => name.endsWith('.tgz')); assert.equal(tarballs.length, 1);
  writeFileSync(join(consumer, 'package.json'), '{"private":true}');
  run(['install', join(root, tarballs[0]), '--no-audit', '--no-fund'], consumer);
  assert.equal(readFileSync(join(consumer, 'node_modules', manifest.name, 'consumer-postinstall-ran'), 'utf8'), 'yes');
});

test('unreviewed prepare lifecycle hook fails closed', () => {
  assert.throws(() => materializeBundledPublishManifest({ name: 'future', scripts: { prepare: 'new producer' } }, { omitSourcePackHooks: true }), /compatibility review/);
});

test('workspace version map fixes mixed versions while preserving the default release API', () => {
  const pkg = { name: '@fixture/server', version: '0.3.1', dependencies: { '@fixture/sdk': 'workspace:*', external: '^9.0.0' } };
  assert.equal(materializePublishManifest(pkg).dependencies['@fixture/sdk'], '0.3.1');
  const result = materializePublishManifest(pkg, { workspaceVersions: new Map([['@fixture/sdk', '1.0.0']]) });
  assert.equal(result.dependencies['@fixture/sdk'], '1.0.0');
  assert.equal(result.dependencies.external, '^9.0.0');
  assert.equal(pkg.dependencies['@fixture/sdk'], 'workspace:*');
});

test('workspace version map preserves native simple ranges in all runtime dependency channels', () => {
  const pkg = { name: '@fixture/server', version: '0.3.1', dependencies: { '@fixture/sdk': 'workspace:' },
    optionalDependencies: { '@fixture/sdk': 'workspace:~' }, peerDependencies: { '@fixture/sdk': 'workspace:^' } };
  const result = materializePublishManifest(pkg, { workspaceVersions: new Map([['@fixture/sdk', '1.0.0']]) });
  assert.equal(result.dependencies['@fixture/sdk'], '1.0.0');
  assert.equal(result.optionalDependencies['@fixture/sdk'], '~1.0.0');
  assert.equal(result.peerDependencies['@fixture/sdk'], '^1.0.0');
});

test('workspace version map rejects missing, invalid or unsupported targets before registry fallback', () => {
  for (const spec of ['workspace:*', 'workspace:../sdk', 'workspace:sdk@*', 'workspace:^1.0.0']) {
    assert.throws(() => materializePublishManifest({ version: '0.3.1', dependencies: { '@fixture/sdk': spec } }, { workspaceVersions: new Map() }), /compatibility review/);
  }
  assert.throws(() => materializePublishManifest({ version: '0.3.1', dependencies: { '@fixture/sdk': 'workspace:*' } }, { workspaceVersions: new Map([['@fixture/sdk', 'invalid']]) }), /Invalid native target/);
  assert.throws(() => materializePublishManifest({ version: '0.3.1' }, { workspaceVersions: {} }), /exact source package map/);
});

test('workspace version map resolves the complete actual native server closure to declared targets', () => {
  const packages = new Map(getReleasePackages().map(entry => [entry.name, entry.pkg]));
  const versions = sourceWorkspaceVersions(), seen = new Set(); let edges = 0;
  function visit(name) {
    if (seen.has(name)) return; seen.add(name);
    const pkg = packages.get(name); assert(pkg, `native package missing: ${name}`);
    const result = materializePublishManifest(pkg, { workspaceVersions: versions });
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependency, spec] of Object.entries(pkg[section] ?? {})) {
        if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue;
        const target = packages.get(dependency); assert(target, `native target missing: ${dependency}`);
        const range = spec.slice('workspace:'.length), prefix = ['^', '~'].includes(range) ? range : '';
        assert.equal(result[section][dependency], prefix + target.version, `${name} → ${dependency}`);
        edges++; visit(dependency);
      }
    }
  }
  visit('@paperclipai/server'); assert(seen.size > 1 && edges > 0);
});

test('workspace version map reaches staged manifests without disabling consumer postinstall', () => {
  const pkg = { name: '@fixture/server', version: '0.3.1', dependencies: { '@fixture/sdk': 'workspace:*' },
    scripts: { prepack: 'source-only', postpack: 'source-only', postinstall: 'consumer-hook' } };
  const result = materializeBundledPublishManifest(pkg, { workspaceVersions: new Map([['@fixture/sdk', '1.0.0']]), omitSourcePackHooks: true });
  assert.equal(result.dependencies['@fixture/sdk'], '1.0.0');
  assert.deepEqual(result.scripts, { postinstall: 'consumer-hook' });
});

test('mixed-version clean npm consumer installs exact local tarballs offline with runtime hooks', () => {
  const root = fixture(), consumer = join(root, 'consumer'); mkdirSync(consumer);
  const shared = '@fixture/shared', sdk = '@fixture/sdk', server = '@fixture/server';
  const packages = [
    { name: shared, version: '0.3.1', files: ['index.cjs'], main: 'index.cjs' },
    { name: sdk, version: '1.0.0', files: ['index.cjs', 'postinstall.cjs'], main: 'index.cjs', dependencies: { [shared]: 'workspace:*' }, scripts: { postinstall: 'node postinstall.cjs' } },
    { name: server, version: '0.3.1', files: ['index.cjs'], main: 'index.cjs', dependencies: { [sdk]: 'workspace:*', [shared]: 'workspace:*' }, scripts: { prepack: 'node -e "process.exit(91)"', postpack: 'node -e "process.exit(92)"' } },
  ];
  const versions = new Map(packages.map(pkg => [pkg.name, pkg.version]));
  const npm = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C', HOME: root,
    TMPDIR: process.env.TMPDIR ?? tmpdir(), npm_config_cache: join(root, 'cache'), npm_config_userconfig: '/dev/null',
    npm_config_globalconfig: join(root, 'absent-global.npmrc'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_offline: 'true' };
  const run = (args, cwd) => execFileSync(process.execPath, [npm, ...args], { cwd, env, timeout: 30000, stdio: 'pipe', maxBuffer: 65536 });
  for (const [index, pkg] of packages.entries()) {
    const dir = join(root, 'package-' + index); mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify(materializeBundledPublishManifest(pkg, { workspaceVersions: versions, omitSourcePackHooks: true })));
    writeFileSync(join(dir, 'index.cjs'), `module.exports = require('./package.json').version;`);
    if (pkg.name === sdk) writeFileSync(join(dir, 'postinstall.cjs'), 'require("node:fs").writeFileSync("consumer-hook-ran", "yes");');
    run(['pack', '--offline', '--pack-destination', root], dir);
  }
  writeFileSync(join(consumer, 'package.json'), '{"private":true}');
  const tarballs = readdirSync(root).filter(name => name.endsWith('.tgz')).map(name => join(root, name)); assert.equal(tarballs.length, 3);
  run(['install', '--offline', '--no-audit', '--no-fund', ...tarballs], consumer);
  for (const pkg of packages) assert.equal(JSON.parse(readFileSync(join(consumer, 'node_modules', pkg.name, 'package.json'), 'utf8')).version, pkg.version);
  assert.equal(readFileSync(join(consumer, 'node_modules', sdk, 'consumer-hook-ran'), 'utf8'), 'yes');
  const data = execFileSync(process.execPath, ['-e', `console.log(JSON.stringify([require('${sdk}'),require('${shared}')]))`], { cwd: consumer, env, timeout: 10000, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(data), ['1.0.0', '0.3.1']);
});
