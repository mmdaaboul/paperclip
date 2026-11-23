/** Failure-only projection. Never a successful qualification or raw log export. */
import {constants,openSync,closeSync,fstatSync,readSync,lstatSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename,dirname,resolve,isAbsolute} from 'node:path';

export const FAILURE_REPORT_MAXIMUM_BYTES=16*1024**2;
export const FAILURE_ASSERTION_MAXIMUM=512;
export const FAILURE_PROJECTION_MAXIMUM_BYTES=64*1024;
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{diagnosticCode:code});};
const inspectorPath='packages/paperclip-runner/src/drivers/codex/reviewer-candidate-inspection.test.ts';
const inspectorSource='971b1fbace9cc685d84cc8916519aa7aaa056dc11173b6b07ff010cb1f98c177';
const suite='actual offline native Reviewer Git inspector';
const inspectorTitles=[
 'reads actual HEAD and cleanliness with unchanged Git/candidate bytes',
 'refuses dirty candidates without resetting or modifying them',
 'reads a real nested linked worktree without changing shared Git metadata',
 'refuses a dirty linked candidate and preserves the edit',
 'native sandbox reads linked metadata but denies metadata, candidate, reference and protected writes',
 'returns only the verified metadata read root and detects a changed reciprocal pointer',
 'detects replacement of the admitted Git directory',
 ...['foreign-pointer','wrong-common','wrong-backlink','symlink-pointer','hardlink-pointer','hardlink-metadata','protected-common','scratch-overlap'].map(s=>'refuses '+s+' without broadening the read grant'),
 'refuses oversized control files before reading or granting them',
 'refuses a real FIFO control file before any candidate inspection',
 'refuses external sibling worktrees instead of inferring an unrelated repository grant',
 'retains safe command diagnostics without exposing stderr or filesystem paths',
 'refuses an unrestricted caller policy before any inspector execution',
];
const names=new Set(inspectorTitles.map(title=>suite+' > '+title));
const readReasons=new Set(['report_missing','report_unsafe','report_oversized','report_changed','report_corrupt','report_wrong_file','report_assertion_bound','report_duplicate_assertions','report_invalid_assertion']);

function boundedReport(path){
 if(!isAbsolute(path)||resolve(path)!==path||!/^report(?:-[0-9]{1,2})?\.private\.json$/.test(basename(path)))fail('report_unsafe');
 const parent=dirname(path),p=lstatSync(parent);
 if(!p.isDirectory()||p.isSymbolicLink()||realpathSync(parent)!==parent||p.uid!==process.getuid?.()||(p.mode&0o077))fail('report_unsafe');
 const before=lstatSync(path);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.uid!==p.uid)fail('report_unsafe');
 if(before.size>FAILURE_REPORT_MAXIMUM_BYTES)fail('report_oversized');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.dev!==before.dev||s.ino!==before.ino||s.uid!==before.uid)fail('report_changed');
  if(s.size>FAILURE_REPORT_MAXIMUM_BYTES)fail('report_oversized');
  const b=Buffer.alloc(s.size+1);let size=0;
  while(size<b.length){const n=readSync(fd,b,size,b.length-size,null);if(!n)break;size+=n;}
  const after=fstatSync(fd),named=lstatSync(path),parentAfter=lstatSync(parent);
  if(size!==s.size||after.dev!==s.dev||after.ino!==s.ino||after.size!==s.size||after.mtimeMs!==s.mtimeMs||after.ctimeMs!==s.ctimeMs||named.dev!==s.dev||named.ino!==s.ino||named.nlink!==1||parentAfter.dev!==p.dev||parentAfter.ino!==p.ino||realpathSync(parent)!==parent)fail('report_changed');
  return b.subarray(0,size);
 }finally{closeSync(fd);}
}
function sourceFingerprint(path){
 const before=lstatSync(path);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>4*1024**2||realpathSync(path)!==path)fail('report_unsafe');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const s=fstatSync(fd);if(!s.isFile()||s.dev!==before.dev||s.ino!==before.ino||s.nlink!==1||s.size>4*1024**2)fail('report_unsafe');
  const bytes=Buffer.alloc(s.size+1);let count=0;
  while(count<bytes.length){const n=readSync(fd,bytes,count,bytes.length-count,null);if(!n)break;count+=n;}
  const after=fstatSync(fd),named=lstatSync(path);
  if(count!==s.size||after.size!==s.size||after.mtimeMs!==s.mtimeMs||after.ctimeMs!==s.ctimeMs||named.dev!==s.dev||named.ino!==s.ino||named.nlink!==1)fail('report_changed');
  return sha(bytes.subarray(0,count));
 }finally{closeSync(fd);}
}

