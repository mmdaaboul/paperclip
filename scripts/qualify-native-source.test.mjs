import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,linkSync,truncateSync,chmodSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {validateSourceContract,sourceEnvironment,inspectVitestReport,inspectNodeTap,sourceTestCommand,vitestRuntimeName,sourceQualificationFailureCheck,runSelectedSourceGroup} from './qualify-native-source.mjs';
import {projectSelectedGroupFailure,classifySelectedFailureText,FAILURE_REPORT_MAXIMUM_BYTES,FAILURE_PROJECTION_MAXIMUM_BYTES} from './native-source-failure-evidence.mjs';
const contract=JSON.parse(readFileSync(new URL('./native-selected-source-contract.json',import.meta.url)));
const root='/owned/checkout',g={project:'root',path:'server/src/example.test.ts',selection:'whole-file'};
const report=(cases=[{fullName:'actual assertion',status:'passed'}])=>({success:true,numFailedTests:0,numFailedTestSuites:0,testResults:[{name:resolve(root,g.path),status:'passed',assertionResults:cases.map(x=>({ancestorTitles:[],title:x.fullName,...x}))}]});
test('current native source contract selects exact owned files and deliberate filtered names without SDK campaign',()=>{validateSourceContract(contract);assert.equal(contract.groups.length,57);assert.equal(contract.groups.filter(g=>g.selection==='exact-full-names').length,5);assert.equal(contract.optionalSdkKernelCampaign,false);assert(contract.groups.some(g=>g.path==='packages/paperclip-runner/src/drivers/codex/reviewer-candidate-inspection.test.ts'&&g.project==='runner'&&g.selection==='whole-file'));for(const group of contract.groups)assert(readFileSync(new URL('../'+group.path,import.meta.url)).length>0);});

