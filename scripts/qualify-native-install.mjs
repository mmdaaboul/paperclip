#!/usr/bin/env node
// Disposable hosted Linux qualification only. No production installation entry point.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getReleasePackages } from './release-package-map.mjs';

export const BOOTSTRAP = Object.freeze({
  version: '2026.1117.0',
  url: 'https://registry.npmjs.org/paperclipai/-/paperclipai-2026.1117.0.tgz',
  integrity: 'sha512-6ub0E6eZPIu75Sa8LT9nvCoHnYX1ntMu5RfvZY/wHwz0YUUT3uOxMzO/l/HIylGwvj8agh34YrMB0qg3RPhRaw==',
});
export function verifyBootstrap(bytes) {
  assert(bytes.length > 0 && bytes.length <= 16 * 1024 * 1024, 'bootstrap_size');
  assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), BOOTSTRAP.integrity, 'bootstrap_integrity');
}
export async function readBootstrap(response) {
  assert(response.ok && response.body, 'official_bootstrap_download');
  const declared = response.headers.get('content-length');
  if (declared !== null) assert(Number(declared) <= 16 * 1024 * 1024, 'bootstrap_declared_size');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; assert(size <= 16 * 1024 * 1024, 'bootstrap_stream_size'); chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks); verifyBootstrap(bytes); return bytes;
}
export function diagnosticCodes(output, token) {
  const redacted = output.split(token).join('[redacted]');
  const fixed = ['ETARGET', 'ENOENT', 'EACCES', 'ENOMEM', 'ENOSPC', 'EINTEGRITY', 'ETIMEDOUT',
    'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_PNPM_OUTDATED_LOCKFILE',
    'ERR_PNPM_FETCH_404', 'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL'];
  const codes = new Set(fixed.filter(code => new RegExp('\\b' + code + '\\b').test(redacted)));
  for (const code of redacted.match(/\b(?:TS\d{4}|E\d{4})\b/g) ?? []) codes.add(code);
  return { codes: [...codes].sort().slice(0, 32), redactedOutputBytes: Buffer.byteLength(redacted) };
}
export function validateTarget(env) {
  assert(env.GITHUB_ACTIONS === 'true' && env.RUNNER_OS === 'Linux', 'hosted_linux_only');
  assert.equal(env.GITHUB_REPOSITORY, 'mmdaaboul/paperclip', 'selected_fork_only');
  assert.equal(env.GITHUB_REF, 'refs/heads/qualification/native-linux-build', 'qualification_branch_only');
  assert(/^[a-f0-9]{40}$/.test(env.SOURCE_SHA ?? ''), 'immutable_sha_required');
  assert.equal(env.SOURCE_SHA, env.WORKFLOW_SHA, 'workflow_source_must_match');
  assert(env.HOME && env.RUNNER_TEMP && env.PATH, 'native_environment_required');
  assert(/^[A-Za-z0-9_.-]{1,4096}$/.test(env.NATIVE_INSTALL_GITHUB_TOKEN ?? ''), 'read_only_job_token_required');
}
export function assertHealth(h, sha, bootstrapStatus) {
  assert.equal(h.status, 'ok'); assert.equal(h.commit, sha);
  assert.equal(h.deploymentMode, 'authenticated'); assert.equal(h.deploymentExposure, 'private');
  assert.equal(h.bootstrapStatus, bootstrapStatus);
}
export function workspaceClosure(packages) {
  const byName = new Map(packages.map(p => [p.name, p]));
  const visiting = new Set(), seen = new Set(), ordered = [];
  function visit(name) {
    if (seen.has(name)) return; assert(!visiting.has(name), 'workspace_dependency_cycle');
    const p = byName.get(name); assert(p, 'workspace_target_missing'); visiting.add(name);
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies'])
      for (const dep of Object.keys(p.pkg[section] ?? {})) if (dep.startsWith('@paperclipai/')) visit(dep);
    visiting.delete(name); seen.add(name); ordered.push(p);
  }
  visit('@paperclipai/server'); return ordered;
}
export function installEnvironment(e, home, pc, tmp) {
  // Deliberate allowlist: no owner PAT, existing provider credentials, DB overrides or CLI auth.
  const env = { HOME: home, USER: e.USER, LOGNAME: e.LOGNAME ?? e.USER, PATH: e.PATH,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TMPDIR: tmp,
    PAPERCLIP_HOME: pc, PAPERCLIP_INSTANCE_ID: 'f03qualification',
    PAPERCLIP_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', PAPERCLIP_NO_BROWSER: '1',
    PAPERCLIP_BUILD_COMMIT: e.SOURCE_SHA, PAPERCLIP_README_ASSET_REF: e.SOURCE_SHA,
    PAPERCLIP_TAILNET_BIND_HOST: '127.0.0.1', PORT: '4311', CARGO_BUILD_JOBS: '2',
    COREPACK_HOME: join(tmp, 'corepack'), CARGO_HOME: join(tmp, 'cargo'),
    RUSTUP_HOME: e.RUSTUP_HOME ?? join(home, '.rustup'),
    npm_config_cache: join(tmp, 'npm'), npm_config_userconfig: '/dev/null',
    npm_config_globalconfig: join(tmp, 'absent-global.npmrc'), npm_config_registry: 'https://registry.npmjs.org',
    XDG_RUNTIME_DIR: e.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: e.DBUS_SESSION_BUS_ADDRESS };
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
}