/** Only finite classifications and an exact safe inspector diagnostic grammar. */
export function classifySelectedFailureText(text){
 if(typeof text!=='string')return [];
 text=text.slice(0,16384);const out=[];
 const exact=/Reviewer native candidate inspection failed: stage=(resolve_git|git_exec_path|git_head|git_status); class=(output_limit|terminated|access_denied|repository_unavailable|command_failed); code=(-?[0-9]{1,3}|ENOENT|EACCES|EPERM|ERR_CHILD_PROCESS_STDIO_MAXBUFFER|unknown); signal=(SIGTERM|SIGKILL|SIGABRT|SIGSEGV|none); killed=(true|false); stderrSha256=([a-f0-9]{64})/g;
 for(const m of text.matchAll(exact)){out.push({kind:'inspector_command',stage:m[1],classification:m[2],code:m[3],signal:m[4],killed:m[5]==='true',stderrSha256:m[6]});if(out.length===4)break;}
 const patterns=[
  ['linux_namespace_denied',/bwrap:[^\n]*(?:[Pp]ermission|[Oo]peration not permitted)|[Nn]o permissions to create[^\n]*namespace|[Uu]ser namespace[^\n]*(?:denied|not permitted)/],
  ['sandbox_runtime_unavailable',/Codex runtime unavailable:|Native Codex sandbox unavailable|Reviewer readonly native inspector is unavailable/],
  ['metadata_graph_refused',/Reviewer linked Git metadata is unsupported or changed/],
  ['selected_file_discovery_mismatch',/Selected files must match exactly one discovered specification|No test files found/],
  ['module_import_failed',/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|Failed to load url/],
  ['test_timeout',/Test timed out in [0-9]+ms|Hook timed out in [0-9]+ms/],
  ['worker_memory_limit',/ERR_WORKER_OUT_OF_MEMORY|JavaScript heap out of memory/],
  ['invalid_path_argument',/The "paths\[[0-9]+\]" argument must be of type string/],
 ];
 for(const[k,re]of patterns)if(re.test(text))out.push({kind:k});
 return out.slice(0,12);
}
function commandProjection(value){
 const reasons=new Set(['ETIMEDOUT','ENOBUFS','ENOENT','EACCES','EPERM','ERR_CHILD_PROCESS_STDIO_MAXBUFFER','nonzero_exit']);
 const signal=['SIGTERM','SIGKILL','SIGABRT','SIGSEGV'].includes(value?.signal)?value.signal:null;
 return {exit:Number.isInteger(value?.exit)&&value.exit>=-128&&value.exit<=255?value.exit:null,signal,reason:reasons.has(value?.reason)?value.reason:'unknown',diagnostics:(value?.selectedOutputDiagnostics??[]).filter(x=>x&&typeof x.kind==='string'&&allowedKinds.has(x.kind)).map(x=>({kind:x.kind})).slice(0,12)};
}
const allowedKinds=new Set(['linux_namespace_denied','sandbox_runtime_unavailable','metadata_graph_refused','selected_file_discovery_mismatch','module_import_failed','test_timeout','worker_memory_limit','invalid_path_argument']);
function runtimeName(a){
 if(!Array.isArray(a?.ancestorTitles)||!a.ancestorTitles.every(s=>typeof s==='string'&&s.length<=1000)||typeof a.title!=='string'||a.title.length>1000||typeof a.fullName!=='string'||a.fullName!==[...a.ancestorTitles,a.title].join(' '))fail('report_invalid_assertion');
 return [...a.ancestorTitles,a.title].join(' > ');
}

