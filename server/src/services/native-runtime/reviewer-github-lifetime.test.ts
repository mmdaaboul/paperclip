import {randomUUID} from "node:crypto";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {reviewerNativeTestDatabase} from "../../__tests__/helpers/reviewer-native-database.js";
import type {ReviewerGitHubAuthorization} from "../reviewer-github-actions.js";
import type {NativeSession} from "../../vendor/paperclip-runner/index.js";
import {bindNativeControllerGitSession} from "./native-controller-github-session.js";
const state=vi.hoisted(()=>({scope:undefined as unknown as ReviewerGitHubAuthorization,calls:0,holdAt:0,entered:()=>{},gate:Promise.resolve()}));
vi.mock("./reviewer-github-authorization.js",()=>({nativeReviewerGitHubAuthorization:()=>async()=>{if(++state.calls===state.holdAt){state.entered();await state.gate;}return state.scope;}}));
vi.mock("./reviewer-runtime-admission.js",()=>({nativeReviewerRuntimeQualification:()=>async()=>{},validateNativeReviewerExecution:async()=>{}}));
vi.mock("./reviewer-github-private-identity.js",()=>({nativeReviewerPrivateToken:async()=>"synthetic-test-token"}));
import {bindNativeReviewerDiscussionLifetime} from "./reviewer-github-native-actions.js";
// Actual native action/receipt store and migrated PG; the admitted identity,
// provider transport and native control handle are explicit controlled seams.
// No Git writer, credential lookup, external provider or model is invoked.
let fixture:Awaited<ReturnType<typeof reviewerNativeTestDatabase>>;
beforeAll(async()=>{fixture=await reviewerNativeTestDatabase();},30000);
afterAll(async()=>{await fixture?.end();});
beforeEach(()=>{state.calls=0;state.holdAt=0;state.entered=()=>{};state.gate=Promise.resolve();});
async function seed(){
 const companyId=randomUUID(),agentId=randomUUID(),runId=randomUUID(),issueId=randomUUID(),projectId=randomUUID();
 await fixture.query("INSERT INTO companies(id,name,issue_prefix) VALUES($1,'Lifetime fixture',$2)",[companyId,`LF${companyId.slice(0,7)}`]);
 await fixture.query("INSERT INTO agents(id,company_id,name) VALUES($1,$2,'Reviewer lifetime')",[agentId,companyId]);
 await fixture.query("INSERT INTO projects(id,company_id,name) VALUES($1,$2,'Lifetime project')",[projectId,companyId]);
 await fixture.query("INSERT INTO issues(id,company_id,project_id,title) VALUES($1,$2,$3,'Lifetime candidate')",[issueId,companyId,projectId]);
 await fixture.query("INSERT INTO heartbeat_runs(id,company_id,agent_id,status,runtime_mode,native_issue_id) VALUES($1,$2,$3,'running','native',$4)",[runId,companyId,agentId,issueId]);
 const binding={companyId,agentId,runId,issueId,projectId};
 state.scope={binding,agentName:"Reviewer lifetime",role:{enabled:true,configuredBy:"board",revision:"1",projectIds:[projectId],repositoryIds:["99"]},assignment:{id:randomUUID(),current:true,reviewerAgentId:agentId,builderAgentId:randomUUID(),kind:"native_completion_review"},runtime:{filesystemQualified:true,rawCredentialExportDenied:true,hostCredentialFallbackDenied:true,trustKind:"standard"},repositoryId:"99",repository:"fixture/repo",pullNumber:7,headSha:"b".repeat(40)};
 const call={tool:"reviewer_pr_comment",arguments:{body:"Scoped review",idempotencyKey:randomUUID()}};
 return {binding,call};
}
const pull={number:7,node_id:"pull-node",html_url:"https://github.com/fixture/repo/pull/7",head:{sha:"b".repeat(40)},base:{repo:{id:99,full_name:"fixture/repo"}}};
describe("native non-Git Reviewer operation retirement",()=>{
 it.each(["close","cancel","detach"] as const)("%s revokes at final prewrite wait and joins the current warm epoch",async control=>{
  const f=await seed();let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;});state.gate=new Promise<void>(r=>{release=r;});state.entered=entered;state.holdAt=4;
  let posts=0;const fetchImpl:typeof fetch=async(_input,init)=>{if(init?.method==="POST")posts++;return new Response(JSON.stringify(pull),{status:200});};
  const tools=bindNativeReviewerDiscussionLifetime(fixture.db,f.binding,fetchImpl);
  const old={revoke:vi.fn(),settle:vi.fn(async()=>{})};let current:{revoke:()=>void;settle:()=>Promise<void>}=old;
  const session={close:async()=>{},cancel:()=>({cleanup:Promise.resolve()}),interrupt:async()=>{},detachControllerForRestart:async()=>{}} as unknown as NativeSession;
  bindNativeControllerGitSession(session,()=>current);current={revoke:()=>tools.close(),settle:()=>tools.settle()};bindNativeControllerGitSession(session,()=>current);
  const work=tools.execute(f.call);await ready;
  let settled=false;const cleanup=(control==="cancel"?session.cancel!({reason:"Synthetic Stop"} as never).cleanup:control==="detach"?session.detachControllerForRestart!():session.close({reason:"Synthetic retirement"})).then(()=>{settled=true;});
  await Promise.resolve();expect(settled).toBe(false);expect(old.revoke).not.toHaveBeenCalled();release();
  expect(await work).toMatchObject({status:"rejected"});await cleanup;expect(settled).toBe(true);expect(posts).toBe(0);
  expect((await fixture.query("SELECT status,receipt FROM reviewer_github_operations WHERE run_id=$1",[f.binding.runId])).rows).toMatchObject([{status:"rejected",receipt:null}]);
  expect(()=>tools.execute(f.call)).toThrow();
 });
 it("retains an in-flight POST as uncertain and a fresh epoch cannot repeat its stable key",async()=>{
  const f=await seed();let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});let posts=0;let signal:AbortSignal|undefined;
  const fetchImpl:typeof fetch=async(_input,init)=>{if(init?.method==="POST"){posts++;signal=init.signal??undefined;entered();await gate;return new Response(JSON.stringify({id:123,html_url:pull.html_url+"#issuecomment-123"}),{status:200});}return new Response(JSON.stringify(pull),{status:200});};
  const tools=bindNativeReviewerDiscussionLifetime(fixture.db,f.binding,fetchImpl);const work=tools.execute(f.call);await ready;
  tools.close();expect(signal?.aborted).toBe(true);let settled=false;const drain=tools.settle().then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);release();expect(await work).toMatchObject({status:"uncertain"});await drain;
  const successor=bindNativeReviewerDiscussionLifetime(fixture.db,f.binding,fetchImpl);expect(await successor.execute(f.call)).toMatchObject({status:"uncertain"});expect(posts).toBe(1);successor.close();await successor.settle();
  expect((await fixture.query("SELECT status,receipt FROM reviewer_github_operations WHERE run_id=$1",[f.binding.runId])).rows).toMatchObject([{status:"uncertain",receipt:null}]);
 });
});