const preDotGroupsSha256 = '30893e8b3e1bb6d04565ba097ce43a3da0e0202c4d7c0b9ddd32b4a4a74c2899';
const dotUiFiles = [
  "ui/src/dot-entry-lifecycle.test.tsx",
  "ui/src/dot-entry.test.tsx",
  "ui/src/hooks/useResilientFetch.test.tsx",
  "ui/src/lib/connectivity.test.ts",
  "ui/src/lib/dot-pairing-runtime.test.ts",
  "ui/src/lib/react-root.test.ts",
  "ui/src/lib/tenant-session-recovery.test.ts",
  "ui/src/lib/ui-entry.test.ts",
  "ui/src/pages/McpConnect.test.tsx"
];
test('Dot coverage preserves all prior native groups and uses exact root-project UI selections',()=>{
 assert.equal(createHash('sha256').update(JSON.stringify(contract.groups.slice(0,48))).digest('hex'),preDotGroupsSha256);
 assert.deepEqual(contract.groups.slice(48),dotUiFiles.map(path=>({project:'root',path,selection:'whole-file'})));
 for(const group of contract.groups.slice(48)){const command=sourceTestCommand(group,root,'/private/dot-report.json');assert.equal(command.cwd,root);assert.equal(command.args[1],group.path);assert(command.args.includes('--retry=0'));assert(command.args.includes('--maxWorkers=1'));assert(!command.args.includes('--testNamePattern'));}
});
test('source environment has no ambient auth, DB, Mac override, loader or provider credential',()=>{const env=sourceEnvironment({PATH:'/bin',USER:'runner',GH_TOKEN:'private',GITHUB_TOKEN:'private',NATIVE_INSTALL_GITHUB_TOKEN:'private',DATABASE_URL:'old',PGHOST:'/old',PAPERCLIP_TEST_POSTGRES_ADMIN_URL:'old',PAPERCLIP_CLAUDE_TEST_PACKAGE_DIR:'/old',PAPERCLIP_TEST_CODEX_BINARY:'/old',NODE_OPTIONS:'--import private',NODE_PATH:'/private',OPENAI_API_KEY:'private',PAPERCLIP_CONFIG:'/old'},'/new/home','/new/tmp');for(const key of ['GH_TOKEN','GITHUB_TOKEN','NATIVE_INSTALL_GITHUB_TOKEN','DATABASE_URL','PGHOST','PAPERCLIP_TEST_POSTGRES_ADMIN_URL','PAPERCLIP_CLAUDE_TEST_PACKAGE_DIR','PAPERCLIP_TEST_CODEX_BINARY','NODE_OPTIONS','NODE_PATH','OPENAI_API_KEY','PAPERCLIP_CONFIG'])assert.equal(env[key],undefined);assert.equal(env.PAPERCLIP_VITEST_RETRY,'0');assert.equal(env.HOME,'/new/home');});
test('whole-file native report requires every discovered assertion to pass',()=>{assert.equal(inspectVitestReport(report(),g,root).passed,1);for(const status of ['failed','pending','skipped','todo'])assert.throws(()=>inspectVitestReport(report([{fullName:'actual assertion',status}]),g,root));assert.throws(()=>inspectVitestReport(report([]),g,root));});
test('a filtered native group records other methods as unselected, never successful',()=>{const selected={...g,selection:'exact-full-names',fullNames:['closed Stop']};const data=report([{fullName:'closed Stop',status:'passed'},{fullName:'unrelated kernel',status:'pending'}]);assert.deepEqual(inspectVitestReport(data,selected,root),{selected:1,passed:1,failed:0,skipped:0,unselected:1});data.testResults[0].assertionResults[0].status='pending';assert.throws(()=>inspectVitestReport(data,selected,root));});
test('missing, duplicate or unexpected selected methods refuse receipt promotion',()=>{const selected={...g,selection:'exact-full-names',fullNames:['selected']};for(const cases of [[{fullName:'other',status:'passed'}],[{fullName:'selected',status:'passed'},{fullName:'selected',status:'passed'}],[{fullName:'selected',status:'passed'},{fullName:'other',status:'passed'}]])assert.throws(()=>inspectVitestReport(report(cases),selected,root));});
test('wrong file, hook failure, multiple files or failed native run cannot pass',()=>{for(const mutate of [r=>r.testResults[0].name='/elsewhere/test.ts',r=>r.numFailedTestSuites=1,r=>r.success=false,r=>r.testResults.push(r.testResults[0])]){const r=report();mutate(r);assert.throws(()=>inspectVitestReport(r,g,root));}});
test('native TAP summary admits the ten actual patched Claude consumers with no skipped or failed cases',()=>{const tap='# tests 10\n# pass 10\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';assert.equal(inspectNodeTap(tap,10).passed,10);for(const text of [tap.replace('# pass 10','# pass 9'),tap.replace('# skipped 0','# skipped 1'),tap+'# pass 10\n'])assert.throws(()=>inspectNodeTap(text,10));});
test('native exact selector keeps argv literal, one worker and retry disabled',()=>{const group={...g,selection:'exact-full-names',fullNames:['specific (Stop) [case]']};const cmd=sourceTestCommand(group,root,'/private/report.json');assert.equal(cmd.cwd,root);assert(cmd.args.includes('--retry=0'));assert(cmd.args.includes('--maxWorkers=1'));assert.equal(cmd.args.at(-1),'^(?:specific \\(Stop\\) \\[case\\])$');assert(cmd.args[0].endsWith('/scripts/ci/run-selected-vitest.mjs'));});
test('contract refuses duplicate/path traversal or mislabelled native consumer ownership',()=>{for(const change of [c=>c.groups.push(c.groups[0]),c=>c.groups[0].path='server/../private.test.ts',c=>c.groups.find(g=>g.project==='node-tap').path='server/other.test.mjs',c=>c.retries=1]){const c=structuredClone(contract);change(c);assert.throws(()=>validateSourceContract(c));}});

test('actual Vitest reporter and runtime name formats select the same nested methods',()=>{
 const g={project:'root',path:'ui/src/components/AgentConfigForm.render.test.tsx',selection:'exact-full-names',fullNames:['AgentConfigForm environment selector > recorded GitHub mode defaults off and saves through the existing parent draft']};
 const assertion={ancestorTitles:['AgentConfigForm environment selector'],title:'recorded GitHub mode defaults off and saves through the existing parent draft',fullName:'AgentConfigForm environment selector recorded GitHub mode defaults off and saves through the existing parent draft',status:'passed'};
 const pattern=new RegExp(sourceTestCommand(g,root,'/private/report').args.at(-1));assert(pattern.test(vitestRuntimeName(assertion)));assert(!pattern.test(assertion.fullName));assert(!pattern.test(vitestRuntimeName(assertion)+' sibling'));const r={success:true,numFailedTests:0,numFailedTestSuites:0,testResults:[{name:resolve(root,g.path),status:'passed',assertionResults:[assertion,{ancestorTitles:['Unrelated suite'],title:'unselected',fullName:'Unrelated suite unselected',status:'skipped'}]}]};assert.deepEqual(inspectVitestReport(r,g,root),{selected:1,passed:1,failed:0,skipped:0,unselected:1});assertion.status='skipped';assert.throws(()=>inspectVitestReport(r,g,root),/skip_or_failure/);
});
test('canonical names preserve nested suites and refuse missing or incoherent reporter metadata',()=>{
 const a={ancestorTitles:['outer','inner'],title:'literal (Stop) [case]',fullName:'outer inner literal (Stop) [case]'};assert.equal(vitestRuntimeName(a),'outer > inner > literal (Stop) [case]');for(const change of [{ancestorTitles:undefined},{title:''},{fullName:'different'}])assert.throws(()=>vitestRuntimeName({...a,...change}));
});
test('source failures expose only fixed check identifiers rather than raw assertion messages',()=>{
 assert.equal(sourceQualificationFailureCheck(new Error('native_selected_skip_or_failure')),'native_selected_skip_or_failure');assert.equal(sourceQualificationFailureCheck(new Error('native_selected_wrong_file\nPRIVATE PATH')),'native_selected_wrong_file');assert.equal(sourceQualificationFailureCheck(new Error('PRIVATE TOKEN')),'native_source_check_unclassified');
});