export function projectSelectedGroupFailure({group,workspace,report,commandFailure}){
 const out={schema:'paperclip.native-selected-failure.v1',authority:'FAILURE_DIAGNOSTIC_ONLY_NOT_QUALIFICATION',group:{path:group.path,project:group.project,selection:group.selection},command:commandProjection(commandFailure),report:{state:'unavailable',reason:'report_missing'},counts:null,assertions:[]};
 try{
  if(group.project==='node-tap'){out.report.reason='not_a_vitest_report';return out;}
  const raw=boundedReport(report);out.report={state:'read',bytes:raw.length,sha256:sha(raw)};let body;try{body=JSON.parse(raw);}catch{fail('report_corrupt');}
  out.reportDiagnostics=[...(Array.isArray(body.unhandledErrors)?body.unhandledErrors:[]),...(Array.isArray(body.errors)?body.errors:[])].slice(0,4).flatMap(x=>classifySelectedFailureText(typeof x==='string'?x:x?.message)).slice(0,12);
  if(!Array.isArray(body.testResults)||body.testResults.length!==1||resolve(workspace,body.testResults[0]?.name??'')!==resolve(workspace,group.path))fail('report_wrong_file');
  const file=body.testResults[0],rows=file.assertionResults;
  if(!Array.isArray(rows)||rows.length>FAILURE_ASSERTION_MAXIMUM)fail('report_assertion_bound');
  const seen=new Set(),selected=[];
  rows.forEach((a,index)=>{if(!['passed','failed','pending','skipped','todo','disabled'].includes(a.status))fail('report_invalid_assertion');const name=runtimeName(a);if(seen.has(name))fail('report_duplicate_assertions');seen.add(name);if(group.selection==='whole-file'||group.fullNames.includes(name))selected.push({a,index,name});});
  out.group.sourceSha256=sourceFingerprint(resolve(workspace,group.path));
  out.report.state='parsed';out.counts={discovered:rows.length,selected:selected.length,passed:selected.filter(x=>x.a.status==='passed').length,failed:selected.filter(x=>x.a.status==='failed').length,skipped:selected.filter(x=>!['passed','failed'].includes(x.a.status)).length,unselected:rows.length-selected.length};
  const number=value=>Number.isSafeInteger(value)&&value>=0&&value<=100000?value:null;
  out.reportedSummary={success:typeof body.success==='boolean'?body.success:null,failedTests:number(body.numFailedTests),failedSuites:number(body.numFailedTestSuites),fileStatus:['passed','failed','pending'].includes(file.status)?file.status:'unknown'};
  out.failureScope=rows.length===0?'suite_or_discovery':out.counts.failed+out.counts.skipped>0?'assertion_results':'file_hook_or_command_failure';
  for(const row of selected.filter(x=>x.a.status!=='passed').slice(0,32)){
   const text=Array.isArray(row.a.failureMessages)?row.a.failureMessages.filter(x=>typeof x==='string').slice(0,4).join('\n'):'';
   const trusted=group.path===inspectorPath&&out.group.sourceSha256===inspectorSource&&names.has(row.name);
   out.assertions.push({index:row.index,status:row.a.status,identitySha256:sha(row.name),...(trusted?{sourceOwnedName:row.name}:{}),messageSha256:sha(text),diagnostics:classifySelectedFailureText(text)});
  }
  out.omittedNonPassingAssertions=Math.max(0,out.counts.failed+out.counts.skipped-out.assertions.length);
  out.suiteDiagnostics=classifySelectedFailureText(file.message);
 }catch(error){out.report={...out.report,state:'unavailable',reason:readReasons.has(error?.diagnosticCode)?error.diagnosticCode:error?.code==='ENOENT'?'report_missing':'report_unsafe'};out.counts=null;out.assertions=[];}
 if(Buffer.byteLength(JSON.stringify(out))>FAILURE_PROJECTION_MAXIMUM_BYTES)return {schema:out.schema,authority:out.authority,group:out.group,command:out.command,report:{state:'unavailable',reason:'projection_limit'},counts:null,assertions:[]};
 return out;
}
