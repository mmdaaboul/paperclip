import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,chmodSync,symlinkSync,linkSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateSandboxHost,sandboxRepairDecision,profileLoadDecision,validateProbeReceipt,namespaceRefusal,diagnosticHostIdentity,projectTrustRefusal,trustedFile,snapshotSystemTrust,attachmentMayMatch,inspectLoadedAttachments,SANDBOX_LIMITS,PROFILE_CONTRACT,validateAuthenticatedProfile,readAuthenticatedProfile,includeDirectives,validateRootStageMetadata,validateLoadedProfileDelta,verifyRootStage,stageAuthenticatedProfile,inspectProfileIncludeGraph,preserveSandboxFailure} from './qualify-native-sandbox.mjs';
const host=()=>({os:'ubuntu',release:'24.04',uid:1001,bwrapPresent:true,bwrapTrusted:true,bwrapPackageOwned:true,apparmor:true,restrictedUserns:1,maxUserNamespaces:10000,usernsClone:1,seccomp:0});
const proof=()=>({schema:'paperclip.native-sandbox-probe.v1',uid:1001,codexVersion:'0.160.0',bwrapPath:'/usr/bin/bwrap',wrapperSha256:'a'.repeat(64),nativeElfSha256:'b'.repeat(64),bwrapSha256:'c'.repeat(64),nativeSandbox:true,allowedRead:true,scratchWrite:true,candidateDenied:true,referenceDenied:true,protectedDenied:true,protectedReadDenied:true,metadataDenied:true,outsideDenied:true,networkDenied:true,outsideNetworkControl:true,originalBytesPreserved:true,executionLabel:{schema:'paperclip.native-sandbox-execution-label.v1',uid:1001,path:'/proc/self/attr/apparmor/current',entry:'bwrap//&unpriv_bwrap (enforce)',exit:'bwrap//&unpriv_bwrap (enforce)',mode:'enforce',profiles:['bwrap','unpriv_bwrap'],identityBookends:true,challengeSha256:'d'.repeat(64)}});
test('a genuine passing normal-user native sandbox requires no host change',()=>{assert.equal(sandboxRepairDecision(host(),'passed'),'none');assert.equal(validateProbeReceipt(proof()).uid,1001);});
test('a missing distro bwrap is an explicit prerequisite, not permission to use another helper',()=>{const f={...host(),bwrapPresent:false,bwrapTrusted:false,bwrapPackageOwned:false};assert.equal(sandboxRepairDecision(f,'not-run-missing-distro-bwrap'),'install-distro-prerequisites');assert.throws(()=>validateProbeReceipt({...proof(),bwrapPath:'/private/bundled/bwrap'}),/incomplete/);});
test('only the documented restricted Ubuntu24.04 namespace refusal permits profile preparation',()=>{assert.equal(sandboxRepairDecision(host(),'namespace_denied'),'documented-profile-prerequisite');for(const [key,value]of Object.entries({apparmor:false,restrictedUserns:0,maxUserNamespaces:0,usernsClone:0,seccomp:2})){assert.throws(()=>sandboxRepairDecision({...host(),[key]:value},'namespace_denied'),/unclassified/);}});
test('unknown sandbox errors never trigger speculative policy changes',()=>{for(const result of ['native_probe_refused','timeout','killed','unknown'])assert.throws(()=>sandboxRepairDecision(host(),result),/unclassified/);});
test('root, other distributions/releases and untrusted distro binaries are refused',()=>{for(const change of [{uid:0},{uid:undefined},{os:'debian'},{release:'22.04'},{bwrapTrusted:false},{bwrapPackageOwned:false}])assert.throws(()=>validateSandboxHost({...host(),...change}),/unsupported|identity_refused/);});
test('only an absent or byte-identical packaged profile with no loaded conflict may load',()=>{assert.equal(profileLoadDecision({packagedVerified:true,destination:'absent',loaded:'absent',localOverride:false}),'install-and-load');assert.equal(profileLoadDecision({packagedVerified:true,destination:'same-package-bytes',loaded:'absent',localOverride:false}),'load');});
test('unknown loaded policy is never overwritten even if destination is absent or byte-identical',()=>{for(const destination of ['absent','same-package-bytes'])assert.throws(()=>profileLoadDecision({packagedVerified:true,destination,loaded:'unknown-preexisting',localOverride:false}),/policy_conflict/);});
test('divergent destination, unverified package and optional local policy overrides stop',()=>{for(const change of [{destination:'divergent'},{packagedVerified:false},{localOverride:true},{loaded:undefined}])assert.throws(()=>profileLoadDecision({packagedVerified:true,destination:'absent',loaded:'absent',localOverride:false,...change}),/policy_conflict/);});
test('all real native positive/negative boundary proofs and outside network control are mandatory',()=>{const p=proof();for(const key of ['nativeSandbox','allowedRead','scratchWrite','candidateDenied','referenceDenied','protectedDenied','protectedReadDenied','metadataDenied','outsideDenied','networkDenied','outsideNetworkControl','originalBytesPreserved'])for(const value of [false,undefined])assert.throws(()=>validateProbeReceipt({...p,[key]:value}),/incomplete/);});
test('a root, unpinned or hashless probe cannot be presented as native proof',()=>{for(const change of [{uid:0},{uid:undefined},{codexVersion:'latest'},{nativeElfSha256:'unknown'},{wrapperSha256:undefined},{bwrapSha256:'c'}])assert.throws(()=>validateProbeReceipt({...proof(),...change}),/incomplete/);});
test('namespace failure classification is finite and does not misclassify arbitrary command failure',()=>{assert(namespaceRefusal('bwrap: No permissions to create new namespace'));assert(namespaceRefusal('bwrap: Creating new namespace failed: Operation not permitted'));assert(!namespaceRefusal("bwrap: Can't bind mount /private: Permission denied"));assert(!namespaceRefusal('git: permission denied in repository'));assert(!namespaceRefusal('native boundary probe failed'));});
test('closed CLI refuses execution outside the named hosted Linux job',()=>{const r=spawnSync(process.execPath,[fileURLToPath(new URL('./qualify-native-sandbox.mjs',import.meta.url)),'--facts'],{env:{PATH:'/usr/bin:/bin',GITHUB_ACTIONS:'false'},encoding:'utf8',timeout:3000,maxBuffer:65536});assert.notEqual(r.status,0);assert.match(r.stderr,/sandbox_disposable_job_only/);});
test('decisive native probe precedes workspace build and retains the same source test contract',()=>{const source=readFileSync(new URL('./qualify-native-source.mjs',import.meta.url),'utf8');assert(source.indexOf('await qualifyNativeSandbox(')>source.indexOf("['pnpm','install','--frozen-lockfile']"));assert(source.indexOf('await qualifyNativeSandbox(')<source.indexOf("['pnpm','-r'"));assert(source.includes('evidence.sandboxPrerequisite=r;save();'));const contract=JSON.parse(readFileSync(new URL('./native-selected-source-contract.json',import.meta.url)));
 assert.equal(contract.groups.length,57);
 assert.equal(createHash('sha256').update(JSON.stringify(contract.groups.slice(0,48))).digest('hex'),'30893e8b3e1bb6d04565ba097ce43a3da0e0202c4d7c0b9ddd32b4a4a74c2899');
 assert.equal(contract.groups[47].path,'packages/paperclip-runner/src/drivers/codex/reviewer-candidate-inspection.test.ts');
 assert.deepEqual(contract.groups.slice(48),[
  'ui/src/dot-entry-lifecycle.test.tsx',
  'ui/src/dot-entry.test.tsx',
  'ui/src/hooks/useResilientFetch.test.tsx',
  'ui/src/lib/connectivity.test.ts',
  'ui/src/lib/dot-pairing-runtime.test.ts',
  'ui/src/lib/react-root.test.ts',
  'ui/src/lib/tenant-session-recovery.test.ts',
  'ui/src/lib/ui-entry.test.ts',
  'ui/src/pages/McpConnect.test.tsx',
 ].map(path=>({project:'root',path,selection:'whole-file'})));
});
test('workflow host facts/test hook is source-job only and job permissions/timeouts stay unchanged',()=>{const w=readFileSync(new URL('./fixtures/native-add-only-full-qualification.yml',import.meta.url),'utf8');assert.equal(w.split('Inspect native Linux sandbox host prerequisites').length-1,1);assert(w.indexOf('Inspect native Linux sandbox host prerequisites')>w.indexOf('  selected_native_source:'));assert(w.includes('scripts/qualify-native-sandbox.test.mjs'));assert(w.includes('needs: selected_native_source'));assert(w.includes("if: needs.selected_native_source.result == 'success' &&"));assert(!w.includes('if: always() &&'));assert(w.includes('permissions:\n  contents: read'));assert.equal(w.match(/timeout-minutes: 45/g).length,2);});
test('prerequisite ceilings and initial/postAPT/conditional post-add probe topology are fixed',()=>{assert.deepEqual(SANDBOX_LIMITS,{aggregateMs:600000,aptMs:300000,profileMs:60000,probeMs:15000,outputBytes:65536});const source=readFileSync(new URL('./qualify-native-sandbox.mjs',import.meta.url),'utf8');assert(!source.includes('sysctl -w'));assert(!source.includes('--dangerously-bypass'));assert(!source.includes("['-n','/bin/sh'"));assert.equal(source.match(/await probe\(\)/g).length,3);});