test('operational review integration qualification includes actual owner and failure consumer suites',()=>{const required=['server/src/__tests__/native-operational-issue-mutation.test.ts','server/src/__tests__/native-operational-continuations.test.ts','server/src/__tests__/native-operational-handoffs-stop.test.ts','server/src/__tests__/native-operational-recovery-callers.test.ts','server/src/__tests__/native-comment-continuations.test.ts','server/src/services/native-runtime/native-total-review-bootstrap.integration.test.ts','server/src/services/native-runtime/native-safe-replacement-review-budget.test.ts'];for(const path of required)assert(contract.groups.some(group=>group.path===path&&group.selection==='whole-file'&&group.project==='root'));});

test('native Git worktree first-start regression is selected through its real database admission consumer',()=>{const group=contract.groups.find(g=>g.path==='server/src/services/native-runtime/native-attributed-git-admission.test.ts');assert.deepEqual(group,{project:'root',path:'server/src/services/native-runtime/native-attributed-git-admission.test.ts',selection:'whole-file'});});

test('actual nonzero selected child retains its failed report before the original refusal',()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'native-failure-report-'));
 try{
  const group={project:'root',path:'server/src/example.test.ts',selection:'whole-file'},file=resolve(dir,'report.private.json');
  mkdirSync(resolve(dir,'server/src'),{recursive:true});writeFileSync(resolve(dir,group.path),'// synthetic owned source\n');
  const data={success:false,numFailedTests:1,numFailedTestSuites:1,testResults:[{name:resolve(dir,group.path),status:'failed',assertionResults:[{ancestorTitles:[],title:'owned failure',fullName:'owned failure',status:'failed',failureMessages:['Test timed out in 5000ms']}]}]};
  const original=Object.assign(new Error('native_source_command_failed'),{code:'ERR_ASSERTION'});let diagnostic;
  const execute=()=>{const child=spawnSync(process.execPath,['-e',`require('node:fs').writeFileSync(${JSON.stringify(file)},${JSON.stringify(JSON.stringify(data))});process.exit(1)`],{cwd:dir,env:{PATH:'/usr/bin:/bin'},timeout:5000,maxBuffer:4096});assert.equal(child.status,1);throw original;};
  assert.throws(()=>runSelectedSourceGroup({execute,group,workspace:dir,report:file,commandFailure:()=>({exit:1,signal:null,reason:'nonzero_exit'}),onDiagnostic:v=>{diagnostic=v;}}),e=>e===original);
  assert.equal(diagnostic?.counts?.failed,1);assert.equal(diagnostic?.assertions?.[0]?.diagnostics?.[0]?.kind,'test_timeout');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

function failureFixture(){
 const dir=mkdtempSync(resolve(tmpdir(),'native-failure-projection-')),group={project:'root',path:'server/src/example.test.ts',selection:'whole-file'},file=resolve(dir,'report.private.json');
 mkdirSync(resolve(dir,'server/src'),{recursive:true});writeFileSync(resolve(dir,group.path),'// owned synthetic source\n');
 const assertion=(title,status='failed')=>({ancestorTitles:[],title,fullName:title,status,failureMessages:['Test timed out in 5000ms']});
 const data={success:false,numFailedTests:1,numFailedTestSuites:1,testResults:[{name:resolve(dir,group.path),status:'failed',assertionResults:[assertion('owned failure')]}]};
 const save=()=>writeFileSync(file,JSON.stringify(data)),project=commandFailure=>projectSelectedGroupFailure({group,workspace:dir,report:file,commandFailure});
 return{dir,group,file,data,assertion,save,project,close:()=>rmSync(dir,{recursive:true,force:true})};
}
for(const kind of ['missing','corrupt','wrong-file','duplicate','oversized','symlink','hardlink','fifo','assertion-bound','nonprivate-parent'])test('failure projection refuses '+kind+' while preserving the original command error',()=>{
 const f=failureFixture();try{
  if(kind!=='missing')f.save();
  if(kind==='corrupt')writeFileSync(f.file,'{not JSON');
  if(kind==='wrong-file'){f.data.testResults[0].name='/unrelated/private.test.ts';f.save();}
  if(kind==='duplicate'){f.data.testResults[0].assertionResults.push(f.data.testResults[0].assertionResults[0]);f.save();}
  if(kind==='oversized')truncateSync(f.file,FAILURE_REPORT_MAXIMUM_BYTES+1);
  if(kind==='symlink'){rmSync(f.file);writeFileSync(resolve(f.dir,'other'),JSON.stringify(f.data));symlinkSync(resolve(f.dir,'other'),f.file);}
  if(kind==='hardlink')linkSync(f.file,resolve(f.dir,'alias'));
  if(kind==='fifo'){rmSync(f.file);const child=spawnSync('/usr/bin/mkfifo',[f.file],{timeout:3000});assert.equal(child.status,0);}
  if(kind==='assertion-bound'){f.data.testResults[0].assertionResults=Array.from({length:513},(_,i)=>f.assertion('case '+i));f.save();}
  if(kind==='nonprivate-parent')chmodSync(f.dir,0o755);
  const original=new Error('original bounded command refusal');let diagnostic;
  assert.throws(()=>runSelectedSourceGroup({execute:()=>{throw original;},group:f.group,workspace:f.dir,report:f.file,onDiagnostic:x=>{diagnostic=x;}}),e=>e===original);
  assert.equal(diagnostic.report.state,'unavailable');assert.equal(diagnostic.counts,null);assert.deepEqual(diagnostic.assertions,[]);assert(Buffer.byteLength(JSON.stringify(diagnostic))<=FAILURE_PROJECTION_MAXIMUM_BYTES);
 }finally{f.close();}
});
test('only source-bound public inspector names and finite command diagnostics are retained',()=>{
 const f=failureFixture();try{
  const group=contract.groups.find(x=>x.path.endsWith('reviewer-candidate-inspection.test.ts')),prefix='actual offline native Reviewer Git inspector',title='reads actual HEAD and cleanliness with unchanged Git/candidate bytes',secret='github_pat_PRIVATE_CANARY_123456',diagnostic='Reviewer native candidate inspection failed: stage=git_head; class=access_denied; code=1; signal=none; killed=false; stderrSha256='+'a'.repeat(64);
  f.data.testResults[0].name=resolve(process.cwd(),group.path);f.data.testResults[0].assertionResults=[{ancestorTitles:[prefix],title,fullName:prefix+' '+title,status:'failed',failureMessages:[diagnostic+'\nBearer '+secret+'\nhttps://private.invalid/invite\n/private/key']},f.assertion(secret),f.assertion('passed fixture','passed'),f.assertion('skipped fixture','skipped')];f.save();
  const result=projectSelectedGroupFailure({group,workspace:process.cwd(),report:f.file,commandFailure:{exit:1,signal:'SIGPRIVATE',reason:secret,selectedOutputDiagnostics:[{kind:secret},{kind:'test_timeout',private:secret}]}}),text=JSON.stringify(result);
  assert.deepEqual(result.counts,{discovered:4,selected:4,passed:1,failed:2,skipped:1,unselected:0});assert.equal(result.assertions[0].sourceOwnedName,prefix+' > '+title);assert.equal(result.assertions[1].sourceOwnedName,undefined);
  assert.equal(result.assertions[0].diagnostics[0].stage,'git_head');assert.equal(result.assertions[0].diagnostics[0].classification,'access_denied');assert.equal(result.command.signal,null);assert.equal(result.command.reason,'unknown');
  for(const value of [secret,'private.invalid','/private/key','Bearer'])assert(!text.includes(value));
  assert(Buffer.byteLength(text)<=FAILURE_PROJECTION_MAXIMUM_BYTES);
 }finally{f.close();}
});
test('missing reports retain trusted timeout, discovery and import categories without invented zero counts',()=>{
 const f=failureFixture();try{
  const codes=classifySelectedFailureText('Selected files must match exactly one discovered specification; ERR_MODULE_NOT_FOUND private-token; Test timed out in 5000ms');
  const result=f.project({exit:null,signal:'SIGTERM',reason:'ETIMEDOUT',selectedOutputDiagnostics:codes});
  assert.equal(result.counts,null);assert.equal(result.command.reason,'ETIMEDOUT');assert.deepEqual(result.command.diagnostics.map(x=>x.kind),['selected_file_discovery_mismatch','module_import_failed','test_timeout']);
 }finally{f.close();}
});
test('suite/import failures with a genuine empty assertion list differ from absent or corrupt reports',()=>{
 const f=failureFixture();try{f.data.testResults[0].assertionResults=[];f.data.testResults[0].message='Cannot find package private-canary imported from /private/location';f.save();const result=f.project();assert.equal(result.report.state,'parsed');assert.equal(result.failureScope,'suite_or_discovery');assert.equal(result.counts.failed,0);assert.equal(result.suiteDiagnostics[0].kind,'module_import_failed');assert(!JSON.stringify(result).includes('private-canary'));}finally{f.close();}
});
test('a file or hook failure with all assertions passed stays distinguishable from a passing qualification',()=>{
 const f=failureFixture();try{f.data.testResults[0].assertionResults=[f.assertion('passed case','passed')];f.data.testResults[0].message='Hook timed out in 5000ms';f.save();const d=f.project();assert.equal(d.counts.failed,0);assert.equal(d.reportedSummary.failedSuites,1);assert.equal(d.failureScope,'file_hook_or_command_failure');assert.equal(d.suiteDiagnostics[0].kind,'test_timeout');}finally{f.close();}
});
test('source fingerprint reads refuse an oversized or aliased source before granting a public name',()=>{
 for(const kind of ['oversized','alias']){const f=failureFixture();try{f.save();const source=resolve(f.dir,f.group.path);if(kind==='oversized')truncateSync(source,4*1024**2+1);else linkSync(source,resolve(f.dir,'source-alias'));const d=f.project();assert.equal(d.counts,null);assert.equal(d.report.reason,'report_unsafe');}finally{f.close();}}
});
test('a skipped or malformed report after command success still refuses and records failure-only evidence',()=>{
 const f=failureFixture();try{f.data.success=true;f.data.numFailedTests=0;f.data.numFailedTestSuites=0;f.data.testResults[0].status='passed';f.data.testResults[0].assertionResults=[f.assertion('skipped','pending')];f.save();let diagnostic;assert.throws(()=>runSelectedSourceGroup({execute:()=>'',group:f.group,workspace:f.dir,report:f.file,onDiagnostic:x=>{diagnostic=x;}}),/native_selected_skip_or_failure/);assert.equal(diagnostic.counts.skipped,1);assert.equal(diagnostic.authority,'FAILURE_DIAGNOSTIC_ONLY_NOT_QUALIFICATION');}finally{f.close();}
});
test('projection failure or an unavailable writer cannot replace the original selected command refusal',()=>{
 const f=failureFixture();try{const original=new Error('retained original command failure');assert.throws(()=>runSelectedSourceGroup({execute:()=>{throw original;},group:f.group,workspace:f.dir,report:f.file,onDiagnostic:()=>{throw Error('writer unavailable');}}),e=>e===original);}finally{f.close();}
});
test('failure-only assertion bounds do not narrow the existing successful report contract',()=>{
 const f=failureFixture();try{f.data.success=true;f.data.numFailedTests=0;f.data.numFailedTestSuites=0;f.data.testResults[0].status='passed';f.data.testResults[0].assertionResults=Array.from({length:513},(_,i)=>f.assertion('owned '+i,'passed'));f.save();let called=false;const result=runSelectedSourceGroup({execute:()=>'',group:f.group,workspace:f.dir,report:f.file,onDiagnostic:()=>{called=true;}});assert.equal(result.counts.passed,513);assert.equal(called,false);}finally{f.close();}
});
test('finite diagnostic grammar rejects injected native codes and retains namespace or metadata refusal',()=>{
 const injection='Reviewer native candidate inspection failed: stage=git_head; class=command_failed; code=PRIVATE_TOKEN; signal=none; killed=false; stderrSha256='+'b'.repeat(64);
 assert.deepEqual(classifySelectedFailureText(injection),[]);
 assert.deepEqual(classifySelectedFailureText('bwrap: No permissions to create new namespace; Reviewer linked Git metadata is unsupported or changed').map(x=>x.kind),['linux_namespace_denied','metadata_graph_refused']);
});
