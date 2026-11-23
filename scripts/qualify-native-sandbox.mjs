#!/usr/bin/env node
/** Disposable Ubuntu source-job prerequisite; never a production permission grant. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync,existsSync,writeFileSync,mkdirSync,mkdtempSync,openSync,readSync,closeSync,fstatSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import net from 'node:net';
const SELF=fileURLToPath(import.meta.url),MAX=65536;
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
function runner(deadline,home){return (binary,args,ms=15000)=>{
 const effective=Math.min(ms,deadline-Date.now());if(effective<=1000)fail('sandbox_prerequisite_deadline');trustedFile('/usr/bin/timeout',1024*1024);
 const seconds=((effective-1000)/1000).toFixed(3)+'s',privileged=binary==='/usr/bin/sudo';
 if(privileged&&args[0]!=='-n')fail('sandbox_privileged_command_refused');
 // GNU timeout creates a process group and sends KILL to the whole group.
 // Its deadline precedes Node's final KILL backstop; sudo-owned apt children
 // are bounded by the root-owned timeout, not a normal user's signal rights.
 const command=privileged?binary:'/usr/bin/timeout',argv=privileged?['-n','/usr/bin/timeout','--signal=KILL',seconds,...args.slice(1)]:['--signal=KILL',seconds,binary,...args];
 const r=spawnSync(command,argv,{env:safeEnv(home),encoding:'utf8',timeout:effective,killSignal:'SIGKILL',maxBuffer:MAX/2,shell:false});
 const out=String(r.stdout??'')+'\n'+String(r.stderr??'');if(Buffer.byteLength(out)>MAX)fail('sandbox_command_output_bound');
 return {ok:!r.error&&!r.signal&&r.status===0,stdout:String(r.stdout??''),namespaceDenied:namespaceRefusal(out),exit:Number.isInteger(r.status)?r.status:null,signal:r.signal??null,outputSha256:hash(out)};
 };}
function trustedFile(path,limit=MAX){
 const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o6022)!==0||st.nlink!==1||st.size>limit||realpathSync(path)!==path)fail('sandbox_system_file_unsafe');
 for(let p=dirname(path);;p=dirname(p)){const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)!==0)fail('sandbox_system_parent_unsafe');if(p==='/')break;}
 return readFileSync(path);
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
    const packaged='/usr/share/apparmor/extra-profiles/bwrap-userns-restrict',destination='/etc/apparmor.d/bwrap-userns-restrict',bytes=trustedFile(packaged);
    const verified=profileRun('/usr/bin/dpkg',['--verify','apparmor-profiles']);if(!verified.ok||verified.stdout.trim())fail('sandbox_packaged_profile_unverified');
    const text=bytes.toString('utf8'),m=text.match(/^profile\s+([A-Za-z0-9_.-]+)\s+\/usr\/bin\/bwrap\s+flags=\(unconfined\)\s*\{/m);if(!m||!/^\s*userns,\s*$/m.test(text))fail('sandbox_packaged_profile_unsupported');
    const loaded=profileRun('/usr/bin/sudo',['-n','/usr/bin/cat','/sys/kernel/security/apparmor/profiles']);if(!loaded.ok)fail('sandbox_loaded_policy_unknown');
    const tree=profileRun('/usr/bin/sudo',['-n','/usr/bin/find','/sys/kernel/security/apparmor/policy/profiles','-type','f','(','-name','name','-o','-name','attach',')','-exec','/usr/bin/grep','-H','^','{}','+']);
    if(!tree.ok)fail('sandbox_loaded_attachments_unknown');
    const inventory=inspectLoadedAttachments(loaded.stdout,tree.stdout,m[1]);
    const bookend=profileRun('/usr/bin/sudo',['-n','/usr/bin/cat','/sys/kernel/security/apparmor/profiles']);if(!bookend.ok||bookend.stdout!==loaded.stdout)fail('sandbox_loaded_policy_changed');
    const targetLoaded=inventory.conflict;
    const dest=existsSync(destination)?(trustedFile(destination).equals(bytes)?'same-package-bytes':'divergent'):'absent';
    const action=profileLoadDecision({packagedVerified:true,destination:dest,loaded:targetLoaded?'unknown-preexisting':'absent',localOverride:existsSync('/etc/apparmor.d/local/bwrap')||existsSync('/etc/apparmor.d/local/'+m[1])||[...text.matchAll(/<local\/([A-Za-z0-9_.-]+)>/g)].some(row=>existsSync('/etc/apparmor.d/local/'+row[1]))});
    receipt.profile={package:'apparmor-profiles',sha256:hash(bytes),destination:dest,loadedBefore:false};save();
    if(action==='install-and-load'){const r=profileRun('/usr/bin/sudo',['-n','/usr/bin/install','-m','0644',packaged,destination]);if(!r.ok)fail('sandbox_profile_install_failed');receipt.operations.push('packaged-bwrap-profile-installed');}
    if(!trustedFile(packaged).equals(bytes)||!trustedFile(destination).equals(bytes))fail('sandbox_profile_changed');
    const load=profileRun('/usr/bin/sudo',['-n','/usr/sbin/apparmor_parser','-r',destination]);if(!load.ok)fail('sandbox_profile_load_failed');receipt.operations.push('packaged-bwrap-profile-loaded');
    const finalLoaded=profileRun('/usr/bin/sudo',['-n','/usr/bin/cat','/sys/kernel/security/apparmor/profiles']);if(!finalLoaded.ok||!finalLoaded.stdout.split('\n').some(line=>line.startsWith(m[1]+' ')))fail('sandbox_profile_load_unproven');receipt.profile.loadedAfter=true;save();
   }
   receipt.postProbe=await probe();save();if(receipt.postProbe.status!=='passed')fail('sandbox_post_prerequisite_refused');
  }
  receipt.after=collectHostFacts(run);receipt.globalRestrictionChanged=['apparmor','restrictedUserns','maxUserNamespaces','usernsClone','seccomp'].some(k=>receipt.before[k]!==receipt.after[k]);if(receipt.globalRestrictionChanged)fail('sandbox_global_host_policy_changed');receipt.proof=validateProbeReceipt((receipt.postProbe??receipt.initialProbe).proof);if(receipt.after.bwrapSha256!==receipt.proof.bwrapSha256)fail('sandbox_bwrap_changed');receipt.status='passed';save();return receipt;
 }catch(error){receipt.status='failed';receipt.failureCode=error.sandboxCode??'sandbox_prerequisite_refused';save();throw error;}
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
 if(process.argv[2]==='--probe')await nativeProbe(resolve(process.argv[3]));
 else if(process.argv[2]==='--facts'){hosted(process.env);const run=runner(Date.now()+60000,process.env.RUNNER_TEMP);console.log(JSON.stringify({schema:'paperclip.native-sandbox-host-facts.v1',facts:collectHostFacts(run)}));}
 else fail('sandbox_command_closed');
}
