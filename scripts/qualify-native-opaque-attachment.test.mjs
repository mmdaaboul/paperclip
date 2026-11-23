import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {bindOpaqueBwrapProbe,canProbeOpaqueBwrapAttachment,inspectLoadedProfileDelta,validateLoadedProfileDelta} from './qualify-native-sandbox.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const elf='b'.repeat(64);
const bwrapHash='e318903862396f96de3df57264e0158682b952fd3fb53ac23d876413e7b30f71';
const prefix='/sys/kernel/security/apparmor/policy/profiles/';
const row=(id,name,attach)=>prefix+id+'/name:'+name+'\n'+prefix+id+'/attach:'+attach+'\n';
const before={names:'old (enforce)\n',tree:row('old.0','old','<unknown>')};
const after={names:before.names+'bwrap (enforce)\nunpriv_bwrap (enforce)\n',tree:before.tree+row('bwrap.1','bwrap','<unknown>')+row('unpriv_bwrap.2','unpriv_bwrap','unpriv_bwrap')};
const delta=()=>inspectLoadedProfileDelta(before,after);
const controls=['nativeSandbox','allowedRead','scratchWrite','candidateDenied','referenceDenied','protectedDenied','protectedReadDenied','metadataDenied','outsideDenied','networkDenied','outsideNetworkControl','originalBytesPreserved'];
const probe=()=>({status:'passed',proof:{
 schema:'paperclip.native-sandbox-probe.v1',uid:1001,codexVersion:'0.160.0',wrapperSha256:'c'.repeat(64),nativeElfSha256:elf,bwrapPath:'/usr/bin/bwrap',bwrapSha256:bwrapHash,
 ...Object.fromEntries(controls.map(key=>[key,true])),
 executionLabel:{schema:'paperclip.native-sandbox-execution-label.v1',uid:1001,path:'/proc/self/attr/apparmor/current',entry:'bwrap//&unpriv_bwrap (enforce)',exit:'bwrap//&unpriv_bwrap (enforce)',mode:'enforce',profiles:['bwrap','unpriv_bwrap'],identityBookends:true,challengeSha256:'d'.repeat(64)},
}});

test('opaque attachment readback can reach only the canary and remains unproved by the literal guard',()=>{
 const receipt=delta();
 assert.equal(receipt.accepted,false);
 assert.equal(receipt.attachments.bwrapAttachment,false);
 assert(canProbeOpaqueBwrapAttachment(receipt));
 assert.throws(()=>validateLoadedProfileDelta(before,after),/load_unproven/);
 const literal={...after,tree:after.tree.replace('bwrap.1/attach:<unknown>','bwrap.1/attach:/usr/bin/bwrap')};
 assert(validateLoadedProfileDelta(before,literal));
 assert(!canProbeOpaqueBwrapAttachment(inspectLoadedProfileDelta(before,literal)));
});
for(const [name,alter] of [
 ['unexpected branch',d=>{d.branch='attachment-row-count';}],
 ['extra unknown attachment',d=>{d.targets[1].rows[0].attachment.text='<unknown>';}],
 ['known but other attachment',d=>{d.targets[0].rows[0].attachment.text='/usr/local/bin/bwrap';}],
 ['unobserved attachment',d=>{d.targets[0].rows[0].attachment=null;}],
 ['old target',d=>{d.targets[0].rows[0].newRow=false;}],
 ['missing row',d=>{delete d.targets[0].rows;}],
 ['changed inherited row',d=>{d.attachments.changed=1;}],
 ['missing inherited mode',d=>{d.names.removed=1;}],
 ['preexisting target',d=>{d.targets[1].oldNames=1;}],
 ['nonunique list',d=>{d.names.afterUnique--;}],
 ['incomplete row',d=>{d.attachments.afterIncomplete=1;}],
])test('opaque attachment gate refuses '+name,()=>{const d=delta();alter(d);assert(!canProbeOpaqueBwrapAttachment(d));});

test('opaque attachment proof binds the real probe, original executable pin and both separate readbacks',()=>{
 const proof=bindOpaqueBwrapProbe({loaded:after,readback:{...after},probe:probe(),expectedBwrapSha256:bwrapHash});
 assert.equal(proof.namesSha256,sha(after.names));
 assert.equal(proof.attachmentsSha256,sha(after.tree));
 assert.equal(proof.executionLabelChallengeSha256,probe().proof.executionLabel.challengeSha256);
 assert.equal(proof.bwrapSha256,bwrapHash);
 assert.equal(proof.policyUnchangedAcrossProbe,true);
});
test('opaque attachment proof refuses policy drift or an altered executable, label, or scoped control',()=>{
 const valid={loaded:after,readback:{...after},probe:probe(),expectedBwrapSha256:bwrapHash};
 for(const readback of [{...after,names:after.names+'new (enforce)\n'},{...after,tree:after.tree+'unexpected'}])assert.throws(()=>bindOpaqueBwrapProbe({...valid,readback}),/policy_changed/);
 assert.throws(()=>bindOpaqueBwrapProbe({...valid,expectedBwrapSha256:elf}),/bwrap_changed/);
 assert.throws(()=>bindOpaqueBwrapProbe({...valid,probe:{status:'native_probe_refused'}}),/post_prerequisite_refused/);
 const incorrect=probe();incorrect.proof.executionLabel.entry='unconfined';
 assert.throws(()=>bindOpaqueBwrapProbe({...valid,probe:incorrect}),/execution_label_unproven/);
 for(const key of controls){const missing=probe();missing.proof[key]=false;assert.throws(()=>bindOpaqueBwrapProbe({...valid,probe:missing}),/probe_incomplete/);}
});

test('opaque attachment checks gate the actual source build and source-first installer',()=>{
 const text=path=>readFileSync(new URL(path,import.meta.url),'utf8');
 const sandbox=text('./qualify-native-sandbox.mjs');
 assert(sandbox.indexOf('if(!canProbeOpaqueBwrapAttachment(delta))')<sandbox.indexOf('receipt.postProbe=afterDecision'));
 assert(sandbox.indexOf('receipt.profile.opaqueAttachmentProof=bindOpaqueBwrapProbe')<sandbox.indexOf("receipt.status='passed';save();return receipt"));
 const source=text('./qualify-native-source.mjs');
 assert(source.indexOf('await qualifyNativeSandbox(')<source.indexOf("'--workspace-concurrency=1'"));
 const workflow=text('../.github/workflows/native-linux-build.yml');
 assert(workflow.includes("needs.selected_native_source.result == 'success'"));
 assert(workflow.includes('scripts/qualify-native-opaque-attachment.test.mjs'));
 assert(!workflow.includes('--diagnose-policy-delta'));
});