test('kernel attachment inspection detects arbitrary names, nested profiles and unknown wide patterns',()=>{
 const base='/sys/kernel/security/apparmor/policy/profiles/';
 assert.equal(inspectLoadedAttachments('arbitrary (enforce)\n',base+'a/name:arbitrary\n'+base+'a/attach:/usr/bin/bwrap\n','bwrap').conflict,true);
 assert.equal(inspectLoadedAttachments('parent//child (enforce)\n',base+'p/profiles/c/name:parent//child\n'+base+'p/profiles/c/attach:<unknown>\n','bwrap').conflict,true);
 assert.equal(inspectLoadedAttachments('other (enforce)\n',base+'a/name:other\n'+base+'a/attach:/usr/{lib,lib64}/other/**\n','bwrap').conflict,false);
 for(const tree of ['',base+'a/name:other\n',base+'a/name:other\n'+base+'a/name:other\n'+base+'a/attach:/bin/other\n'])assert.throws(()=>inspectLoadedAttachments('other (enforce)\n',tree,'bwrap'),/incomplete|duplicate/);
});
test('attachment matching proves only conservative literal-prefix disjointness',()=>{for(const value of ['/usr/bin/bwrap','/usr/bin/*','/**','/usr/{bin,sbin}/bwrap','<unknown>','@{HOME}/bin/tool'])assert(attachmentMayMatch(value));for(const value of ['/usr/bin/other','/usr/{lib,lib64}/other/**','/snap/**','named-profile'])assert(!attachmentMayMatch(value));});