async function qualify() {
  validateTarget(process.env);
  assert(process.platform === 'linux' && process.arch === 'x64' && process.getuid() > 0, 'normal_linux_user_required');
  const e = process.env, sha = e.SOURCE_SHA, workspace = realpathSync(process.cwd());
  const home = realpathSync(homedir()); assert.equal(realpathSync(e.HOME), home, 'real_runner_home_required');
  const root = join(realpathSync(e.RUNNER_TEMP), 'f03-native-install');
  assert(!existsSync(root), 'fresh_qualification_root_required'); mkdirSync(root, { mode: 0o700 });
  const evidence = { schema: 'paperclip.native-install-qualification.v1', sourceRevision: sha,
    bootstrapVersion: BOOTSTRAP.version, bootstrapIntegrity: BOOTSTRAP.integrity,
    status: 'running', phase: 'preflight', completed: [], retry: false };
  const save = () => writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  const phase = name => { evidence.phase = name; save(); console.log('Qualification phase: ' + name); };
  const done = name => { evidence.completed.push(name); save(); };
  const pc = join(root, 'paperclip'), tmp = join(root, 'tmp');
  mkdirSync(tmp, { mode: 0o700 });
  const env = installEnvironment(e, home, pc, tmp), token = e.NATIVE_INSTALL_GITHUB_TOKEN;
  const shim = join(home, '.local/bin/paperclipai'), unit = 'paperclipai-f03qualification.service';
  const definition = join(home, '.config/systemd/user', unit);
  let serviceAttempted = false, sql;
  function command(exe, args, timeout = 120000, overrides = {}) {
    const r = spawnSync(exe, args, { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8',
      timeout, maxBuffer: 32 * 1024 * 1024 });
    // Raw logs stay private on this disposable runner. Never artifact or print them.
    const log = (String(r.stdout ?? '') + '\n' + String(r.stderr ?? '')).split(token).join('[redacted]');
    writeFileSync(join(root, evidence.phase + '.private.log'), log.slice(-256 * 1024), { mode: 0o600 });
    if (r.error || r.status !== 0 || r.signal) {
      evidence.commandFailure = { exit: r.status, signal: r.signal, reason: r.error?.code ?? 'nonzero_exit' };
      evidence.commandFailure.diagnostics = diagnosticCodes(log, token);
      throw new Error('native_command_failed');
    }
    return r.stdout;
  }
  const cli = (args, timeout) => command(shim, args, timeout);
  const systemctl = args => command('systemctl', ['--user', ...args], 30000);
  const base = 'http://127.0.0.1:4311';
  async function http(path, { method = 'GET', body, cookie } = {}) {
    return fetch(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  async function healthy(status) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      let r; try { r = await http('/api/health'); } catch { /* native startup readiness poll */ }
      if (r?.ok) { const h = await r.json(); assertHealth(h, sha, status); return h; }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('native_health_deadline');
  }
  function runtime() {
    const r = JSON.parse(readFileSync(join(pc, 'instances/f03qualification/runtime-info.json'), 'utf8'));
    assert.equal(r.schemaVersion, 1); assert.equal(r.instanceId, 'f03qualification');
    assert.equal(r.host, '127.0.0.1'); assert.equal(r.port, 4311); assert(Number.isSafeInteger(r.pid) && r.pid > 0);
    const pid = Number(systemctl(['show', unit, '--property=MainPID', '--value']).trim());
    assert.equal(pid, r.pid, 'service_pid_must_serve'); process.kill(pid, 0); return r;
  }
  async function absentListener() {
    let response; try { response = await http('/api/health'); } catch { return; }
    assert.fail('listener_remains_after_native_stop_' + response.status);
  }
  try {
    assert(!existsSync(shim) && !existsSync(definition) && !existsSync(pc), 'preexisting_install_refused');
    assert.equal(command('git', ['-C', workspace, 'rev-parse', 'HEAD']).trim(), sha);
    command('git', ['-C', workspace, 'diff', '--exit-code', 'HEAD', '--']);
    systemctl(['show-environment']); await absentListener();
    const occupied = spawnSync('ss', ['-H', '-ltn', 'sport = :54329'], { encoding: 'utf8', timeout: 5000 });
    assert(occupied.status === 0 && !occupied.stdout.trim(), 'embedded_port_already_used'); done('fresh-host-preflight');
    phase('official-bootstrap-integrity');
    const response = await fetch(BOOTSTRAP.url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    const bytes = await readBootstrap(response);
    const tar = join(root, 'official-bootstrap.tgz'); writeFileSync(tar, bytes, { flag: 'wx', mode: 0o600 }); done('official-bootstrap-integrity');
    phase('complete-native-git-install');
    // Verified official npm artifact; ONE real source install, no source archive override.
    command('npx', ['--yes', '--package', tar, 'paperclipai', 'install', '--repo', e.GITHUB_REPOSITORY, '--ref', sha, '--yes'], 1740000, { GH_TOKEN: token });
    done('complete-native-git-install');
    phase('installed-payload-assets');
    const cliRoot = join(pc, 'cli'), payload = realpathSync(join(cliRoot, 'installs/git', sha.slice(0, 12)));
    assert(payload.startsWith(realpathSync(join(cliRoot, 'installs')) + sep));
    assert.equal(realpathSync(join(cliRoot, 'current')), payload);
    const m = JSON.parse(readFileSync(join(cliRoot, 'install.json'), 'utf8'));
    assert.equal(m.schemaVersion, 1); assert.equal(m.source, 'git'); assert.equal(m.channel, 'pinned');
    assert.equal(m.repo, e.GITHUB_REPOSITORY); assert.equal(m.ref, sha); assert.equal(m.sha, sha);
    assert.equal(realpathSync(m.payloadPath), payload); assert.deepEqual(m.previous, []);
    const packages = workspaceClosure(getReleasePackages());
    const pkgRoot = name => join(payload, 'node_modules', name);
    for (const p of [...packages, getReleasePackages().find(p => p.name === 'paperclipai')]) {
      const actual = JSON.parse(readFileSync(join(pkgRoot(p.name), 'package.json'), 'utf8'));
      assert.equal(actual.name, p.name); assert.equal(actual.version, p.version);
      for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies'])
        assert(Object.values(actual[section] ?? {}).every(v => !v.startsWith('workspace:')), 'unresolved_workspace_protocol');
    }
    const server = pkgRoot('@paperclipai/server');
    assert.equal(JSON.parse(readFileSync(join(server, 'dist/build-info.json'), 'utf8')).commit, sha);
    const runnerRoot = join(server, 'dist/vendor/paperclip-runner');
    const runner = join(runnerRoot, 'bin/paperclip-runnerd'), runnerStat = lstatSync(runner);
    assert(runnerStat.isFile() && !runnerStat.isSymbolicLink() && (runnerStat.mode & 0o111), 'installed_runner_executable');
    const elf = readFileSync(runner);
    assert(elf.length > 64 && elf.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
      && elf[4] === 2 && elf[5] === 1 && elf.readUInt16LE(18) === 62, 'installed_linux_x64_runner');
    const metadata = JSON.parse(command(runner, ['--build-metadata'], 15000));
    assert.equal(metadata.schema, 'paperclip-runner/runnerd-build-metadata/v1');
    assert.equal(metadata.binaryName, 'paperclip-runnerd'); assert.equal(metadata.privateHostControlVersion, 1);
    for (const entry of ['cli/acpx-runtime-sidecar.cjs', 'cli/opencode-app-server-proxy.cjs'])
      assert(lstatSync(join(runnerRoot, entry)).isFile(), 'installed_provider_entrypoint');
    evidence.nativeRunner = { executable: true, linuxX64: true, buildMetadata: true, providerEntrypoints: true };
    const index = readFileSync(join(server, 'ui-dist/index.html'), 'utf8'); assert(index.length > 0);
    function tree(dir) {
      const files = {};
      function walk(p, rel = '', depth = 0) {
        assert(depth < 20); for (const x of readdirSync(p, { withFileTypes: true })) {
          assert(!x.isSymbolicLink(), 'runtime_skill_symlink'); const q = join(p, x.name), r = rel + x.name;
          if (x.isDirectory()) walk(q, r + '/', depth + 1);
          else { assert(x.isFile()); files[r] = createHash('sha256').update(readFileSync(q)).digest('hex'); }
        }
      }
      walk(dir); assert(Object.keys(files).some(p => p.endsWith('/SKILL.md'))); return files;
    }
    const skills = tree(join(workspace, 'skills'));
    for (const name of ['server', 'adapter-claude-local', 'adapter-codex-local'])
      assert.deepEqual(tree(join(pkgRoot('@paperclipai/' + name), 'skills')), skills);
    assert(lstatSync(shim).isFile() && (lstatSync(shim).mode & 0o111), 'executable_managed_shim');
    evidence.workspacePackages = packages.length; done('installed-payload-assets');
    phase('authenticated-native-onboard');
    const instance = join(pc, 'instances/f03qualification'); mkdirSync(instance, { recursive: true, mode: 0o700 });
    writeFileSync(join(instance, '.env'), 'PAPERCLIP_TAILNET_BIND_HOST=127.0.0.1\nPAPERCLIP_TELEMETRY_DISABLED=1\nDO_NOT_TRACK=1\n', { flag: 'wx', mode: 0o600 });
    serviceAttempted = true; cli(['onboard', '--yes', '--bind', 'tailnet', '--install-service'], 360000);
    const configPath = join(instance, 'config.json'), configBytes = readFileSync(configPath);
    const config = JSON.parse(configBytes);
    assert.equal(config.server.deploymentMode, 'authenticated'); assert.equal(config.server.exposure, 'private');
    assert.equal(config.server.host, '127.0.0.1'); assert.equal(config.server.port, 4311);
    assert.equal(config.database.mode, 'embedded-postgres'); assert.equal(config.database.embeddedPostgresPort, 54329);
    assert(readFileSync(definition, 'utf8').includes(pc), 'native_service_home_binding');
    await healthy('bootstrap_pending'); const initial = runtime();
    const asset = index.match(/(?:src|href)="(\/assets\/[^"?#]+\.js)"/); assert(asset, 'ui_js_asset_required');
    const ui = await http('/'); assert(ui.ok); assert((await ui.text()).includes(asset[1]), 'served_native_ui_asset_reference');
    const servedAsset = await http(asset[1]); assert(servedAsset.ok, 'ui_static_asset');
    assert.deepEqual(Buffer.from(await servedAsset.arrayBuffer()), readFileSync(join(server, 'ui-dist', asset[1])), 'served_installed_asset_bytes');
    done('authenticated-native-onboard');
    phase('native-first-owner');
    const signup = await http('/api/auth/sign-up/email', { method: 'POST', body: {
      name: 'Qualification Owner', email: 'qualification@example.invalid', password: randomBytes(24).toString('hex') } });
    assert(signup.ok, 'native_signup'); const signupBody = await signup.json();
    const cookie = signup.headers.getSetCookie().map(c => c.split(';', 1)[0]).join('; '); assert(cookie, 'native_session_cookie');
    const userId = signupBody.user?.id; assert(typeof userId === 'string' && userId.length > 0);
    const claim = await http('/api/bootstrap/claim', { method: 'POST', body: {}, cookie }); assert(claim.ok);
    assert.deepEqual(await claim.json(), { claimed: true, userId });
    async function ownerProof() {
      const session = await http('/api/auth/get-session', { cookie }); assert(session.ok);
      assert.equal((await session.json()).user?.id, userId);
      const companies = await http('/api/companies', { cookie }); assert(companies.ok); assert.deepEqual(await companies.json(), []);
      const anonymous = await http('/api/companies'); assert([401, 403].includes(anonymous.status), 'anonymous_board_denied');
      await healthy('ready');
    }
    await ownerProof(); done('native-first-owner');
    phase('fresh-database-proof');
    const require = createRequire(join(server, 'package.json')), postgres = require('postgres');
    sql = postgres('postgres://paperclip:paperclip@127.0.0.1:54329/paperclip', { max: 1 });
    const snapshot = async () => ({
      tables: (await sql`select tablename from pg_tables where schemaname='public' order by tablename`).map(r => r.tablename),
      migrations: await sql`select hash, created_at from drizzle.__drizzle_migrations order by created_at`,
    });
    const baseline = await snapshot(); assert.equal(baseline.tables.length, 327); assert.equal(baseline.migrations.length, 451);
    for (const table of ['agent_reference_folder_configs', 'agent_reviewer_policies', 'github_push_operation_receipts',
      'reviewer_github_operations', 'reviewer_github_events', 'issue_review_cycle_budgets', 'issue_scoped_reviews'])
      assert(baseline.tables.includes(table), 'custom_foundation_missing_' + table);
    evidence.database = { publicTables: baseline.tables.length, migrations: baseline.migrations.length }; done('fresh-database-proof');
    phase('native-service-restart');
    cli(['service', 'restart', '--instance', 'f03qualification', '--wait', '--json'], 180000);
    await ownerProof(); const restarted = runtime(); assert.notEqual(restarted.pid, initial.pid);
    assert.deepEqual(await snapshot(), baseline); assert.deepEqual(readFileSync(configPath), configBytes);
    done('native-service-restart'); await sql.end(); sql = undefined;
    phase('native-service-stop-start');
    cli(['service', 'stop', '--instance', 'f03qualification', '--json']);
    assert.equal(systemctl(['show', unit, '--property=ActiveState', '--value']).trim(), 'inactive'); await absentListener();
    cli(['service', 'start', '--instance', 'f03qualification', '--json']);
    await ownerProof(); const started = runtime(); assert.notEqual(started.pid, restarted.pid);
    sql = postgres('postgres://paperclip:paperclip@127.0.0.1:54329/paperclip', { max: 1 });
    assert.deepEqual(await snapshot(), baseline); assert.deepEqual(readFileSync(configPath), configBytes);
    evidence.lifecycle = { correlatedPid: true, restartNewPid: true, stopNoListener: true, startNewPid: true,
      sameSource: true, sameSchema: true, sameConfig: true, ownerSessionPreserved: true };
    done('native-service-stop-start'); evidence.status = 'passed';
  } catch {
    // No error message or raw stdout can leak a password, cookie, invite URL or token.
    evidence.status = 'failed'; evidence.failedPhase = evidence.phase;
    process.exitCode = 1;
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
    if (serviceAttempted) {
      phase('owned-service-cleanup');
      try {
        cli(['service', 'uninstall', '--instance', 'f03qualification', '--json'], 120000);
        await absentListener(); assert(!existsSync(definition), 'owned_service_definition_remains');
        evidence.cleanup = 'passed';
      } catch { evidence.cleanup = 'failed'; evidence.status = 'failed'; process.exitCode = 1; }
    }
    evidence.finishedAt = new Date().toISOString(); save();
    console.log(JSON.stringify(evidence));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await qualify();
