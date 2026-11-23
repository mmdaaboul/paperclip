import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {postAcquisitionSandboxDecision, projectLaunchTransport, LOOPBACK_PREREQUISITE} from './qualify-native-sandbox.mjs';

const observedStderr = 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n';
const host = {os:'ubuntu',release:'24.04',uid:1001,apparmor:true,restrictedUserns:1,maxUserNamespaces:55514,usernsClone:1,seccomp:0,
 bwrapPresent:true,bwrapTrusted:true,bwrapPackageOwned:true,bwrapSystemLaunchSupported:true,
 bwrapMode:LOOPBACK_PREREQUISITE.bwrapMode,bwrapPackageVersion:LOOPBACK_PREREQUISITE.bwrapPackageVersion,bwrapSha256:LOOPBACK_PREREQUISITE.bwrapSha256};
const makeProbe = (result={})=>({status:'native_probe_refused',exit:1,signal:null,
 transport:projectLaunchTransport({status:1,signal:null,stdout:'',stderr:observedStderr,...result},'unit-child-challenge')});

test('the exact measured pre-child loopback refusal enters only the existing guarded profile path',()=>{
 const probe=makeProbe();
 assert.equal(probe.transport.stderrSha256, LOOPBACK_PREREQUISITE.stderrSha256);
 assert.equal(probe.transport.stderrBytes,61);
 assert.equal(postAcquisitionSandboxDecision(host,probe),'documented-loopback-profile-prerequisite');
 assert.equal(postAcquisitionSandboxDecision(host,{status:'passed'}),'none');
 assert.equal(postAcquisitionSandboxDecision(host,{status:'namespace_denied'}),'documented-profile-prerequisite');
});

test('lookalike loopback text, output from the child, and process faults stay refused',()=>{
 for(const change of [
  {stderr:'bwrap: mount: Operation not permitted\n'},
  {stderr:observedStderr+'extra\n'},
  {stderr:observedStderr.replace('RTM_NEWADDR','RTM_DELADDR')},
  {stderr:observedStderr.trimEnd()},
  {stderr:observedStderr+'PAPERCLIP_CHILD_ENTRY:unit-child-challenge\n'},
  {stdout:'partial'},
  {status:0},
  {signal:'SIGTERM'},
  {error:{code:'ETIMEDOUT'}},
 ])assert.throws(()=>postAcquisitionSandboxDecision(host,makeProbe(change)),/unclassified/);
 for(const extra of [{safeFailure:{code:'sandbox_execution_label_refused'}},{exit:2},{signal:'SIGKILL'}, {transport:null}])assert.throws(()=>postAcquisitionSandboxDecision(host,{...makeProbe(),...extra}),/unclassified/);
});

test('the selected host requires signed system executable identity and unchanged namespace prerequisites',()=>{
 for(const change of [{release:'26.04'},{uid:0},{apparmor:false},{restrictedUserns:0},{seccomp:2},{maxUserNamespaces:0},{usernsClone:0},{usernsClone:undefined},
  {bwrapPresent:false,bwrapPackageOwned:false},{bwrapTrusted:false},{bwrapPackageOwned:false},{bwrapSystemLaunchSupported:false},{bwrapMode:0o4755},
  {bwrapSha256:'a'.repeat(64)},{bwrapPackageVersion:'0.9.0-1ubuntu0.2'}]){
  const candidate={...host,...change};
  if(!candidate.bwrapPresent)assert.notEqual(postAcquisitionSandboxDecision(candidate,makeProbe()),'documented-loopback-profile-prerequisite');
  else assert.throws(()=>postAcquisitionSandboxDecision(candidate,makeProbe()),/sandbox_/);
 }
});

test('the full workflow requires source success before invoking the installer',()=>{
 const active = readFileSync(new URL('../.github/workflows/native-linux-build.yml', import.meta.url), 'utf8');
 const workflow = active.includes('--diagnose-policy-delta') ? readFileSync(new URL('./fixtures/native-stage-executor-full.yml', import.meta.url), 'utf8') : active;
 const source=readFileSync(new URL('./qualify-native-sandbox.mjs',import.meta.url),'utf8');
 assert(workflow.includes('needs: selected_native_source'));
 assert(workflow.includes("needs.selected_native_source.result == 'success'"));
 assert(workflow.includes('scripts/qualify-native-loopback-proof.test.mjs'));
 assert(!workflow.includes('--diagnose-launch-transport'));
 assert(source.includes('validateAddOnlyParserArgs(PROFILE_CONTRACT.parserArgs)'));
 assert(source.includes('receipt.after.bwrapSha256!==receipt.afterAcquisition.bwrapSha256'));
});