test('trust refusal retains exact allowlisted ancestor and predicate, never arbitrary paths/messages',()=>{const st={uid:1001,gid:123,mode:0o40777,dev:1,ino:2,isSymbolicLink:()=>false,isDirectory:()=>true,isFile:()=>false};const x=projectTrustRefusal('/usr/share/apparmor/extra-profiles/bwrap-userns-restrict','/usr/share','not-group-or-other-writable',st,'parent-check');assert.equal(x.requestedClass,'packagedProfile');assert.equal(x.ancestorPath,'/usr/share');assert.equal(x.failedPredicate,'not-group-or-other-writable');assert.equal(x.observed.mode,0o777);const privateText='/private/TOKEN-CANARY';const hidden=projectTrustRefusal(privateText,privateText,'TOKEN-CANARY',st,privateText);assert(!JSON.stringify(hidden).includes('TOKEN-CANARY'));assert.equal(hidden.failedPredicate,'unknown');assert.equal(hidden.operationContext,'unknown');});
test('actual parent writable refusal preserves original code and observed metadata before throwing',()=>{const base=mkdtempSync(join(process.env.PAPERCLIP_DIAGNOSTIC_TEST_SCRATCH,'trust-'));try{const parent=join(base,'parent'),file=join(parent,'fixture');mkdirSync(parent,{mode:0o700});writeFileSync(file,'fixture',{mode:0o600});chmodSync(parent,0o777);let caught;try{trustedFile(file,65536,process.getuid());}catch(e){caught=e;}assert.equal(caught.sandboxCode,'sandbox_system_parent_unsafe');assert.equal(caught.sandboxDiagnostic.failedPredicate,'not-group-or-other-writable');assert.equal(caught.sandboxDiagnostic.observed.mode,0o777);assert(!JSON.stringify(caught.sandboxDiagnostic).includes(base));}finally{rmSync(base,{recursive:true,force:true});}});
for(const kind of ['writable-file','symlink','hardlink','missing'])test('actual parent/file trust diagnostic records '+kind,()=>{const base=mkdtempSync(join(process.env.PAPERCLIP_DIAGNOSTIC_TEST_SCRATCH,'trust-'));try{const file=join(base,'fixture');if(kind!=='missing')writeFileSync(file,'fixture',{mode:0o600});if(kind==='writable-file')chmodSync(file,0o666);if(kind==='symlink'){rmSync(file);symlinkSync(join(base,'absent'),file);}if(kind==='hardlink')linkSync(file,join(base,'alias'));let e;try{trustedFile(file,65536,process.getuid());}catch(x){e=x;}assert(e?.sandboxDiagnostic);assert.equal(e.sandboxDiagnostic.failedPredicate,{'writable-file':'not-writable-or-setid',symlink:'regular',hardlink:'single-link',missing:'absent'}[kind]);assert(!JSON.stringify(e.sandboxDiagnostic).includes(base));}finally{rmSync(base,{recursive:true,force:true});}});
test('trust diagnostic workflow cannot build, probe, load profile or qualify a native candidate',()=>{const w=readFileSync(new URL('./fixtures/native-system-trust-diagnostic.yml',import.meta.url),'utf8');assert(w.includes('timeout-minutes: 10'));assert(w.includes('--diagnose-system-trust'));assert(!w.includes('native_install:'));assert(!w.includes('qualify-native-source.mjs'));assert(!w.includes('qualify-native-install.mjs'));assert(w.includes('native-system-trust-diagnostic'));assert(w.includes('contents: read'));const code=readFileSync(new URL('./qualify-native-sandbox.mjs',import.meta.url),'utf8').split('async function diagnoseSystemTrust(){')[1].split('export function profileProvenance')[0];for(const forbidden of ['qualifyNativeSandbox(',"'--probe'",'apparmor_parser','corepack','pnpm'])assert(!code.includes(forbidden));});

