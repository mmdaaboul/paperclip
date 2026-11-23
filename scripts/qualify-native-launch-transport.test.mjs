import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { nativeBoundaryProbeProgram, parseSandboxProbeResult, projectLaunchTransport, projectNativeProbeFailure } from './qualify-native-sandbox.mjs';

const challenge = 'local-test-challenge';
const emptyOutput = { stdout: '', stderr: '', status: 1, signal: null };

test('an exec failure and timeout keep their inner reason and output shape', () => {
 const absent = projectLaunchTransport({ ...emptyOutput, status: null, error: { code: 'ENOENT', message: 'private path' } }, challenge);
 assert.equal(absent.spawnError, 'ENOENT');
 assert.equal(absent.exit, null);
 assert.equal(absent.childEntryObserved, false);
 assert.equal(absent.stderrBytes, 0);
 const timedOut = projectLaunchTransport({ ...emptyOutput, status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' } }, challenge);
 assert.equal(timedOut.spawnError, 'ETIMEDOUT');
 assert.equal(timedOut.signal, 'SIGKILL');
 assert(!JSON.stringify(absent).includes('private path'));
});

test('recognized stderr keeps a category but never reproduces the raw line or credentials', () => {
 const secret = 'github_pat_example_private_value';
 const report = projectLaunchTransport({ ...emptyOutput, stderr: `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted ${secret}\n` }, challenge);
 assert(report.stderrCategories.includes('namespace_loopback_denied'));
 assert.equal(report.childTerminalObserved, false);
 assert(!JSON.stringify(report).includes(secret));
 assert(projectLaunchTransport({ ...emptyOutput, stderr: secret }, challenge).unclassifiedStderr);
});

test('entry and terminal markers must match the exact probe challenge', () => {
 const stdout = JSON.stringify({ schema: 'paperclip.native-sandbox-probe-failure.v1', challenge });
 const stderr = `PAPERCLIP_CHILD_ENTRY:${challenge}\n`;
 const report = projectLaunchTransport({ ...emptyOutput, stdout, stderr }, challenge);
 assert(report.childEntryObserved && report.childTerminalObserved);
 assert.equal(projectLaunchTransport({ ...emptyOutput, stdout, stderr }, 'different').childEntryObserved, false);
 assert.equal(projectLaunchTransport({ ...emptyOutput, stdout, stderr }, 'different').childTerminalObserved, false);
 assert.equal(projectLaunchTransport({ ...emptyOutput, stdout: stdout.slice(0, -1), stderr }, challenge).childTerminalObserved, false);
 assert(!JSON.stringify(report).includes(challenge));
});

test('the wrapper retains transport on failure without turning a new stderr category into policy authority', () => {
 const transport = projectLaunchTransport({ ...emptyOutput, stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' }, challenge);
 const line = `PAPERCLIP_NATIVE_LAUNCH_TRANSPORT:${JSON.stringify({ ...transport, privateMessage:'do not retain' })}\n`;
 const result = parseSandboxProbeResult({ ok:false, exit:1, signal:null, stdout:'', stderr:line, namespaceDenied:false });
 assert.equal(result.status, 'native_probe_refused');
 assert.deepEqual(result.transport, transport);
 assert.equal(parseSandboxProbeResult({ok:false,exit:1,signal:null,stdout:'',stderr:line+line,namespaceDenied:false}).transport,undefined);
});

test('missing inner pipes and unbound child receipts keep their exact limited meaning', () => {
 const absent = { status:null, stdout:null, stderr:null, signal:null, error:{ code:'ENOENT' } };
 assert.deepEqual(projectNativeProbeFailure(absent,projectLaunchTransport(absent,challenge)),{typedNamespaceRefusal:false,failure:null});
 const receipt = { schema:'paperclip.native-sandbox-probe-failure.v1',code:'sandbox_execution_label_refused',challenge:'wrong' };
 const incorrect = { ...emptyOutput, stdout:JSON.stringify(receipt) };
 assert.equal(projectNativeProbeFailure(incorrect,projectLaunchTransport(incorrect,challenge)).failure.code,'sandbox_child_boundary_refused');
 const correct = { ...emptyOutput, stdout:JSON.stringify({...receipt,challenge}) };
 assert.equal(projectNativeProbeFailure(correct,projectLaunchTransport(correct,challenge)).failure.code,'sandbox_execution_label_refused');
 const denied = { ...emptyOutput, stderr:'bwrap: No permissions to create new namespace\n' };
 assert(projectNativeProbeFailure(denied,projectLaunchTransport(denied,challenge)).typedNamespaceRefusal);
 const contradictory = { ...denied, stderr:denied.stderr+`PAPERCLIP_CHILD_ENTRY:${challenge}\n` };
 assert(!projectNativeProbeFailure(contradictory,projectLaunchTransport(contradictory,challenge)).typedNamespaceRefusal);
});

test('a real test child delivers its synchronous marker and terminal receipt through the pipe', {skip: process.getuid?.() === 0}, () => {
 const child = spawnSync(process.execPath, ['-e', nativeBoundaryProbeProgram(), '/nonexistent', '/nonexistent', '/nonexistent', '/nonexistent', '/nonexistent', '1', challenge], { encoding:'utf8', timeout:2000 });
 const proof = projectLaunchTransport(child, challenge);
 assert.equal(child.status, 25);
 assert(proof.childEntryObserved && proof.childTerminalObserved);
 assert(['sandbox_execution_label_io_refused','sandbox_execution_label_refused','sandbox_child_boundary_refused'].includes(JSON.parse(child.stdout).code));
});

test('the hosted diagnostic routes to the pinned probe and returns before build or policy staging', () => {
 const workflow = readFileSync(new URL('../.github/workflows/native-linux-build.yml', import.meta.url),'utf8');
 const sandbox = readFileSync(new URL('./qualify-native-sandbox.mjs', import.meta.url),'utf8');
 const source = readFileSync(new URL('./qualify-native-source.mjs', import.meta.url),'utf8');
 assert(workflow.includes('timeout-minutes: 12'));
 assert(workflow.includes('node scripts/qualify-native-source.mjs --diagnose-launch-transport'));
 assert(!workflow.includes('native_install:'));
 assert(source.indexOf("if(diagnostic){evidence.phase='native-launch-transport-observed'") < source.indexOf("'--workspace-concurrency=1'"));
 assert(sandbox.indexOf("if(postAcquisitionDiagnostic){receipt.status='diagnostic-observed'") < sandbox.indexOf('const stage=stageAuthenticatedProfile'));
});
