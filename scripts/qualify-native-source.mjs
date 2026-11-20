#!/usr/bin/env node
/** Disposable GitHub Linux source qualification. Native build/test owners only. */
import assert from 'node:assert/strict';
import {nativeCapacity,nativeCapacityFailure} from './qualify-native-capacity.mjs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,realpathSync} from 'node:fs';
import {join,resolve,sep,dirname} from 'node:path';
import {readClaudeDependencyFacts} from './qualify-native-maintenance.mjs';
import {fileURLToPath} from 'node:url';
import {validateTarget,diagnosticCodes} from './qualify-native-install.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
export function validateSourceContract(contract){
 assert.equal(contract?.schema,'paperclip.native-selected-source-contract.v2');assert.equal(contract.retries,0);assert.equal(contract.maximumWorkers,1);assert.equal(contract.unselectedCasesArePasses,false);assert(/^\d+\.\d+\.\d+$/.test(contract.expectedClaudeVersion));assert(/^\d+\.\d+\.\d+$/.test(contract.expectedClaudeSdkVersion));assert(Number.isSafeInteger(contract.expectedWorkspacePackages)&&contract.expectedWorkspacePackages>0);for(const n of ['publicTables','migrations'])assert(Number.isSafeInteger(contract.expectedSchema?.[n])&&contract.expectedSchema[n]>0);
 assert(Array.isArray(contract.groups)&&contract.groups.length>0&&contract.groups.length<=64);const seen=new Set();
 for(const g of contract.groups){assert(['root','runner','node-tap'].includes(g.project));assert(typeof g.path==='string'&&/^(?:server|ui|cli|packages)\/[A-Za-z0-9_./-]+\.(?:test\.tsx?|test\.mjs)$/.test(g.path)&&!g.path.split('/').includes('..'));assert(!seen.has(g.path));seen.add(g.path);
  assert(['whole-file','exact-full-names'].includes(g.selection));if(g.selection==='exact-full-names')assert(Array.isArray(g.fullNames)&&g.fullNames.length>0&&g.fullNames.length<=32&&new Set(g.fullNames).size===g.fullNames.length&&g.fullNames.every(x=>typeof x==='string'&&x.length>0&&x.length<=1000));
  if(g.project==='node-tap')assert(g.path==='packages/paperclip-runner/test/claude-terminal-failure.test.mjs'&&g.selection==='whole-file'&&Number.isSafeInteger(g.expectedPassed)&&g.expectedPassed>0);
  if(g.project==='runner')assert(g.path.startsWith('packages/paperclip-runner/'));
 }
 return contract;
}
export function sourceEnvironment(ambient,home,tmp){
 const names=['PATH','USER','LOGNAME','LANG','LC_ALL','SHELL','RUSTUP_HOME'];const env=Object.fromEntries(names.filter(k=>ambient[k]!==undefined).map(k=>[k,ambient[k]]));
 return {...env,RUSTUP_HOME:ambient.RUSTUP_HOME??join(ambient.HOME??home,'.rustup'),HOME:home,TMPDIR:tmp,GITHUB_ACTIONS:'true',CI:'true',COREPACK_HOME:join(tmp,'corepack'),CARGO_HOME:join(tmp,'cargo'),CARGO_BUILD_JOBS:'2',PAPERCLIP_HOME:join(home,'.paperclip'),PAPERCLIP_TELEMETRY_DISABLED:'1',DO_NOT_TRACK:'1',PAPERCLIP_VITEST_RETRY:'0',NO_COLOR:'1'};
}
export function inspectVitestReport(report,group,workspace){
 assert(report?.success===true&&report.numFailedTests===0&&report.numFailedTestSuites===0,'native_selected_report_failed');assert(Array.isArray(report.testResults)&&report.testResults.length===1,'native_exact_file_report_required');
 const r=report.testResults[0];assert.equal(resolve(workspace,r.name),resolve(workspace,group.path),'native_selected_wrong_file');assert.equal(r.status,'passed');assert(Array.isArray(r.assertionResults));
 const selected=group.selection==='whole-file'?r.assertionResults:r.assertionResults.filter(x=>group.fullNames.includes(x.fullName));
 assert(selected.length>0,'native_selected_empty');if(group.selection==='exact-full-names')assert.deepEqual(selected.map(x=>x.fullName).sort(),[...group.fullNames].sort(),'native_selected_names_missing_or_duplicate');
 assert(selected.every(x=>x.status==='passed'),'native_selected_skip_or_failure');const other=r.assertionResults.filter(x=>!selected.includes(x));assert(other.every(x=>['pending','skipped','todo','disabled'].includes(x.status)),'native_unselected_was_executed');
 return {selected:selected.length,passed:selected.length,failed:0,skipped:0,unselected:other.length};
}
export function inspectNodeTap(text,expected){
 const count=key=>{const rows=[...text.matchAll(new RegExp('^# '+key+' ([0-9]+)$','gm'))];assert.equal(rows.length,1,'native_tap_summary_required');return Number(rows[0][1]);};
 assert.equal(count('tests'),expected);assert.equal(count('pass'),expected);for(const key of ['fail','cancelled','skipped','todo'])assert.equal(count(key),0);
 return {selected:expected,passed:expected,failed:0,skipped:0,unselected:0};
}
const escapeRegex=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function sourceTestCommand(group,workspace,report){
 if(group.project==='node-tap')return {cwd:join(workspace,'packages/paperclip-runner'),binary:process.execPath,args:['--test','--test-reporter=tap','test/claude-terminal-failure.test.mjs']};
 const cwd=group.project==='runner'?join(workspace,'packages/paperclip-runner'):workspace;
 const file=group.project==='runner'?group.path.slice('packages/paperclip-runner/'.length):group.path;
 return {cwd,binary:process.execPath,args:[join(workspace,'scripts/ci/run-selected-vitest.mjs'),file,'--retry=0','--maxWorkers=1','--no-file-parallelism','--reporter=json','--outputFile='+report,...(group.selection==='exact-full-names'?['--testNamePattern','^(?:'+group.fullNames.map(escapeRegex).join('|')+')$']:[])]};
}
async function qualify(){
 validateTarget(process.env);assert(process.platform==='linux'&&process.arch==='x64'&&process.getuid()>0);const e=process.env,workspace=realpathSync(process.cwd()),root=join(realpathSync(e.RUNNER_TEMP),'f10-native-source');assert(!existsSync(root),'fresh_source_root_required');mkdirSync(root,{mode:0o700});const home=join(root,'home'),tmp=join(root,'tmp');mkdirSync(home,{mode:0o700});mkdirSync(tmp,{mode:0o700});mkdirSync(join(tmp,'bin'),{mode:0o700});
 const contractBytes=readFileSync(join(workspace,'scripts/native-selected-source-contract.json')),contract=validateSourceContract(JSON.parse(contractBytes));
 const evidence={schema:'paperclip.native-selected-qualification.v2',sourceRevision:e.SOURCE_SHA,status:'running',phase:'frozen-native-build',retry:false,contractSha256:hash(contractBytes),lockSha256:hash(readFileSync(join(workspace,'pnpm-lock.yaml'))),claudePatchSha256:hash(readFileSync(join(workspace,'patches/@agentclientprotocol__claude-agent-acp@0.73.0.patch'))),groups:[],liveProviderAcceptance:false,optionalSdkKernelCampaign:false};
 const save=()=>writeFileSync(join(root,'evidence.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});let env=sourceEnvironment(e,home,tmp);
 function command(binary,args,cwd=workspace,timeout=120000,extra={}){
  const r=spawnSync(binary,args,{cwd,env:{...env,...extra},encoding:'utf8',timeout,maxBuffer:32*1024**2,shell:false});const text=(String(r.stdout??'')+'\n'+String(r.stderr??'')).split(e.NATIVE_INSTALL_GITHUB_TOKEN).join('[redacted]');writeFileSync(join(root,evidence.phase+'.private.log'),text.slice(-256*1024),{mode:0o600});if(r.error||r.signal||r.status!==0){evidence.commandFailure={exit:r.status,signal:r.signal,reason:r.error?.code??'nonzero_exit',diagnostics:diagnosticCodes(text,e.NATIVE_INSTALL_GITHUB_TOKEN)};save();assert.fail('native_source_command_failed');}return text;
 }
 try{
  evidence.capacity=[nativeCapacity(root,contract.resources.sourceBuild,'before-native-source-build')];save();assert.equal(command('git',['rev-parse','HEAD']).trim(),e.SOURCE_SHA);command('git',['diff','--exit-code','HEAD','--']);
  command('corepack',['enable','pnpm','--install-directory',join(tmp,'bin')]);env.PATH=join(tmp,'bin')+':'+env.PATH;
  command('corepack',['pnpm','install','--frozen-lockfile'],workspace,600000);
  command('corepack',['pnpm','-r','--workspace-concurrency=1','--filter','@paperclipai/server...','--if-present','run','build'],workspace,1500000,{PAPERCLIP_BUILD_COMMIT:e.SOURCE_SHA,PAPERCLIP_README_ASSET_REF:e.SOURCE_SHA,GH_TOKEN:e.NATIVE_INSTALL_GITHUB_TOKEN});
  command('git',['diff','--exit-code','HEAD','--']);const dependency=readClaudeDependencyFacts(join(workspace,'packages/paperclip-runner/package.json'),workspace);evidence.claudeRuntime={...dependency,frozenPatchedDependency:true};evidence.nativeWorkspaceBuild=true;evidence.capacity.push(nativeCapacity(root,contract.resources.sourceTests,'before-selected-source-tests'));save();const deadline=Date.now()+20*60*1000;
  for(const [index,group]of contract.groups.entries()){
   evidence.phase='selected-'+String(index).padStart(2,'0');save();const report=join(root,'report-'+index+'.private.json'),selected=sourceTestCommand(group,workspace,report);assert(Date.now()<deadline,'native_source_total_deadline');
   const output=command(selected.binary,selected.args,selected.cwd,Math.min(180000,deadline-Date.now()));let counts,reportSha256;
   if(group.project==='node-tap'){counts=inspectNodeTap(output,group.expectedPassed);reportSha256=hash(output);}else{const raw=readFileSync(report);assert(raw.length<=16*1024**2);counts=inspectVitestReport(JSON.parse(raw),group,workspace);reportSha256=hash(raw);}
   evidence.groups.push({path:group.path,project:group.project,selection:group.selection,...(group.fullNames?{fullNames:group.fullNames}:{}),sourceSha256:hash(readFileSync(join(workspace,group.path))),reportSha256,...counts});save();
  }
  command('git',['diff','--exit-code','HEAD','--']);evidence.phase='source-qualified';evidence.status='passed';evidence.passed=evidence.groups.reduce((n,g)=>n+g.passed,0);evidence.failed=0;evidence.skipped=0;
 }catch(error){const capacity=nativeCapacityFailure(error);if(capacity)evidence.capacityRefusal=capacity;evidence.status='failed';evidence.failedPhase=evidence.phase;evidence.failureCode=error?.code==='ERR_ASSERTION'?'ERR_ASSERTION':'NATIVE_SOURCE_FAILED';process.exitCode=1;}
 finally{evidence.finishedAt=new Date().toISOString();save();console.log(JSON.stringify(evidence));}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await qualify();