test('actual parent/file trust diagnostic refuses foreign ownership with default OS owner rule',()=>{const base=mkdtempSync(join(process.env.PAPERCLIP_DIAGNOSTIC_TEST_SCRATCH,'trust-'));try{const file=join(base,'fixture');writeFileSync(file,'fixture',{mode:0o600});assert(process.getuid()>0);let e;try{trustedFile(file);}catch(x){e=x;}assert.equal(e.sandboxCode,'sandbox_system_file_unsafe');assert.equal(e.sandboxDiagnostic.failedPredicate,'owner');assert.equal(e.sandboxDiagnostic.observed.uid,process.getuid());assert(!JSON.stringify(e.sandboxDiagnostic).includes(base));}finally{rmSync(base,{recursive:true,force:true});}});
test('trust diagnostic accepts only actual normal-user Ubuntu24 identity',()=>{const os='ID=ubuntu\nVERSION_ID="24.04"\n';assert.deepEqual(diagnosticHostIdentity(1001,os),{uid:1001,os:'ubuntu',osVersion:'24.04'});assert.throws(()=>diagnosticHostIdentity(0,os),/normal_user/);for(const wrong of ['ID=debian\nVERSION_ID="24.04"\n','ID=ubuntu\nVERSION_ID="22.04"\n','ImageOS=ubuntu24'])assert.throws(()=>diagnosticHostIdentity(1001,wrong),/unsupported/);});

const authentic=()=>readFileSync(new URL('./fixtures/native-bwrap-userns-restrict',import.meta.url));

function stageFixture() {
 const source='6ce3dd9293f97d682f15f3ad6c075a558fcd9a64';
 const directory=join('/etc/apparmor.d','.paperclip-native-'+source.slice(0,12));
 const file=join(directory,'profile'),bytes=authentic(),executables=new Map(),metadata=new Map(),calls=[];
 const facts=(type,mode,extra={})=>({
  uid:0,gid:0,mode,nlink:1,size:40,dev:2049,ino:2116,
  isFile:()=>type==='file',isDirectory:()=>type==='directory',isSymbolicLink:()=>type==='symlink',
  ...extra,
 });
 for(const path of ['/usr/bin/sudo','/usr/bin/dpkg-query','/usr/bin/mkdir','/usr/bin/tee','/usr/bin/stat','/usr/bin/sha256sum','/usr/bin/install']){
  executables.set(path,Buffer.from('native fixture for '+path));
  metadata.set(path,facts('file',path==='/usr/bin/sudo'?0o4755:0o755));
  for(let parent=dirname(path);;parent=dirname(parent)){metadata.set(parent,facts('directory',0o755));if(parent==='/')break;}
 }
 for(const parent of ['/etc','/etc/apparmor.d'])metadata.set(parent,facts('directory',0o755));
 const io={
  lstat(path){if(!metadata.has(path))throw Object.assign(Error('absent'),{code:'ENOENT'});return metadata.get(path);},
  realpath:path=>path,
  read(path){assert(executables.has(path));return executables.get(path);},
 };
 const controls={owner:'sudo: /usr/bin/sudo\n'};
 function run(binary,args,input){
  calls.push([binary,...args]);
  if(binary==='/usr/bin/dpkg-query'){assert.deepEqual(args,['-S','/usr/bin/sudo']);return {ok:true,stdout:controls.owner};}
  assert.equal(binary,'/usr/bin/sudo');
  assert.equal(args[0],'-n');
  const target=args.at(-1);
  if(args[1]==='/usr/bin/mkdir'){assert.deepEqual(args,['-n','/usr/bin/mkdir','--mode=0700','--',directory]);return {ok:true};}
  if(args[1]==='/usr/bin/tee'){assert.deepEqual(args,['-n','/usr/bin/tee','--',file]);assert(input.equals(bytes));return {ok:true,stdout:bytes};}
  if(args[1]==='/usr/bin/stat'){assert(['profile',directory.split('/').at(-1)].some(name=>target.endsWith('/'+name)));return {ok:true,stdout:target===directory?'0:0:700:2:4096:2049:4242:directory':'0:0:644:1:1936:2049:4243:regular file'};}
  assert.deepEqual(args,['-n','/usr/bin/sha256sum','--',file]);
  return {ok:true,stdout:PROFILE_CONTRACT.profile.sha256+'  '+file+'\n'};
 }
 return {source,directory,file,bytes,metadata,io,controls,run,calls};
}

