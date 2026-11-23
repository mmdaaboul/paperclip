import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {completeCanaryObservation,nativeBoundaryProbeProgram,observeFilesystemCanaries,projectCanaryObservation,parseSandboxProbeResult,projectLaunchTransport,projectNativeProbeFailure} from './qualify-native-sandbox.mjs';

const roots=['/candidate','/reference','/protected','/scratch','/outside'];
const deny=code=>{throw Object.assign(Error('PRIVATE_PATH /never/disclose'),{code});};
function fixture(failures={}){
 const calls=[];
 const reader={
  readFileSync(path){
   calls.push(['read',path]);
   if(failures[path])deny(failures[path]);
   if(path==='/candidate/canary')return 'retained-candidate';
   if(path==='/reference/canary')return 'retained-reference';
   return deny('ENOENT');
  },
  writeFileSync(path){
   calls.push(['write',path]);
   if(path==='/scratch/allowed')return;
   if(failures[path]==='ALLOW')return;
   deny('EROFS');
  },
 };
 return {reader,calls};
}
const observe=reader=>observeFilesystemCanaries(reader,roots,['ENOENT','EROFS','EACCES']);
const report=filesystem=>({schema:'paperclip.native-canary-observation.v1',filesystem,network:'denied'});
const parent={outsideNetworkControl:true,candidateUnchanged:true,referenceUnchanged:true,protectedUnchanged:true,metadataUnchanged:true,scratchContentPresent:true,outsideFileAbsent:true};

