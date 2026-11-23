import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {inspectLoadedProfileDelta,projectLoadedTargetNames,validateLoadedProfileDelta} from './qualify-native-sandbox.mjs';

const kernelRoot='/sys/kernel/security/apparmor/policy/profiles/';
const row=(id,name,attachment)=>[
 [id,'name',name],...(attachment===undefined?[]:[[id,'attach',attachment]]),
].map(([part,field,value])=>kernelRoot+part+'/'+field+':'+value+'\n').join('');
const first=row('original.0','original','<unknown>');
const bwrap=row('bwrap.14','bwrap','/usr/bin/bwrap');
const unprivileged=row('unpriv_bwrap.15','unpriv_bwrap','unpriv_bwrap');
const extraNames='bwrap (enforce)\nunpriv_bwrap (enforce)\n';
const before={names:'original (enforce)\n',tree:first};
const after={names:before.names+extraNames,tree:first+bwrap+unprivileged};
const positive=()=>inspectLoadedProfileDelta(before,after);

test('policy delta reports all counts, exact target evidence and prior-row preservation',()=>{
 const r=positive();
 assert(r.accepted);
 assert.equal(r.branch,null);
 assert.equal(r.names.before,1);
 assert.equal(r.names.after,3);
 assert.equal(r.names.added,2);
 assert.equal(r.names.removed,0);
 assert.equal(r.attachments.before,1);
 assert.equal(r.attachments.after,3);
 assert.equal(r.attachments.changed,0);
 assert.equal(r.attachments.removed,0);
 assert.deepEqual(r.targets.map(t=>t.rows[0].attachment),[{text:'/usr/bin/bwrap'},{text:'unpriv_bwrap'}]);
 assert(validateLoadedProfileDelta(before,after));
});

for(const [name,change,branch,code] of [
 ['extra profiles',{names:after.names+'extra (enforce)\n'},'profile-names-delta','sandbox_profile_load_unproven'],
 ['removed prior mode',{names:extraNames},'profile-names-delta','sandbox_profile_load_unproven'],
 ['missing row',{tree:first+bwrap},'attachment-row-count','sandbox_profile_load_unproven'],
 ['other prior attachment',{tree:row('original.0','original','/somewhere/private')+bwrap+unprivileged},'previous-attachment-rows-changed','sandbox_loaded_policy_changed'],
 ['replacement old row ID',{tree:row('other.0','original','<unknown>')+bwrap+unprivileged},'previous-attachment-rows-changed','sandbox_loaded_policy_changed'],
 ['opaque bwrap attach',{tree:first+row('bwrap.14','bwrap','<unknown>')+unprivileged},'target-attachment','sandbox_profile_load_unproven'],
 ['missing bwrap field',{tree:first+row('bwrap.14','bwrap')+unprivileged},'target-attachment','sandbox_profile_load_unproven'],
 ['raw different target',{tree:first+row('bwrap.14','bwrap','/somewhere/private')+unprivileged},'target-attachment','sandbox_profile_load_unproven'],
 ['unknown syntax',{tree:after.tree+'host-private-diagnostic\n'},'after-attachment-parse','sandbox_loaded_attachments_unknown'],
 ['duplicate field',{tree:after.tree+bwrap},'after-attachment-parse','sandbox_loaded_attachments_duplicate'],
]){
 test('policy delta diagnoses '+name+' while preserving the refusal',()=>{
  const run={...after,...change};
  const observation=inspectLoadedProfileDelta(before,run);
  assert.equal(observation.branch,branch);
  assert.equal(observation.code,code);
  assert.equal(observation.accepted,false);
  assert(!JSON.stringify(observation).includes('/somewhere/private'));
  assert(!JSON.stringify(observation).includes('host-private-diagnostic'));
  assert.throws(()=>validateLoadedProfileDelta(before,run),error=>{
   assert.deepEqual(error.sandboxDiagnostic,observation);
   return error.sandboxCode===code;
  });
 });
}

test('policy delta fully counts a real-scale inventory while bounding emitted samples',()=>{
 const many=Array.from({length:145},(_,i)=>'original-'+i);
 const large={names:many.map(n=>n+' (enforce)\n').join(''),tree:many.map(n=>row(n,n,'<unknown>')).join('')};
 const names=large.names+extraNames,tree=large.tree+bwrap+unprivileged;
 const valid=inspectLoadedProfileDelta(large,{names,tree});
 assert.equal(valid.attachments.before,145);
 assert.equal(valid.attachments.after,147);
 assert(valid.accepted);
 const otherRows=Array.from({length:15},(_,i)=>row('other-'+i,'bwrap','private-'+i)).join('');
 const rejected=inspectLoadedProfileDelta(large,{names,tree:tree+otherRows});
 assert.equal(rejected.attachments.added,17);
 assert.equal(rejected.targets[0].attachmentRows,16);
 assert.equal(rejected.targets[0].rows.length,4);
 assert(!JSON.stringify(rejected).includes('private-'));
 assert(Buffer.byteLength(JSON.stringify(rejected))<8192);
});

test('policy delta names disclose only exact target and kernel mode pairs',()=>{
 const entries=projectLoadedTargetNames('bwrap /private/path (enforce)\n'+extraNames);
 assert(/^[a-f0-9]{64}$/.test(entries[0].entries[0].sha256));
 assert.deepEqual(entries[0].entries[1],{text:'bwrap (enforce)'});
 assert.deepEqual(entries[1].entries,[{text:'unpriv_bwrap (enforce)'}]);
 assert(!JSON.stringify(entries).includes('/private/'));
});

test('policy delta diagnostic gets one job, stops before post-load execution, and never compiles or installs',()=>{
 const load=(path)=>readFileSync(new URL(path,import.meta.url),'utf8');
 const workflow=load('../.github/workflows/native-linux-build.yml');
 const full=load('./fixtures/native-stage-executor-full.yml');
 assert.equal(createHash('sha256').update(full).digest('hex'),'8f71f789934c76e3e775f6f51ccda8a20cdbfdc7c6776ee39889b17889572368');
 assert(workflow.includes('timeout-minutes: 12'));
 assert(workflow.includes('run: node scripts/qualify-native-source.mjs --diagnose-policy-delta'));
 assert(workflow.includes('name: native-policy-delta-evidence'));
 assert(!workflow.includes('native_install:'));
 assert(!workflow.includes('qualify-native-install.mjs'));
 const qualify=load('./qualify-native-source.mjs');
 const afterDecision=qualify.indexOf("if(diagnostic==='policy-delta')");
 assert(afterDecision>0&&afterDecision<qualify.indexOf("'--workspace-concurrency=1'"));
 const sandbox=load('./qualify-native-sandbox.mjs');
 assert(sandbox.indexOf("if(policyDeltaDiagnostic){receipt.status='diagnostic-observed'")<sandbox.indexOf('receipt.postProbe=afterDecision'));
});