test('composed staging accepts the observed root-owned 04755 sudo and keeps each tool, stat and digest bound',()=>{
 const f=stageFixture();
 const stage=stageAuthenticatedProfile(f.bytes,f.source,f.run,f.io);
 assert.equal(stage.proof.executor.mode,0o4755);
 assert.equal(stage.proof.executor.path,'/usr/bin/sudo');
 assert.equal(stage.proof.executor.package,'sudo');
 assert.match(stage.proof.executor.sha256,/^[a-f0-9]{64}$/);
 assert.equal(stage.path,f.file);
 assert.equal(stage.proof.sha256,PROFILE_CONTRACT.profile.sha256);
 assert.deepEqual(f.calls.map(([command,,tool])=>command==='/usr/bin/sudo'?tool:command),[
  '/usr/bin/dpkg-query','/usr/bin/mkdir','/usr/bin/stat','/usr/bin/tee','/usr/bin/stat','/usr/bin/stat','/usr/bin/stat','/usr/bin/sha256sum',
 ]);
});
for(const [name,change] of [
 ['non-setuid sudo',f=>{f.metadata.get('/usr/bin/sudo').mode=0o755;}],
 ['group-setid sudo',f=>{f.metadata.get('/usr/bin/sudo').mode=0o6755;}],
 ['group-writable sudo',f=>{f.metadata.get('/usr/bin/sudo').mode=0o4775;}],
 ['non-root sudo group',f=>{f.metadata.get('/usr/bin/sudo').gid=1001;}],
 ['non-root sudo owner',f=>{f.metadata.get('/usr/bin/sudo').uid=1001;}],
 ['hardlinked sudo',f=>{f.metadata.get('/usr/bin/sudo').nlink=2;}],
 ['noncanonical sudo',f=>{f.io.realpath=p=>p==='/usr/bin/sudo'?'/tmp/sudo':p;}],
 ['writable ancestor',f=>{f.metadata.get('/usr/bin').mode=0o777;}],
 ['another setuid stage tool',f=>{f.metadata.get('/usr/bin/tee').mode=0o4755;}],
 ['another sudo package',f=>{f.controls.owner='other: /usr/bin/sudo\n';}],
]){
 test('composed staging refuses '+name+' before any privileged action',()=>{
  const f=stageFixture();change(f);
  assert.throws(()=>stageAuthenticatedProfile(f.bytes,f.source,f.run,f.io),/sandbox_(system_(file|parent)_unsafe|stage_sudo_package_owner)/);
  assert(f.calls.every(([command])=>command==='/usr/bin/dpkg-query'));
 });
}
test('authenticated profile accepts official bytes and rejects every changed or oversized input before privilege',()=>{assert.equal(validateAuthenticatedProfile(authentic()).length,1936);for(const bytes of [Buffer.from('unconfined'),Buffer.concat([authentic(),Buffer.from('\n')]),Buffer.from(authentic()).fill(0,1,2)])assert.throws(()=>validateAuthenticatedProfile(bytes),/authenticated_profile_mismatch/);});
test('untrusted writable ancestry may supply exact public data but never gains trusted-path status',()=>{const base=mkdtempSync(join(process.env.PAPERCLIP_DIAGNOSTIC_TEST_SCRATCH,'profile-'));try{const parent=join(base,'writable');mkdirSync(parent,{mode:0o777});chmodSync(parent,0o777);const path=join(parent,'profile');writeFileSync(path,authentic());assert(readAuthenticatedProfile(path).equals(authentic()));assert.throws(()=>trustedFile(path,65536,process.getuid()),/system_parent_unsafe/);writeFileSync(path,Buffer.from(authentic()).fill(0,0,1));assert.throws(()=>readAuthenticatedProfile(path),/authenticated_profile_mismatch/);}finally{rmSync(base,{recursive:true,force:true});}});
test('untrusted profile data refuses symlinks and hardlink aliases',()=>{const base=mkdtempSync(join(process.env.PAPERCLIP_DIAGNOSTIC_TEST_SCRATCH,'profile-'));try{const path=join(base,'profile');writeFileSync(path,authentic());linkSync(path,join(base,'alias'));assert.throws(()=>readAuthenticatedProfile(path),/untrusted_profile_identity/);symlinkSync(path,join(base,'link'));assert.throws(()=>readAuthenticatedProfile(join(base,'link')));}finally{rmSync(base,{recursive:true,force:true});}});
test('include parser retains mandatory ABI/tunables and both optional local imports, rejecting traversal and unknown syntax',()=>{assert.deepEqual(includeDirectives(authentic()),[{path:'abi/4.0',optional:false},{path:'tunables/global',optional:false},{path:'local/bwrap-userns-restrict',optional:true},{path:'local/unpriv_bwrap',optional:true}]);for(const text of ['include </tmp/x>','include <../x>','include "elsewhere"','abi <abi/@{X}>,'])assert.throws(()=>includeDirectives(Buffer.from(text)),/include_syntax_unknown/);});
test('root-sealed staging rejects writable envelopes, aliases, foreign owners and mismatched size',()=>{const dir={uid:0,gid:0,mode:0o700,type:'directory',dev:1,ino:2},file={uid:0,gid:0,mode:0o644,type:'regular file',dev:1,ino:3,nlink:1,bytes:1936};assert(validateRootStageMetadata(dir,file,PROFILE_CONTRACT.profile));for(const bad of [{...dir,uid:1001},{...dir,mode:0o777},{...dir,type:'symbolic link'}])assert.throws(()=>validateRootStageMetadata(bad,file,PROFILE_CONTRACT.profile),/root_stage_unsafe/);for(const bad of [{...file,nlink:2},{...file,mode:0o666},{...file,uid:1001},{...file,bytes:1937},{...file,type:'symbolic link'}])assert.throws(()=>validateRootStageMetadata(dir,bad,PROFILE_CONTRACT.profile),/root_stage_unsafe/);});
test('loaded-policy delta requires both exact official profile names and preserves every preexisting attachment',()=>{const base='/sys/kernel/security/apparmor/policy/profiles/',before={names:'other (enforce)\n',tree:base+'o/name:other\n'+base+'o/attach:/bin/other\n'},after={names:before.names+'bwrap (enforce)\nunpriv_bwrap (enforce)\n',tree:before.tree+base+'b/name:bwrap\n'+base+'b/attach:/usr/bin/bwrap\n'+base+'u/name:unpriv_bwrap\n'+base+'u/attach:<unknown>\n'};assert(validateLoadedProfileDelta(before,after));assert(validateLoadedProfileDelta(before,{...after,tree:after.tree.replace('u/attach:<unknown>','u/attach:unpriv_bwrap')}));for(const bad of [{...after,names:after.names.replace('unpriv_bwrap (enforce)\n','')},{...after,tree:after.tree.replace('/bin/other','/changed')},{...after,tree:after.tree.replace('/usr/bin/bwrap','/anywhere')},{...after,names:after.names+'unrelated (enforce)\n'}])assert.throws(()=>validateLoadedProfileDelta(before,bad),/unproven|changed/);});
test('fixed parser invocation disables cache and uses authenticated comment-only config with trusted etc search roots',()=>{assert.deepEqual(PROFILE_CONTRACT.parserArgs,['--config-file','/etc/apparmor/parser.conf','-K','-b','/etc/apparmor.d','-I','/etc/apparmor.d','-a','/etc/apparmor.d/bwrap-userns-restrict']);const source=readFileSync(new URL('./qualify-native-sandbox.mjs',import.meta.url),'utf8');assert(source.includes("trustedDirectory('/etc/apparmor.d',io)"));assert(source.includes("'/usr/bin/tee','--',path],bytes"));assert(!source.includes("'0644',packaged,destination"));assert(!source.includes("flags=\\(unconfined\\)"));});