test('canary controls enumerate every fixed operation in one child and disclose no contents',()=>{
 const {reader,calls}=fixture();
 const result=observe(reader);
 assert.equal(calls.length,9);
 assert.equal(result.length,9);
 assert(result.every(row=>row.passed));
 assert.equal(result[0].outcome,'retained');
 assert.equal(result[7].errno,'ENOENT');
 assert.equal(result[8].name,'scratch-write');
 assert.deepEqual(projectCanaryObservation(report(result)),report(result));
 assert(!JSON.stringify(result).includes('/candidate'));
});
test('canary controls retain failures in several roles without stopping at the first failure',()=>{
 const {reader,calls}=fixture({'/candidate/canary':'EACCES','/outside/outside':'ALLOW'});
 const result=observe(reader);
 assert.equal(calls.length,9);
 assert.deepEqual(result.filter(row=>!row.passed).map(row=>[row.name,row.outcome,row.errno]),[
  ['candidate-read','error','EACCES'],['outside-write','completed',null],
 ]);
 assert(!JSON.stringify(result).includes('PRIVATE_PATH'));
});
test('canary controls redact unexpected errno and enforce exact role, status and order',()=>{
 const {reader}=fixture({'/reference/canary':'PRIVATE_CODE'});
 const r=report(observe(reader));
 assert.equal(r.filesystem[1].errno,'OTHER');
 for(const mutate of [
  x=>{x.filesystem.reverse();},x=>{x.filesystem.pop();},x=>{x.filesystem[0].passed=false;},
  x=>{x.filesystem[0].outcome='completed';},x=>{x.filesystem[1].errno='OTHER_PRIVATE';},x=>{x.network='indeterminate';},
 ]){const bad=structuredClone(r);mutate(bad);assert.equal(projectCanaryObservation(bad),null);}
 r.filesystem[0].rawPath='/private/extra';
 r.rawError='PRIVATE_PATH';
 assert(!JSON.stringify(projectCanaryObservation(r)).includes('PRIVATE_PATH'));
 assert(!JSON.stringify(projectCanaryObservation(r)).includes('/private/extra'));
});
test('canary controls survive current parent failure projection with no untrusted extra keys',()=>{
 const {reader}=fixture({'/candidate/canary':'EACCES'});
 const controls=report(observe(reader));
 const stdout=JSON.stringify({schema:'paperclip.native-sandbox-probe-failure.v1',code:'sandbox_child_boundary_refused',controls,parent:{...parent,raw:'PRIVATE'},raw:'PRIVATE'});
 const r=parseSandboxProbeResult({ok:false,exit:1,signal:null,stdout,stderr:'',outputSha256:'a'.repeat(64)});
 assert.equal(r.status,'native_probe_refused');
 assert.deepEqual(r.safeFailure.controls,controls);
 assert.deepEqual(r.safeFailure.parent,parent);
 assert(!JSON.stringify(r).includes('PRIVATE'));
 assert(!completeCanaryObservation(r,1001));
});
for(const shouldFail of [false,true]){
 test('canary controls execute the generated child and correlate '+(shouldFail?'complete refusal':'all passing operations'),()=>{
  const {reader}=fixture(shouldFail?{'/reference/canary':'EACCES','/outside/outside':'ALLOW'}:{});
  const label=Buffer.from('bwrap//&unpriv_bwrap (enforce)\n'),challenge='local-observer-fixture';
  const output={status:null,stdout:'',stderr:''};let remaining,networkDenied;
  const fs={...reader,constants:{O_RDONLY:0},
   openSync(path){assert.equal(path,'/proc/self/attr/apparmor/current');remaining=label.length;return 42;},
   readSync(fd,target,offset){label.copy(target,offset,0,remaining);const read=remaining;remaining=0;return read;},
   closeSync(){},writeSync(stream,text){output[stream===1?'stdout':'stderr']+=text;},
  };
  const net={connect(port,address){assert.equal(port,12345);assert.equal(address,'127.0.0.1');
   return {on(name,fn){assert.equal(name,'error');networkDenied=fn;},setTimeout(){}};}};
  const process={argv:['node',...roots,'12345',challenge],getuid:()=>1001,exit(code){output.status=code;}};
  const req=name=>name==='node:fs'?fs:net;
  new Script(nativeBoundaryProbeProgram()).runInNewContext({require:req,process,Buffer});
  networkDenied();
  const transport=projectLaunchTransport(output,challenge);
  assert(transport.childEntryObserved&&transport.childTerminalObserved);
  const child=JSON.parse(output.stdout);
  assert.equal(child.controls.filesystem.length,9);
  if(shouldFail){
   assert.equal(output.status,25);
   const result=projectNativeProbeFailure(output,transport).failure;
   assert.deepEqual(result.controls.filesystem.filter(row=>!row.passed).map(row=>row.name),['reference-read','outside-write']);
   assert(completeCanaryObservation({status:'native_probe_refused',transport,safeFailure:{...result,parent}},1001));
  }else{
   assert.equal(output.status,0);
   assert.equal(child.entry,child.exit);
   assert(child.controls.filesystem.every(row=>row.passed));
  }
 });
}
test('canary controls require actual transport, stable enforcing entry and exit, matching UID and parent bookends',()=>{
 const {reader}=fixture({'/reference/canary':'EACCES'});
 const label='bwrap//&unpriv_bwrap (enforce)';
 const probe={status:'native_probe_refused',transport:{schema:'paperclip.native-probe-transport.v1',exit:25,signal:null,spawnError:null,childEntryObserved:true,childTerminalObserved:true},
  safeFailure:{code:'sandbox_child_boundary_refused',controls:report(observe(reader)),parent,canaryIdentity:{uid:1001,entry:label,exit:label}}};
 assert(completeCanaryObservation(probe,1001));
 for(const alter of [
  x=>{delete x.transport;},x=>{x.transport.childEntryObserved=false;},x=>{x.transport.childTerminalObserved=false;},
  x=>{x.transport.exit=0;},x=>{x.transport.spawnError='EPERM';},x=>{x.safeFailure.canaryIdentity.uid=0;},
  x=>{x.safeFailure.canaryIdentity.exit='unconfined';},x=>{delete x.safeFailure.canaryIdentity;},
  x=>{x.safeFailure.parent.outsideNetworkControl=false;},x=>{delete x.safeFailure.parent;},
  x=>{x.safeFailure.controls=report(observe(fixture().reader));},
 ]){const bad=structuredClone(probe);alter(bad);assert(!completeCanaryObservation(bad,1001));}
});
test('canary controls diagnostic runs one real child and cannot build or install',()=>{
 assert(new Script(nativeBoundaryProbeProgram()));
 const get=(path)=>readFileSync(new URL(path,import.meta.url),'utf8');
 const active=get('../.github/workflows/native-linux-build.yml');
 assert(active.includes('timeout-minutes: 12'));
 assert(active.includes('--diagnose-canary-controls'));
 assert(!active.includes('native_install:'));
 const source=get('./qualify-native-source.mjs');
 assert(source.indexOf("if(diagnostic==='canary-controls')")<source.indexOf("'--workspace-concurrency=1'"));
 const sandbox=get('./qualify-native-sandbox.mjs');
 assert(sandbox.indexOf('const filesystem=observeFilesystemCanaries')>sandbox.indexOf('lastLabel=entry;validateExecutionLabel(entry)'));
 assert(sandbox.includes("if(network!=='denied'||filesystem.some(result=>!result.passed))fail"));
 assert(sandbox.includes("canaryObservation.filesystem.some(x=>!x.passed)"));
});
