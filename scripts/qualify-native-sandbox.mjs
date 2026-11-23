#!/usr/bin/env node
/** Disposable Ubuntu source-job prerequisite; never a production permission grant. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync,existsSync,writeFileSync,mkdirSync,mkdtempSync,openSync,readSync,closeSync,fstatSync,readdirSync,constants} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import net from 'node:net';
import {release as kernelRelease} from 'node:os';
const SELF=fileURLToPath(import.meta.url),MAX=65536;
export const PROFILE_CONTRACT=Object.freeze(JSON.parse(readFileSync(new URL('./native-sandbox-profile-contract.json',import.meta.url),'utf8')));
export const SANDBOX_LIMITS=Object.freeze({aggregateMs:600000,aptMs:300000,profileMs:60000,probeMs:15000,outputBytes:MAX});
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{sandboxCode:code});};
export function namespaceRefusal(text){return /bwrap: (?:No permissions to creat(?:e|ing) new namespace|Creating new namespace failed: Operation not permitted)(?:[.,\n]|$)/.test(text);}
export function validateSandboxHost(f){
 if(f.os!=='ubuntu'||f.release!=='24.04'||!Number.isSafeInteger(f.uid)||f.uid<=0)fail('sandbox_host_unsupported');
 if(f.bwrapPresent&&(!f.bwrapTrusted||!f.bwrapPackageOwned))fail('sandbox_bwrap_identity_refused');
 return f;
}
export function sandboxRepairDecision(f,initial){
 validateSandboxHost(f);
 if(initial==='passed'&&f.bwrapPresent)return 'none';
 if(!f.bwrapPresent)return 'install-distro-prerequisites';
 if(initial!=='namespace_denied'||f.apparmor!==true||f.restrictedUserns!==1||f.maxUserNamespaces<=0||f.usernsClone===0||f.seccomp!==0)fail('sandbox_host_policy_unclassified');
 return 'documented-profile-prerequisite';
}
export function profileLoadDecision({packagedVerified,destination,loaded,localOverride}){
 if(!packagedVerified||localOverride||loaded!=='absent'||!['absent','same-package-bytes'].includes(destination))fail('sandbox_profile_policy_conflict');
 return destination==='absent'?'install-and-load':'load';
}

/** Conservative AARE disjointness: only finite brace alternatives and a
 * literal prefix can prove that an attachment cannot match our executable. */