test('actual root-stage verifier joins root stat and SHA replies and refuses digest or object replacement',()=>{const directory='/etc/apparmor.d/.paperclip-native-'+'a'.repeat(12),path=directory+'/profile',dir={uid:0,gid:0,mode:448,nlink:2,bytes:4096,dev:1,ino:2,type:'directory'},file={uid:0,gid:0,mode:420,nlink:1,bytes:PROFILE_CONTRACT.profile.bytes,dev:1,ino:3,type:'regular file'},stage={directory,path,dir,file};const commands=[];const replies=(change={})=>(binary,args)=>{commands.push({binary,args});assert.equal(binary,'/usr/bin/sudo');assert.equal(args[0],'-n');if(args[1]==='/usr/bin/stat'){const value={...(args.at(-1)===directory?dir:file),...(args.at(-1)===directory?change.dir:change.file)};return {ok:true,stdout:[value.uid,value.gid,value.mode.toString(8),value.nlink,value.bytes,value.dev,value.ino,value.type].join(':')};}assert.equal(args[1],'/usr/bin/sha256sum');return {ok:true,stdout:(change.hash??PROFILE_CONTRACT.profile.sha256)+'  '+path+'\n'};};assert(verifyRootStage(stage,replies()));assert.equal(commands.length,3);assert.throws(()=>verifyRootStage(stage,replies({hash:'0'.repeat(64)})),/root_stage_changed/);assert.throws(()=>verifyRootStage(stage,replies({file:{ino:4}})),/root_stage_changed/);assert.throws(()=>verifyRootStage(stage,replies({dir:{mode:511}})),/root_stage_unsafe/);});

