import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOOTSTRAP, verifyBootstrap, readBootstrap, diagnosticCodes, validateTarget, assertHealth, workspaceClosure, installEnvironment } from './qualify-native-install.mjs';
import { getReleasePackages } from './release-package-map.mjs';

const e = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', GITHUB_REPOSITORY: 'mmdaaboul/paperclip',
  GITHUB_REF: 'refs/heads/qualification/native-linux-build', SOURCE_SHA: 'a'.repeat(40), WORKFLOW_SHA: 'a'.repeat(40),
  HOME: '/home/runner', RUNNER_TEMP: '/tmp/runner', PATH: '/opt/node/bin:/usr/bin:/bin',
  USER: 'runner', NATIVE_INSTALL_GITHUB_TOKEN: 'readonly_job_token' };
test('refuses local machines, other forks, moving revisions and a different workflow revision', () => {
  validateTarget(e);
  for (const change of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_OS: 'macOS' }, { GITHUB_REPOSITORY: 'paperclipai/paperclip' },
    { GITHUB_REF: 'refs/heads/master' }, { SOURCE_SHA: 'master' }, { WORKFLOW_SHA: 'b'.repeat(40) }, { NATIVE_INSTALL_GITHUB_TOKEN: '' }])
    assert.throws(() => validateTarget({ ...e, ...change }));
});
test('pins an official bootstrap and rejects empty or corrupted bytes', () => {
  assert.equal(BOOTSTRAP.version, '2026.1117.0');
  assert.throws(() => verifyBootstrap(Buffer.alloc(0))); assert.throws(() => verifyBootstrap(Buffer.from('corrupt')));
  assert.throws(() => verifyBootstrap(Buffer.alloc(16 * 1024 * 1024 + 1)));
});
test('stream size refusal cancels the oversized response before retaining an unlimited body', async () => {
  let cancelled = false, pulls = 0;
  const body = new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBootstrap(new Response(body)), /bootstrap_stream_size/);
  assert(cancelled); assert(pulls <= 19);
  await assert.rejects(readBootstrap(new Response('x', { headers: { 'content-length': String(17 * 1024 * 1024) } })), /bootstrap_declared_size/);
});
test('failure receipt contains only fixed error codes and redacts token before classification', () => {
  const privateText = 'Authorization: secret Cookie: private https://private/invite/token';
  const output = diagnosticCodes('ETARGET TS1234 E0425 ENOENT ' + privateText, 'TS1234');
  assert.deepEqual(output.codes, ['E0425', 'ENOENT', 'ETARGET']);
  assert(!JSON.stringify(output).includes(privateText)); assert.equal(typeof output.redactedOutputBytes, 'number');
});
test('runtime and install base environment excludes ambient provider, DB and GitHub secrets', () => {
  const env = installEnvironment({ ...e, GH_TOKEN: 'owner_pat', GITHUB_TOKEN: 'ambient',
    OPENAI_API_KEY: 'provider', ANTHROPIC_API_KEY: 'provider2', DATABASE_URL: 'real-db', PAPERCLIP_CONFIG: '/real/config' },
  '/home/runner', '/private/pc', '/private/tmp');
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'NATIVE_INSTALL_GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'PAPERCLIP_CONFIG'])
    assert.equal(env[key], undefined);
  assert.equal(env.HOME, '/home/runner'); assert.equal(env.PAPERCLIP_HOME, '/private/pc');
  assert.equal(env.PAPERCLIP_TELEMETRY_DISABLED, '1'); assert.equal(env.PAPERCLIP_TAILNET_BIND_HOST, '127.0.0.1');
});
test('requires exact authenticated private readiness without requiring a redacted version', () => {
  const h = { status: 'ok', commit: e.SOURCE_SHA, deploymentMode: 'authenticated', deploymentExposure: 'private', bootstrapStatus: 'ready' };
  assertHealth(h, e.SOURCE_SHA, 'ready');
  for (const change of [{ status: 'error' }, { commit: 'b'.repeat(40) }, { deploymentMode: 'local_trusted' },
    { deploymentExposure: 'public' }, { bootstrapStatus: 'bootstrap_pending' }]) assert.throws(() => assertHealth({ ...h, ...change }, e.SOURCE_SHA, 'ready'));
});
test('closure includes native peer and optional package versions and rejects missing targets/cycles', () => {
  const a = { name: '@paperclipai/server', version: '0.3.1', pkg: { peerDependencies: { '@paperclipai/shared': '^0.3.1' }, optionalDependencies: { '@paperclipai/plugin-sdk': 'workspace:*' } } };
  const b = { name: '@paperclipai/shared', version: '0.3.1', pkg: {} };
  const c = { name: '@paperclipai/plugin-sdk', version: '1.0.0', pkg: {} };
  assert.deepEqual(workspaceClosure([a, b, c]).map(p => [p.name, p.version]), [[c.name, c.version], [b.name, b.version], [a.name, a.version]]);
  assert.throws(() => workspaceClosure([a, b]));
  assert.throws(() => workspaceClosure([a, { ...b, pkg: { dependencies: { '@paperclipai/server': 'workspace:*' } } }, c]));
  const actual = workspaceClosure(getReleasePackages()); assert(actual.some(p => p.name === '@paperclipai/server'));
  assert.equal(new Set(actual.map(p => p.name)).size, actual.length);
});
test('qualification only uploads a structured receipt and uses one read-only-token installer', () => {
  const workflow = readFileSync(new URL('../.github/workflows/native-linux-build.yml', import.meta.url), 'utf8');
  assert.match(workflow, /timeout-minutes: 45/); assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /contents: write|workflow_dispatch|pull_request|secrets\./);
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/f03-native-install\/evidence.json/);
  assert.doesNotMatch(workflow, /path:.*\*|path:.*log|journalctl/);
});