export function attachmentMayMatch(value,target='/usr/bin/bwrap'){
 if(value==='<unknown>'||value.length>4096||/[\\\n\r@]/.test(value))return true;
 let values=[value];for(let i=0;i<8;i++){let changed=false;const next=[];for(const v of values){const m=v.match(/\{([^{}]+)\}/);if(!m){next.push(v);continue;}changed=true;for(const part of m[1].split(','))next.push(v.slice(0,m.index)+part+v.slice(m.index+m[0].length));}values=next;if(values.length>64)return true;if(!changed)break;}
 return values.some(v=>{if(/[{}]/.test(v))return true;const prefix=v.split(/[?*\[]/,1)[0];return prefix===v?v===target:target.startsWith(prefix);});
}
export function inspectLoadedAttachments(loaded,tree,targetName){
 if(Buffer.byteLength(loaded)+Buffer.byteLength(tree)>MAX)fail('sandbox_policy_inventory_bound');
 const lines=loaded.trim()?loaded.trim().split('\n'):[],rows=new Map();let conflict=lines.some(line=>line.startsWith(targetName+' '));
 if(lines.length>256||new Set(lines).size!==lines.length||!lines.every(line=>/ \((?:enforce|complain|unconfined|kill|prompt)\)$/.test(line)))fail('sandbox_loaded_policy_unknown');
 for(const line of tree.split('\n').filter(Boolean)){const m=line.match(/^\/sys\/kernel\/security\/apparmor\/policy\/profiles\/(.+)\/(name|attach):(.*)$/);if(!m)fail('sandbox_loaded_attachments_unknown');const row=rows.get(m[1])??{};if(Object.hasOwn(row,m[2]))fail('sandbox_loaded_attachments_duplicate');row[m[2]]=m[3];rows.set(m[1],row);}
 if(rows.size!==lines.length)fail('sandbox_loaded_attachments_incomplete');
 for(const row of rows.values()){if(!Object.hasOwn(row,'name')||!Object.hasOwn(row,'attach'))fail('sandbox_loaded_attachments_incomplete');if(row.name===targetName||attachmentMayMatch(row.attach))conflict=true;}
 return {conflict,profiles:rows.size};
}
export function validateProbeReceipt(r){
 if(r?.schema!=='paperclip.native-sandbox-probe.v1'||!Number.isSafeInteger(r.uid)||r.uid<=0||r.codexVersion!=='0.160.0'||r.bwrapPath!=='/usr/bin/bwrap'||!['wrapperSha256','nativeElfSha256','bwrapSha256'].every(k=>/^[a-f0-9]{64}$/.test(r[k]??''))||!['nativeSandbox','allowedRead','scratchWrite','candidateDenied','referenceDenied','protectedDenied','protectedReadDenied','metadataDenied','outsideDenied','networkDenied','outsideNetworkControl','originalBytesPreserved'].every(k=>r[k]===true))fail('sandbox_native_probe_incomplete');
 return r;
}
function safeEnv(home){return {PATH:'/usr/bin:/bin:/usr/sbin',HOME:home,LANG:'C',LC_ALL:'C',DEBIAN_FRONTEND:'noninteractive'};}
function runner(deadline,home){return (binary,args,ms=15000,input)=>{
 const effective=Math.min(ms,deadline-Date.now());if(effective<=1000)fail('sandbox_prerequisite_deadline');trustedFile('/usr/bin/timeout',1024*1024);
 const seconds=((effective-1000)/1000).toFixed(3)+'s',privileged=binary==='/usr/bin/sudo';
 if(privileged&&args[0]!=='-n')fail('sandbox_privileged_command_refused');
 // GNU timeout creates a process group and sends KILL to the whole group.
 // Its deadline precedes Node's final KILL backstop; sudo-owned apt children
 // are bounded by the root-owned timeout, not a normal user's signal rights.
 const command=privileged?binary:'/usr/bin/timeout',argv=privileged?['-n','/usr/bin/timeout','--signal=KILL',seconds,...args.slice(1)]:['--signal=KILL',seconds,binary,...args];
 const r=spawnSync(command,argv,{...(input===undefined?{}:{input}),env:safeEnv(home),encoding:'utf8',timeout:effective,killSignal:'SIGKILL',maxBuffer:MAX/2,shell:false});
 const out=String(r.stdout??'')+'\n'+String(r.stderr??'');if(Buffer.byteLength(out)>MAX)fail('sandbox_command_output_bound');
 return {ok:!r.error&&!r.signal&&r.status===0,stdout:String(r.stdout??''),namespaceDenied:namespaceRefusal(out),exit:Number.isInteger(r.status)?r.status:null,signal:r.signal??null,outputSha256:hash(out)};
 };}
const SYSTEM_FILES=Object.freeze({distroBwrap:'/usr/bin/bwrap',systemTimeout:'/usr/bin/timeout',packagedProfile:'/usr/share/apparmor/extra-profiles/bwrap-userns-restrict',destinationProfile:'/etc/apparmor.d/bwrap-userns-restrict'});
const SYSTEM_ANCESTORS=new Set(['/',...Object.values(SYSTEM_FILES).flatMap(file=>{const a=[];for(let p=dirname(file);;p=dirname(p)){a.push(p);if(p==='/')break;}return a;})]);
export function projectTrustRefusal(requested,ancestor,predicate,st,context='file-check'){
 const entry=Object.entries(SYSTEM_FILES).find(([,path])=>path===requested),allowed=entry&&(ancestor===requested||(SYSTEM_ANCESTORS.has(ancestor)&&(ancestor==='/'||requested.startsWith(ancestor+'/'))));
 return {schema:'paperclip.system-trust-refusal.v1',operationContext:['file-check','parent-check'].includes(context)?context:'unknown',requestedClass:entry?.[0]??'unlisted',...(entry?{requestedPath:requested}:{requestedPathSha256:hash(requested)}),...(allowed?{ancestorPath:ancestor}:{ancestorPathSha256:hash(ancestor)}),failedPredicate:['regular','not-symlink','owner','not-writable-or-setid','single-link','bounded','canonical','directory','not-group-or-other-writable','absent','metadata-unreadable'].includes(predicate)?predicate:'unknown',observed:st?{type:st.isSymbolicLink()?'symlink':st.isDirectory()?'directory':st.isFile()?'regular':'other',uid:st.uid,gid:st.gid,mode:st.mode&0o7777,dev:st.dev,ino:st.ino}:null};
}
export function trustedFile(path,limit=MAX,expectedUid=0){
 const refuse=(code,at,predicate,st,context)=>{const e=Object.assign(new Error(code),{sandboxCode:code,sandboxDiagnostic:projectTrustRefusal(path,at,predicate,st,context)});throw e;};
 let st;try{st=lstatSync(path);}catch(e){refuse('sandbox_system_metadata_unavailable',path,e.code==='ENOENT'?'absent':'metadata-unreadable',null,'file-check');}for(const [name,ok]of [['regular',st.isFile()],['not-symlink',!st.isSymbolicLink()],['owner',st.uid===expectedUid],['not-writable-or-setid',(st.mode&0o6022)===0],['single-link',st.nlink===1],['bounded',st.size<=limit]])if(!ok)refuse('sandbox_system_file_unsafe',path,name,st,'file-check');
 let canonical;try{canonical=realpathSync(path);}catch{refuse('sandbox_system_metadata_unavailable',path,'metadata-unreadable',st,'file-check');}if(canonical!==path)refuse('sandbox_system_file_unsafe',path,'canonical',st,'file-check');
 for(let p=dirname(path);;p=dirname(p)){let st;try{st=lstatSync(p);}catch(e){refuse('sandbox_system_metadata_unavailable',p,e.code==='ENOENT'?'absent':'metadata-unreadable',null,'parent-check');}for(const [name,ok]of [['directory',st.isDirectory()],['not-symlink',!st.isSymbolicLink()],['owner',st.uid===expectedUid],['not-group-or-other-writable',(st.mode&0o022)===0]])if(!ok)refuse('sandbox_system_parent_unsafe',p,name,st,'parent-check');if(p==='/')break;}
 return readFileSync(path);
}
export function snapshotSystemTrust(){
 return Object.entries(SYSTEM_FILES).map(([requestedClass,path])=>{const chain=[];for(let at=path;;at=dirname(at)){try{const st=lstatSync(at);chain.push({path:at,type:st.isSymbolicLink()?'symlink':st.isDirectory()?'directory':st.isFile()?'regular':'other',uid:st.uid,gid:st.gid,mode:st.mode&0o7777,dev:st.dev,ino:st.ino});}catch(e){chain.push({path:at,state:e.code==='ENOENT'?'absent':'unreadable'});}if(at==='/')break;}try{trustedFile(path,16*1024**2);return {requestedClass,path,chain,guard:'accepted'};}catch(e){return {requestedClass,path,chain,guard:'refused',failureCode:e.sandboxCode??(e.code==='ENOENT'?'file_absent':'metadata_unavailable'),...(e.sandboxDiagnostic?{refusal:e.sandboxDiagnostic}:{})};}});
}
export function diagnosticHostIdentity(uid,raw){
 if(!Number.isSafeInteger(uid)||uid<=0)fail('diagnostic_normal_user_required');if(Buffer.byteLength(raw)>65536)fail('diagnostic_host_unsupported');const value=k=>{const line=raw.split('\n').find(x=>x.startsWith(k+'='));return line?.slice(k.length+1).replace(/^"(.*)"$/,'$1');};if(value('ID')!=='ubuntu'||value('VERSION_ID')!=='24.04')fail('diagnostic_host_unsupported');return {uid,os:'ubuntu',osVersion:'24.04'};
}
async function diagnoseSystemTrust(){
 hosted(process.env);diagnosticHostIdentity(process.getuid(),readFileSync('/etc/os-release','utf8'));const root=realpathSync(process.env.RUNNER_TEMP),out=join(root,'native-system-trust-diagnostic.json');if(existsSync(out))fail('diagnostic_destination_exists');
 const evidence={schema:'paperclip.system-trust-diagnostic.v1',authority:'DIAGNOSTIC_ONLY_NOT_QUALIFICATION',source:process.env.SOURCE_SHA,status:'running',retry:false,normalUid:process.getuid(),os:'ubuntu',osVersion:'24.04',kernel:/^[A-Za-z0-9_.+\-]{1,128}$/.test(kernelRelease())?kernelRelease():null,imageOS:/^[A-Za-z0-9_.-]{1,80}$/.test(process.env.ImageOS??'')?process.env.ImageOS:null,imageVersion:/^[A-Za-z0-9_.-]{1,80}$/.test(process.env.ImageVersion??'')?process.env.ImageVersion:null,before:snapshotSystemTrust(),operations:[],profileLoaded:false,nativeProbeRun:false,sourceBuilt:false,appInstalled:false};
 const save=()=>{const raw=JSON.stringify(evidence,null,2)+'\n';if(Buffer.byteLength(raw)>MAX)fail('diagnostic_evidence_bound');writeFileSync(out,raw,{mode:0o600});};save();
 try{const deadline=Date.now()+300000,run=runner(deadline,root);for(const args of [['update','-qq'],['install','-y','-qq','--no-install-recommends','bubblewrap','apparmor-profiles','apparmor-utils']]){const r=run('/usr/bin/sudo',['-n','/usr/bin/apt-get',...args],Math.max(1,deadline-Date.now()));if(!r.ok)fail('diagnostic_distro_acquisition_failed');evidence.operations.push(args[0]==='update'?'signed-distro-index':'named-distro-prerequisites');save();}evidence.after=snapshotSystemTrust();evidence.status='diagnostic-completed';}
 catch(e){evidence.status='diagnostic-stopped';evidence.failureCode=e.sandboxCode??'diagnostic_refused';if(e.sandboxDiagnostic)evidence.refusal=e.sandboxDiagnostic;evidence.after=snapshotSystemTrust();process.exitCode=1;}
 finally{evidence.finishedAt=new Date().toISOString();save();console.log(JSON.stringify(evidence));}
}

export function profileProvenance(){const p=PROFILE_CONTRACT;return {schema:p.schema,keyFingerprint:p.keyFingerprint,releaseSha256:p.releaseSha256,releaseSignatureSha256:p.releaseSignatureSha256,packagesIndexSha256:p.packagesIndexSha256,package:p.package,apparmorPackage:p.apparmorPackage,profile:p.profile};}
export function validateAuthenticatedProfile(bytes){if(!Buffer.isBuffer(bytes)||bytes.length!==PROFILE_CONTRACT.profile.bytes||hash(bytes)!==PROFILE_CONTRACT.profile.sha256)fail('sandbox_authenticated_profile_mismatch');return bytes;}
export function readAuthenticatedProfile(path){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const a=fstatSync(fd),named=lstatSync(path);if(!a.isFile()||a.nlink!==1||a.size!==PROFILE_CONTRACT.profile.bytes||a.dev!==named.dev||a.ino!==named.ino||named.isSymbolicLink())fail('sandbox_untrusted_profile_identity');const bytes=Buffer.alloc(a.size+1);let n=0;for(;;){const count=readSync(fd,bytes,n,bytes.length-n,null);n+=count;if(count===0||n===bytes.length)break;}const b=fstatSync(fd),last=lstatSync(path);if(n!==a.size||['dev','ino','size','mtimeMs','ctimeMs'].some(k=>a[k]!==b[k]||b[k]!==last[k])||last.nlink!==1||!last.isFile()||last.isSymbolicLink())fail('sandbox_untrusted_profile_changed');return validateAuthenticatedProfile(bytes.subarray(0,n));}finally{closeSync(fd);}
}
function trustedDirectory(path){for(let p=path;;p=dirname(p)){const st=lstatSync(p);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o022)!==0||realpathSync(p)!==p)fail('sandbox_include_directory_unsafe');if(p==='/')break;}return lstatSync(path);}
export function includeDirectives(raw){
 const rows=[];for(const line of raw.toString('utf8').split('\n')){if(!/^\s*(?:#\s*)?(?:include|abi)\b/.test(line))continue;const m=line.match(/^\s*(?:#\s*)?(include(?:\s+if\s+exists)?|abi)\s+<([A-Za-z0-9_./-]+)>\s*,?\s*(?:#.*)?$/);if(!m||m[2].split('/').some(x=>x==='..'||x==='.'||!x))fail('sandbox_include_syntax_unknown');rows.push({path:m[2],optional:m[1].includes('if exists')});}return rows;
}
const includeFact=st=>({type:st.isSymbolicLink()?'symlink':st.isDirectory()?'directory':st.isFile()?'regular':'other',uid:st.uid,gid:st.gid,mode:st.mode&0o7777,nlink:st.nlink,bytes:st.size,dev:st.dev,ino:st.ino});
const SYSTEM_INCLUDE_IO=Object.freeze({info(path){const st=lstatSync(path);return {...includeFact(st),canonical:st.isSymbolicLink()?null:realpathSync(path)};},read:path=>trustedFile(path,65536),list:path=>readdirSync(path).sort()});
const publicIncludePath=path=>path===PROFILE_CONTRACT.parserConfig||path==='/usr/sbin/apparmor_parser'||path===PROFILE_CONTRACT.includeRoot||path.startsWith(PROFILE_CONTRACT.includeRoot+'/')&&path.split('/').every(n=>/^[A-Za-z0-9_.-]{0,80}$/.test(n))&&!/(?:github_pat_|ghp_|Bearer|password|token|secret)/i.test(path);
/** Shared traversal/fact validation. IO adapters are data-only test facilities;
 * production admission ALWAYS uses the fixed SYSTEM_INCLUDE_IO wrapper below. */
export function inspectProfileIncludeGraph(profile,io){
 validateAuthenticatedProfile(profile);const root=PROFILE_CONTRACT.includeRoot,rows=[],issues=[],seen=new Set(),active=new Set();let total=0,nodes=0,truncated=false;
 const report=(path,predicate,context,meta=null,extra={})=>{if(issues.length>=64){truncated=true;return;}const safe=publicIncludePath(path);issues.push({...(safe?{path}:{pathSha256:hash(path)}),predicate,parent:context?.parent&&(context.parent==='authenticated-profile'||publicIncludePath(context.parent))?context.parent:null,directive:context?.directive??null,optional:context?.optional??false,observed:meta?Object.fromEntries(['type','uid','gid','mode','nlink','bytes','dev','ino'].map(k=>[k,meta[k]??null])):null,...extra});};
 const safeInfo=(path,context)=>{try{return io.info(path);}catch(e){if(e.code==='ENOENT')return null;report(path,'metadata_unreadable',context);return undefined;}};
 const directory=(path,context)=>{for(let at=path;;at=dirname(at)){const st=safeInfo(at,context);if(!st||st.type!=='directory'||st.uid!==0||(st.mode&0o022)!==0||st.canonical!==at){report(path,'unsafe_ancestor',context,st??null,{ancestor:publicIncludePath(at)||['/','/etc','/usr','/usr/sbin'].includes(at)?at:null});return false;}if(at==='/')return true;}};
 const file=(path,context,st)=>{const pin=PROFILE_CONTRACT.trustedFiles[path];if(!pin){report(path,'missing_pin',context,st,{hashState:'not_read_unpinned'});return null;}if(!st||st.type!=='regular'||st.uid!==0||(st.mode&0o6022)!==0||st.nlink!==1||st.canonical!==path||st.bytes!==pin.bytes||st.bytes>65536||!directory(dirname(path),context)){report(path,'unsafe_file_or_size',context,st);return null;}let bytes;try{bytes=io.read(path);}catch{report(path,'read_or_identity_refused',context,st);return null;}if(!Buffer.isBuffer(bytes)||bytes.length!==pin.bytes||hash(bytes)!==pin.sha256){report(path,'changed_pinned_bytes',context,st,{sha256:Buffer.isBuffer(bytes)?hash(bytes):null});return null;}total+=bytes.length;if(total>262144){report(path,'total_byte_bound',context,st);return null;}rows.push({path,type:'file',bytes:bytes.length,sha256:hash(bytes)});return bytes;};
 const walk=(path,context,depth)=>{if(++nodes>64||issues.length>=64){report(root,'node_or_issue_bound',context);return;}if(depth>16||active.has(path)){report(path,'depth_or_cycle',context);return;}if(seen.has(path))return;seen.add(path);const st=safeInfo(path,context);if(st===undefined)return;if(st===null){if(!context.optional){report(path,'missing_required',context);return;}let parent=dirname(path),info;while((info=safeInfo(parent,context))===null&&parent!=='/')parent=dirname(parent);if(!directory(parent,context))return;rows.push({path,type:'absent'});return;}active.add(path);if(st.type==='directory'){
  if(!directory(path,context)){active.delete(path);return;}if(!PROFILE_CONTRACT.trustedDirectories.includes(path)){report(path,'directory_unpinned',context,st);active.delete(path);return;}let names;try{names=io.list(path);}catch{report(path,'directory_unreadable',context,st);active.delete(path);return;}if(!Array.isArray(names)||names.length>32||names.some(n=>typeof n!=='string'||!/^[A-Za-z0-9_.-]{1,80}$/.test(n)||n.startsWith('.'))){report(path,'directory_name_or_count_bound',context,st);active.delete(path);return;}names=[...names].sort();if(new Set(names).size!==names.length){report(path,'duplicate_directory_entry',context,st);active.delete(path);return;}rows.push({path,type:'directory',names:names.map(n=>publicIncludePath(join(path,n))?n:'sha256:'+hash(n))});const expected=PROFILE_CONTRACT.expectedIncludeClosureRows.find(r=>r.path===path&&r.type==='directory')?.names??[];for(const name of expected)if(!names.includes(name))report(join(path,name),'missing_generated_or_expected_child',{parent:path,directive:'directory member',optional:false});for(const name of names)walk(join(path,name),{parent:path,directive:'directory member',optional:false},depth+1);
 }else{const bytes=file(path,context,st);if(bytes){let directives;try{directives=includeDirectives(bytes);}catch{report(path,'include_syntax_unknown',context,st);directives=[];}for(const row of directives)walk(join(root,row.path),{parent:path,directive:row.path,optional:row.optional},depth+1);}}active.delete(path);};
 const config=PROFILE_CONTRACT.parserConfig,cs=safeInfo(config,{parent:null,optional:false});const configBytes=cs&&file(config,{parent:null,optional:false},cs);if(!cs)report(config,'missing_parser_config',{parent:null,optional:false});if(configBytes&&configBytes.toString().split('\n').some(x=>x.trim()&&!x.trimStart().startsWith('#')))report(config,'active_parser_config',{parent:null,optional:false},cs);
 if(directory(root,{parent:null,optional:false}))for(const row of includeDirectives(profile))walk(join(root,row.path),{parent:'authenticated-profile',directive:row.path,optional:row.optional},0);
 if(!issues.length&&JSON.stringify(rows)!==JSON.stringify(PROFILE_CONTRACT.expectedIncludeClosureRows))report(root,'closure_changed',{parent:'authenticated-profile',optional:false});
 let result={schema:'paperclip.profile-include-inspection.v1',authority:'DATA_ONLY_NOT_RUNTIME_PROOF',status:issues.length?'refused':'passed',complete:issues.length===0&&!truncated,truncated,rows,issues,totalBytes:total};if(Buffer.byteLength(JSON.stringify(result))>MAX)result={schema:result.schema,authority:result.authority,status:'refused',complete:false,rows:[],issues:[{predicate:'report_bound'}],totalBytes:total};return result;
}
export function verifyProfileIncludeClosure(profile){
 const path='/usr/sbin/apparmor_parser',parserPin=PROFILE_CONTRACT.trustedFiles[path];let parser=null,parserError=null;
 try{parser=trustedFile(path,2*1024**2);if(parser.length!==parserPin.bytes||hash(parser)!==parserPin.sha256)fail('sandbox_parser_unpinned');}catch(error){parserError=error;}
 const result=inspectProfileIncludeGraph(profile,SYSTEM_INCLUDE_IO);
 if(parserError){result.status='refused';result.complete=false;result.parserFailure={path,code:parserError.sandboxCode??'sandbox_parser_unpinned',expected:parserPin,observed:parser?{bytes:parser.length,sha256:hash(parser)}:null,...(parserError.sandboxDiagnostic?{trustRefusal:parserError.sandboxDiagnostic}:{})};}
 if(Buffer.byteLength(JSON.stringify(result))>MAX){result.rows=[];result.truncated=true;result.complete=false;result.status='refused';result.issues=result.issues.slice(0,63).concat([{predicate:'report_bound'}]);}
 if(result.status!=='passed'){const error=parserError??Object.assign(new Error('sandbox_include_closure_refused'),{sandboxCode:'sandbox_include_closure_refused'});error.sandboxDiagnostic=result;throw error;}
 return {schema:'paperclip.profile-include-closure.v1',includeRoot:PROFILE_CONTRACT.includeRoot,parserSha256:hash(parser),parserConfigSha256:PROFILE_CONTRACT.trustedFiles[PROFILE_CONTRACT.parserConfig].sha256,cacheDisabled:true,rows:result.rows};
}
export function preserveSandboxFailure(error,persist,emergency){try{persist();}catch{try{emergency?.({schema:'paperclip.sandbox-reporting-failure.v1',failureCode:error.sandboxCode??'sandbox_prerequisite_refused',reportingUnavailable:true});}catch{}}throw error;}
function rootMetadata(path,run){const r=run('/usr/bin/sudo',['-n','/usr/bin/stat','--printf=%u:%g:%a:%h:%s:%d:%i:%F','--',path]);if(!r.ok)fail('sandbox_root_stage_metadata');const v=r.stdout.split(':');if(v.length!==8||!v.slice(0,7).every(x=>/^[0-9]+$/.test(x)))fail('sandbox_root_stage_metadata');return {uid:Number(v[0]),gid:Number(v[1]),mode:parseInt(v[2],8),nlink:Number(v[3]),bytes:Number(v[4]),dev:Number(v[5]),ino:Number(v[6]),type:v[7]};}
export function validateRootStageMetadata(dir,file,expected){if(dir.uid!==0||dir.gid!==0||dir.mode!==0o700||dir.type!=='directory'||file.uid!==0||file.gid!==0||(file.mode&0o6022)!==0||file.type!=='regular file'||file.nlink!==1||file.bytes!==expected.bytes||!Number.isSafeInteger(dir.ino)||!Number.isSafeInteger(file.ino)||dir.ino<=0||file.ino<=0)fail('sandbox_root_stage_unsafe');return true;}
export function verifyRootStage(stage,run){const dir=rootMetadata(stage.directory,run),file=rootMetadata(stage.path,run),r=run('/usr/bin/sudo',['-n','/usr/bin/sha256sum','--',stage.path]);validateRootStageMetadata(dir,file,PROFILE_CONTRACT.profile);if(!r.ok||r.stdout!==PROFILE_CONTRACT.profile.sha256+'  '+stage.path+'\n'||['dev','ino','mode','uid','gid'].some(k=>dir[k]!==stage.dir[k]||file[k]!==stage.file[k]))fail('sandbox_root_stage_changed');return true;}
export function stageAuthenticatedProfile(bytes,source,run){
 validateAuthenticatedProfile(bytes);if(!/^[a-f0-9]{40}$/.test(source??''))fail('sandbox_stage_source_invalid');trustedDirectory('/etc/apparmor.d');const directory='/etc/apparmor.d/.paperclip-native-'+source.slice(0,12),path=directory+'/profile';try{lstatSync(directory);fail('sandbox_root_stage_exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 for(const binary of ['/usr/bin/sudo','/usr/bin/mkdir','/usr/bin/tee','/usr/bin/stat','/usr/bin/sha256sum','/usr/bin/install'])trustedFile(binary,16*1024**2);
 let r=run('/usr/bin/sudo',['-n','/usr/bin/mkdir','--mode=0700','--',directory]);if(!r.ok)fail('sandbox_root_stage_create');const dir=rootMetadata(directory,run);if(dir.uid!==0||dir.gid!==0||dir.mode!==0o700||dir.type!=='directory')fail('sandbox_root_stage_unsafe');
 r=run('/usr/bin/sudo',['-n','/usr/bin/tee','--',path],bytes);if(!r.ok||!Buffer.from(r.stdout).equals(bytes))fail('sandbox_root_stage_write');const file=rootMetadata(path,run);validateRootStageMetadata(dir,file,PROFILE_CONTRACT.profile);const stage={directory,path,dir,file};verifyRootStage(stage,run);stage.proof={schema:'paperclip.authenticated-root-profile-stage.v1',directory,path,dir,file,sha256:hash(bytes),exclusiveDirectory:true,inputAuthenticated:true,rootDigestVerified:true,identityBookends:true};return stage;
}
function readLoadedPolicy(run){const a=run('/usr/bin/sudo',['-n','/usr/bin/cat','/sys/kernel/security/apparmor/profiles']),tree=run('/usr/bin/sudo',['-n','/usr/bin/find','/sys/kernel/security/apparmor/policy/profiles','-type','f','(','-name','name','-o','-name','attach',')','-exec','/usr/bin/grep','-H','^','{}','+']),b=run('/usr/bin/sudo',['-n','/usr/bin/cat','/sys/kernel/security/apparmor/profiles']);if(!a.ok||!tree.ok||!b.ok||a.stdout!==b.stdout)fail('sandbox_loaded_policy_unknown');return {names:a.stdout,tree:tree.stdout};}
export function validateLoadedProfileDelta(before,after){
 const lines=x=>x.trim().split('\n').filter(Boolean),old=lines(before.names).sort(),now=lines(after.names),added=now.filter(x=>!old.includes(x));if(added.length!==2||!PROFILE_CONTRACT.profileNames.every(n=>added.includes(n+' (enforce)'))||old.some(x=>!now.includes(x)))fail('sandbox_profile_load_unproven');
 const parse=text=>{const rows=new Map();for(const line of text.trim().split('\n').filter(Boolean)){const m=line.match(/^\/sys\/kernel\/security\/apparmor\/policy\/profiles\/(.+)\/(name|attach):(.*)$/);if(!m)fail('sandbox_loaded_attachments_unknown');const row=rows.get(m[1])??{};if(Object.hasOwn(row,m[2]))fail('sandbox_loaded_attachments_duplicate');row[m[2]]=m[3];rows.set(m[1],row);}return rows;};
 const a=parse(before.tree),b=parse(after.tree);if(b.size!==a.size+2||b.size!==now.length)fail('sandbox_profile_load_unproven');for(const [id,row]of a)if(JSON.stringify(b.get(id))!==JSON.stringify(row))fail('sandbox_loaded_policy_changed');const extra=[...b].filter(([id])=>!a.has(id)).map(([,row])=>row);if(!extra.some(x=>x.name==='bwrap'&&x.attach==='/usr/bin/bwrap')||!extra.some(x=>x.name==='unpriv_bwrap'&&['','<unknown>','unpriv_bwrap'].includes(x.attach)))fail('sandbox_profile_load_unproven');return true;
}

function nativeElfDigest(path){
 const fd=openSync(path,'r');try{const before=fstatSync(fd),digest=createHash('sha256'),chunk=Buffer.alloc(1024*1024);if(!before.isFile()||before.size<4||before.size>512*1024**2)fail('sandbox_codex_elf_bound');let offset=0;for(;;){const n=readSync(fd,chunk,0,chunk.length,null);if(!n)break;if(offset===0&&!chunk.subarray(0,4).equals(Buffer.from([127,69,76,70])))fail('sandbox_codex_elf_required');offset+=n;digest.update(chunk.subarray(0,n));}const after=fstatSync(fd);if(offset!==before.size||after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs)fail('sandbox_codex_elf_changed');return digest.digest('hex');}finally{closeSync(fd);}
}
function optional(path){try{return readFileSync(path,'utf8').trim();}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function number(path){const v=optional(path);if(v===null)return null;if(!/^\d+$/.test(v))fail('sandbox_host_fact_invalid');return Number(v);}
export function collectHostFacts(run){
 const os=readFileSync('/etc/os-release','utf8'),value=k=>os.match(new RegExp('^'+k+'="?([^"\\n]+)"?$','m'))?.[1];
 const bwrapPresent=existsSync('/usr/bin/bwrap');let bwrapTrusted=false,bwrapPackageOwned=false,bwrapSha256=null,bwrapVersion=null,bwrapPackageVersion=null,bwrapMode=null;
 if(bwrapPresent){const raw=trustedFile('/usr/bin/bwrap',16*1024**2);bwrapTrusted=true;bwrapSha256=hash(raw);const p=run('/usr/bin/dpkg-query',['-S','/usr/bin/bwrap']),v=run('/usr/bin/dpkg-query',['-W','-f=${Version}','bubblewrap']),integrity=run('/usr/bin/dpkg',['--verify','bubblewrap']),version=run('/usr/bin/bwrap',['--version']);bwrapPackageOwned=p.ok&&p.stdout.trim()==='bubblewrap: /usr/bin/bwrap'&&v.ok&&integrity.ok&&!integrity.stdout.trim()&&version.ok;bwrapVersion=version.stdout.trim().match(/^bubblewrap ([0-9][0-9A-Za-z.+~-]*)$/)?.[1]??null;bwrapPackageVersion=v.stdout.trim();bwrapMode=lstatSync('/usr/bin/bwrap').mode&0o7777;if(!bwrapVersion||!/^\d[0-9A-Za-z.+:~\-]*$/.test(bwrapPackageVersion))fail('sandbox_bwrap_version_invalid');}
 const status=readFileSync('/proc/self/status','utf8');
 return validateSandboxHost({os:value('ID'),release:value('VERSION_ID'),uid:process.getuid(),bwrapPresent,bwrapTrusted,bwrapPackageOwned,bwrapSha256,bwrapVersion,bwrapPackageVersion,bwrapMode,apparmor:optional('/sys/module/apparmor/parameters/enabled')==='Y',restrictedUserns:number('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'),maxUserNamespaces:number('/proc/sys/user/max_user_namespaces'),usernsClone:number('/proc/sys/kernel/unprivileged_userns_clone'),seccomp:Number(status.match(/^Seccomp:\s+(\d+)$/m)?.[1]??-1)});
}
function hosted(e){if(process.platform!=='linux'||process.arch!=='x64'||e.GITHUB_REPOSITORY!=='mmdaaboul/paperclip'||e.GITHUB_JOB!=='selected_native_source'||e.GITHUB_ACTIONS!=='true'||e.RUNNER_ENVIRONMENT!=='github-hosted')fail('sandbox_disposable_job_only');}
export async function qualifyNativeSandbox({workspace,root,ambient=process.env,onReceipt=()=>{}}){
 hosted(ambient);const deadline=Date.now()+SANDBOX_LIMITS.aggregateMs,run=runner(deadline,root);
 const receipt={schema:'paperclip.native-sandbox-prerequisite.v1',status:'running',normalUser:true,retry:false,productionPolicyChanged:false,globalRestrictionChanged:false,initialProbe:null,postProbe:null,operations:[]};
 const save=()=>{assert(Buffer.byteLength(JSON.stringify(receipt))<=MAX);onReceipt(receipt);};
 try{
  receipt.before=collectHostFacts(run);save();
  const probe=()=>{const r=run(process.execPath,['--import',join(workspace,'packages/paperclip-runner/node_modules/tsx/dist/loader.mjs'),SELF,'--probe',root],SANDBOX_LIMITS.probeMs);if(!r.ok)return {status:r.namespaceDenied?'namespace_denied':'native_probe_refused',exit:r.exit,signal:r.signal,outputSha256:r.outputSha256};try{return {status:'passed',proof:validateProbeReceipt(JSON.parse(r.stdout))};}catch{fail('sandbox_native_probe_receipt_invalid');}};
  receipt.initialProbe=receipt.before.bwrapPresent?await probe():{status:'not-run-missing-distro-bwrap'};save();
  const decision=sandboxRepairDecision(receipt.before,receipt.initialProbe.status);receipt.decision=decision;save();
  if(decision!=='none'){
   const aptDeadline=Math.min(deadline,Date.now()+SANDBOX_LIMITS.aptMs);
   for(const args of [['update','-qq'],['install','-y','-qq','--no-install-recommends','bubblewrap','apparmor-profiles','apparmor-utils']]){const r=run('/usr/bin/sudo',['-n','/usr/bin/apt-get',...args],Math.max(1,aptDeadline-Date.now()));if(!r.ok)fail('sandbox_distro_acquisition_failed');receipt.operations.push(args[0]==='update'?'signed-distro-index':'named-distro-prerequisites');save();}
   const after=collectHostFacts(run);if(!after.bwrapPresent)fail('sandbox_distro_bwrap_missing');receipt.afterAcquisition=after;save();
   if(after.apparmor&&after.restrictedUserns===1){
    sandboxRepairDecision(after,'namespace_denied');
    const profileDeadline=Math.min(deadline,Date.now()+SANDBOX_LIMITS.profileMs),profileRun=(binary,args)=>run(binary,args,Math.max(1,profileDeadline-Date.now()));
    const packaged='/usr/share/apparmor/extra-profiles/bwrap-userns-restrict',destination='/etc/apparmor.d/bwrap-userns-restrict';
    const bytes=readAuthenticatedProfile(packaged),closure=verifyProfileIncludeClosure(bytes);
    const loaded=readLoadedPolicy(profileRun);for(const name of PROFILE_CONTRACT.profileNames)if(inspectLoadedAttachments(loaded.names,loaded.tree,name).conflict)fail('sandbox_profile_policy_conflict');
    const dest=existsSync(destination)?(trustedFile(destination).equals(bytes)?'same-package-bytes':'divergent'):'absent';
    const action=profileLoadDecision({packagedVerified:true,destination:dest,loaded:'absent',localOverride:false});
    receipt.profile={package:'apparmor-profiles',sha256:hash(bytes),destination:dest,loadedBefore:false,provenance:profileProvenance(),includeClosure:closure};save();
    const stage=stageAuthenticatedProfile(bytes,process.env.SOURCE_SHA,(binary,args,input)=>run(binary,args,Math.max(1,profileDeadline-Date.now()),input));receipt.profile.rootStage=stage.proof;receipt.operations.push('authenticated-bwrap-profile-staged');save();
    if(action==='install-and-load'){const r=profileRun('/usr/bin/sudo',['-n','/usr/bin/install','-m','0644','--',stage.path,destination]);if(!r.ok)fail('sandbox_profile_install_failed');receipt.operations.push('packaged-bwrap-profile-installed');}
    if(!readAuthenticatedProfile(packaged).equals(bytes)||!trustedFile(destination).equals(bytes)||JSON.stringify(verifyProfileIncludeClosure(bytes))!==JSON.stringify(closure))fail('sandbox_profile_changed');
    verifyRootStage(stage,(binary,args,input)=>run(binary,args,Math.max(1,profileDeadline-Date.now()),input));
    const again=readLoadedPolicy(profileRun);if(again.names!==loaded.names||again.tree!==loaded.tree)fail('sandbox_loaded_policy_changed');
    const load=profileRun('/usr/bin/sudo',['-n','/usr/sbin/apparmor_parser',...PROFILE_CONTRACT.parserArgs]);if(!load.ok)fail('sandbox_profile_load_failed');receipt.operations.push('packaged-bwrap-profile-loaded');
    const finalLoaded=readLoadedPolicy(profileRun);validateLoadedProfileDelta(loaded,finalLoaded);receipt.profile.loadedAfter=true;receipt.profile.loadedNames=[...PROFILE_CONTRACT.profileNames];receipt.profile.cacheDisabled=true;save();
   }
   receipt.postProbe=await probe();save();if(receipt.postProbe.status!=='passed')fail('sandbox_post_prerequisite_refused');
  }
  receipt.after=collectHostFacts(run);receipt.globalRestrictionChanged=['apparmor','restrictedUserns','maxUserNamespaces','usernsClone','seccomp'].some(k=>receipt.before[k]!==receipt.after[k]);if(receipt.globalRestrictionChanged)fail('sandbox_global_host_policy_changed');receipt.proof=validateProbeReceipt((receipt.postProbe??receipt.initialProbe).proof);if(receipt.after.bwrapSha256!==receipt.proof.bwrapSha256)fail('sandbox_bwrap_changed');receipt.status='passed';save();return receipt;
 }catch(error){receipt.status='failed';receipt.failureCode=error.sandboxCode??'sandbox_prerequisite_refused';if(error.sandboxDiagnostic)receipt.trustRefusal=error.sandboxDiagnostic;preserveSandboxFailure(error,save,summary=>console.error(JSON.stringify(summary)));}
}
async function nativeProbe(root){
 if(process.platform!=='linux'||process.arch!=='x64'||process.getuid()===0)fail('sandbox_probe_platform');
 const workspace=resolve(dirname(SELF),'..'),base=mkdtempSync(join(root,'sandbox-probe-'));const p=Object.fromEntries(['candidate','scratch','runtime','home','reference','protected'].map(n=>{const path=join(base,n);mkdirSync(path,{mode:0o700});return[n,path];}));
 for(const n of ['candidate','reference','protected'])writeFileSync(join(p[n],'canary'),'retained-'+n,{mode:0o600});mkdirSync(join(p.candidate,'.git'),{mode:0o700});writeFileSync(join(p.candidate,'.git','canary'),'retained-metadata',{mode:0o600});
 const {resolvePinnedCodexCommand}=await import(pathToFileURL(join(workspace,'packages/paperclip-runner/src/drivers/codex/codex-command.ts'))),{createIsolatedCodexAppServerArgs,codexExecutableReadOnlyRoots,CODEX_SKILLLESS_PERMISSION_PROFILE}=await import(pathToFileURL(join(workspace,'packages/paperclip-runner/src/drivers/codex/codex-security-config.ts')));
 const codex=resolvePinnedCodexCommand(pathToFileURL(join(workspace,'packages/paperclip-runner/src/drivers/codex/reviewer-candidate-inspection.ts')),{PATH:''},p.home),manifest=join(dirname(codex),'../package.json'),pkg=JSON.parse(readFileSync(manifest));if(pkg.name!=='@openai/codex'||pkg.version!=='0.160.0'||hash(readFileSync(codex))!=='61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70')fail('sandbox_codex_pin_changed');
 const platformManifest=createRequire(manifest).resolve('@openai/codex-linux-x64/package.json'),native=join(dirname(platformManifest),'vendor/x86_64-unknown-linux-musl/bin/codex'),nativeElfSha256=nativeElfDigest(native);
 const bwrap=trustedFile('/usr/bin/bwrap',16*1024**2),env={PATH:'/usr/bin:/bin',HOME:p.home,CODEX_HOME:p.home,TMPDIR:p.scratch,LANG:'C'};
 const args=createIsolatedCodexAppServerArgs(env,[...codexExecutableReadOnlyRoots(env,codex),process.execPath],undefined,[p.protected],false,{workspaceDirectory:p.candidate,referenceDirectories:[p.reference],readOnlyWorkspace:true,scratchDirectory:p.scratch});const config=[];for(let i=0;i<args.length-1;i++)if(args[i]==='-c'&&args[i+1].startsWith('permissions.'))config.push('-c',args[++i]);
 const server=net.createServer(s=>s.end('local-positive-control'));await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});const port=server.address().port;let outsideControl=false;
 try{
  await new Promise((yes,no)=>{const socket=net.connect(port,'127.0.0.1',()=>{outsideControl=true;socket.end();yes();});socket.once('error',no);socket.setTimeout(1000,()=>socket.destroy(new Error('control_timeout')));});
  const program=`const fs=require('node:fs'),net=require('node:net');const [c,r,p,s,o,port]=process.argv.slice(1);if(process.getuid()===0)process.exit(20);if(fs.readFileSync(c+'/canary','utf8')!=='retained-candidate'||fs.readFileSync(r+'/canary','utf8')!=='retained-reference')process.exit(21);for(const f of [c+'/canary',r+'/canary',p+'/canary',c+'/.git/canary',o+'/outside']){let denied=false;try{fs.writeFileSync(f,'forbidden');}catch{denied=true;}if(!denied)process.exit(22);}let protectedReadDenied=false;try{fs.readFileSync(p+'/canary');}catch{protectedReadDenied=true;}if(!protectedReadDenied)process.exit(24);fs.writeFileSync(s+'/allowed','allowed');const socket=net.connect(Number(port),'127.0.0.1',()=>process.exit(23));socket.on('error',()=>process.exit(0));socket.setTimeout(500,()=>{socket.destroy();process.exit(0)});`;
  const r=spawnSync(codex.endsWith('.js')?process.execPath:codex,[...(codex.endsWith('.js')?[codex]:[]),'sandbox',...config,'-P',CODEX_SKILLLESS_PERMISSION_PROFILE,'-C',p.candidate,'--',process.execPath,'-e',program,p.candidate,p.reference,p.protected,p.scratch,base,String(port)],{cwd:p.candidate,env,encoding:'utf8',timeout:10000,killSignal:'SIGKILL',maxBuffer:MAX/2});
  if(r.error||r.signal||r.status!==0){const text=String(r.stdout??'')+'\n'+String(r.stderr??'');process.stderr.write(namespaceRefusal(text)?'bwrap: No permissions to create new namespace\n':'native sandbox boundary probe refused\n');process.exitCode=1;return;}
  for(const n of ['candidate','reference','protected'])if(readFileSync(join(p[n],'canary'),'utf8')!=='retained-'+n)fail('sandbox_probe_mutated_canary');if(readFileSync(join(p.candidate,'.git/canary'),'utf8')!=='retained-metadata'||readFileSync(join(p.scratch,'allowed'),'utf8')!=='allowed'||existsSync(join(base,'outside')))fail('sandbox_probe_mutated_canary');
  console.log(JSON.stringify({schema:'paperclip.native-sandbox-probe.v1',uid:process.getuid(),codexVersion:pkg.version,wrapperSha256:hash(readFileSync(codex)),nativeElfSha256,bwrapPath:'/usr/bin/bwrap',bwrapSha256:hash(bwrap),nativeSandbox:true,allowedRead:true,scratchWrite:true,candidateDenied:true,referenceDenied:true,protectedDenied:true,protectedReadDenied:true,metadataDenied:true,outsideDenied:true,networkDenied:true,outsideNetworkControl:outsideControl,originalBytesPreserved:true}));
 }finally{await new Promise(yes=>server.close(yes));}
}
if(process.argv[1]&&resolve(process.argv[1])===SELF){
 if(process.argv[2]==='--diagnose-system-trust')await diagnoseSystemTrust();
 else if(process.argv[2]==='--probe')await nativeProbe(resolve(process.argv[3]));
 else if(process.argv[2]==='--facts'){hosted(process.env);const run=runner(Date.now()+60000,process.env.RUNNER_TEMP);console.log(JSON.stringify({schema:'paperclip.native-sandbox-host-facts.v1',facts:collectHostFacts(run)}));}
 else fail('sandbox_command_closed');
}