function installedIo(){const texts=JSON.parse(readFileSync(new URL('./fixtures/native-apparmor-installed-texts.json',import.meta.url))),files=new Map(Object.entries(texts).map(([p,t])=>[p,Buffer.from(t)])),directories=new Set(['/','/etc','/etc/apparmor','/etc/apparmor.d','/etc/apparmor.d/abi',...PROFILE_CONTRACT.trustedDirectories]),changes=new Map(),reads=[];const absent=()=>{throw Object.assign(Error('absent'),{code:'ENOENT'});};return{files,directories,changes,reads,info(p){if(!files.has(p)&&!directories.has(p))return absent();return{type:directories.has(p)?'directory':'regular',uid:0,gid:0,mode:directories.has(p)?0o755:0o644,nlink:1,bytes:files.get(p)?.length??0,dev:1,ino:1,canonical:p,...changes.get(p)};},read(p){reads.push(p);if(!files.has(p))return absent();return files.get(p);},list(p){return [...files.keys(),...directories].filter(x=>x!==p&&x.slice(0,x.lastIndexOf('/'))===p).map(x=>x.slice(x.lastIndexOf('/')+1)).sort();}};}
test('the production include walker accepts the installed lifecycle including both exact generated templates',()=>{const io=installedIo(),r=inspectProfileIncludeGraph(authentic(),io);assert.equal(r.status,'passed',JSON.stringify(r));assert.equal(r.complete,true);assert.deepEqual(r.rows,PROFILE_CONTRACT.expectedIncludeClosureRows);for(const path of Object.keys(PROFILE_CONTRACT.generatedFileProvenance)){assert(io.reads.includes(path));assert.equal(r.rows.find(x=>x.path===path).sha256,PROFILE_CONTRACT.trustedFiles[path].sha256);}});
test('raw archive-only fixture reports both omitted generated files and continues later branches',()=>{const io=installedIo();for(const p of Object.keys(PROFILE_CONTRACT.generatedFileProvenance))io.files.delete(p);const r=inspectProfileIncludeGraph(authentic(),io);assert.equal(r.status,'refused');for(const p of Object.keys(PROFILE_CONTRACT.generatedFileProvenance))assert(r.issues.some(i=>i.path===p&&i.predicate==='missing_generated_or_expected_child'));assert(r.rows.some(x=>x.path==='/etc/apparmor.d/tunables/run'));assert.equal(r.complete,false);});
for(const [name,change] of [
 ['active generated home values',io=>{const p='/etc/apparmor.d/tunables/home.d/ubuntu';io.files.set(p,Buffer.concat([io.files.get(p),Buffer.from('@{HOMEDIRS}+=/unknown/\n')]));}],
 ['changed same-size generated bytes',io=>{const p='/etc/apparmor.d/tunables/home.d/ubuntu';io.files.set(p,Buffer.from(io.files.get(p)).fill(65,0,1));}],
 ['missing mandatory ABI',io=>io.files.delete('/etc/apparmor.d/abi/4.0')],
 ['foreign owner',io=>io.changes.set('/etc/apparmor.d/tunables/home',{uid:1001})],
 ['writable mode',io=>io.changes.set('/etc/apparmor.d/tunables/home',{mode:0o666})],
 ['symlink',io=>io.changes.set('/etc/apparmor.d/tunables/home',{type:'symlink',canonical:null})],
 ['hardlink',io=>io.changes.set('/etc/apparmor.d/tunables/home',{nlink:2})],
 ['canonical alias',io=>io.changes.set('/etc/apparmor.d/tunables/home',{canonical:'/elsewhere'})],
 ['writable ancestor',io=>io.changes.set('/etc/apparmor.d/tunables',{mode:0o777})],
 ['changed config',io=>io.files.set('/etc/apparmor/parser.conf',Buffer.from('Include /usr/share\n'))],
 ['unreadable bytes',io=>{const read=io.read.bind(io);io.read=p=>{if(p.endsWith('/home'))throw Error('private-canary');return read(p);};}],
 ['metadata unreadable',io=>{const info=io.info.bind(io);io.info=p=>{if(p.endsWith('/home'))throw Error('private-canary');return info(p);};}],
 ['oversized directory',io=>{const list=io.list.bind(io);io.list=p=>p.endsWith('/home.d')?Array.from({length:33},(_,i)=>'x'+i):list(p);}],
 ['unknown local include',io=>{io.files.set('/etc/apparmor.d/local/bwrap-userns-restrict',Buffer.from('unknown'));io.directories.add('/etc/apparmor.d/local');}]
])test('complete installed-graph check refuses '+name,()=>{const io=installedIo();change(io);const r=inspectProfileIncludeGraph(authentic(),io);assert.equal(r.status,'refused');assert.equal(r.complete,false);assert(r.issues.length>0);assert(!JSON.stringify(r).includes('private-canary'));});
test('multiple include mismatches retain precise context and never parse unpinned files',()=>{const io=installedIo();io.files.set('/etc/apparmor.d/tunables/home.d/unexpected',Buffer.from('include </private/secret>'));io.files.delete('/etc/apparmor.d/abi/4.0');io.files.set('/etc/apparmor.d/local/unpriv_bwrap',Buffer.from('unknown'));io.directories.add('/etc/apparmor.d/local');const r=inspectProfileIncludeGraph(authentic(),io);assert(r.issues.some(x=>x.path==='/etc/apparmor.d/tunables/home.d/unexpected'&&x.predicate==='missing_pin'&&x.parent==='/etc/apparmor.d/tunables/home.d'));assert(r.issues.some(x=>x.path==='/etc/apparmor.d/abi/4.0'));assert(r.issues.some(x=>x.path==='/etc/apparmor.d/local/unpriv_bwrap'));assert(!io.reads.includes('/etc/apparmor.d/tunables/home.d/unexpected'));assert(!JSON.stringify(r).includes('/private/secret'));assert(r.rows.some(x=>x.path==='/etc/apparmor.d/tunables/run'));});
test('graph node and issue caps refuse explicitly instead of truncating into success',()=>{const io=installedIo();for(const parent of ['home.d','multiarch.d','xdg-user-dirs.d'])for(let i=0;i<30;i++)io.files.set('/etc/apparmor.d/tunables/'+parent+'/x'+i,Buffer.from('unknown'));const r=inspectProfileIncludeGraph(authentic(),io);assert.equal(r.status,'refused');assert.equal(r.complete,false);assert(r.issues.length<=64);assert(Buffer.byteLength(JSON.stringify(r))<=65536);});
test('a failing diagnostic writer cannot replace the original include failure or leak raw errors',()=>{const original=Object.assign(Error('original-private-canary'),{sandboxCode:'sandbox_include_closure_refused'});let emergency;assert.throws(()=>preserveSandboxFailure(original,()=>{throw Error('writer-private-canary');},r=>{emergency=r;}),e=>e===original);assert.equal(emergency.failureCode,'sandbox_include_closure_refused');assert.equal(emergency.reportingUnavailable,true);assert(!JSON.stringify(emergency).includes('private-canary'));assert.throws(()=>preserveSandboxFailure(original,()=>{throw Error('write');},()=>{throw Error('fallback');}),e=>e===original);});

test('unsafe include names are hashed in both mismatch paths and directory inventories',()=>{const io=installedIo(),name='ghp_PRIVATE_CANARY';io.files.set('/etc/apparmor.d/tunables/home.d/'+name,Buffer.from('not read'));const result=inspectProfileIncludeGraph(authentic(),io),text=JSON.stringify(result);assert.equal(result.status,'refused');assert(!text.includes(name));assert(result.issues.some(x=>x.pathSha256&&x.predicate==='missing_pin'));});
