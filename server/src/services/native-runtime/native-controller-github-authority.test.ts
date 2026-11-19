import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { and,eq } from "drizzle-orm";
import { agents,authUsers,companies,companyMemberships,heartbeatRuns,issues,agentReviewerPolicies } from "@paperclipai/db";
import { reviewerNativeTestDatabase } from "../../__tests__/helpers/reviewer-native-database.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { createNativeAttributedGitScope } from "./native-attributed-git-scope.js";
import type { NativeControllerGitActions } from "./native-controller-github.js";
// Actual native tool authority/auth/PG. Closed producer is a controlled seam;
// no provider, credential, GitHub request, model or child process executes here.
let fixture:Awaited<ReturnType<typeof reviewerNativeTestDatabase>>;
beforeAll(async()=>{fixture=await reviewerNativeTestDatabase();},30000);
afterAll(async()=>{await fixture?.end();});
async function seed(){
 const db=fixture.db,userId=randomUUID(),now=new Date();
 await db.insert(authUsers).values({id:userId,name:"Synthetic owner",email:`${userId}@example.test`,createdAt:now,updatedAt:now});
 const [company]=await db.insert(companies).values({name:"Controller authority fixture",issuePrefix:`GA${randomUUID().slice(0,7)}`}).returning();
 await db.insert(companyMemberships).values({companyId:company.id,principalType:"user",principalId:userId,status:"active",membershipRole:"owner"});
 const [agent]=await db.insert(agents).values({companyId:company.id,name:"Builder name",role:"engineer",status:"active",adapterType:"paperclip_runner",adapterConfig:{provider:"codex",githubWriteMode:"native_controller"}}).returning();
 const [issue]=await db.insert(issues).values({companyId:company.id,title:"Exact GitHub task",status:"in_progress",assigneeAgentId:agent.id,responsibleUserId:userId}).returning();
 const [run]=await db.insert(heartbeatRuns).values({companyId:company.id,agentId:agent.id,issueId:issue.id,nativeIssueId:issue.id,runtimeMode:"native",status:"running",responsibleUserId:userId,contextSnapshot:{issueId:issue.id}}).returning();
 await db.update(issues).set({executionRunId:run.id}).where(eq(issues.id,issue.id));
 const scope=createNativeAttributedGitScope();let calls=0;
 const action=(name:string)=>({definition:{name,inputSchema:{type:"object"}},execute:async(_input:unknown,authorize:()=>Promise<unknown>)=>scope.track(async()=>{const current=await authorize();scope.signal.throwIfAborted();calls++;return current;})});
 const actions={push:action("push_git_commit"),comment:action("comment_github_pull_request"),abort:()=>scope.abort(),retire:()=>scope.retire()} as unknown as NativeControllerGitActions;
 const binding={companyId:company.id,agentId:agent.id,issueId:issue.id,runId:run.id,workMode:"standard" as const,controllerGitActions:actions};
 return {db,userId,company,agent,issue,run,scope,actions,binding,get calls(){return calls;},authority:new PaperclipRunnerToolAuthority(db,binding)};
}
describe("actual native controller GitHub authority",()=>{
 it("advertises selected closed actions and reauthorizes actual issue mutation before the producer",async()=>{
  const f=await seed();expect(f.authority.definitions().map(t=>t.name)).toEqual(expect.arrayContaining(["push_git_commit","comment_github_pull_request"]));
  const result=await f.authority.execute({tool:"push_git_commit",callId:randomUUID(),arguments:{}}) as any;
  expect(result.run.id).toBe(f.run.id);expect(result.actor.id).toBe(f.agent.id);expect(f.calls).toBe(1);f.authority.close();await f.authority.settle();
 });
 it("does not treat a readable task as delegated permission to write",async()=>{
  const f=await seed();await f.db.update(companyMemberships).set({status:"revoked"}).where(and(eq(companyMemberships.companyId,f.company.id),eq(companyMemberships.principalId,f.userId)));
  await expect(f.authority.execute({tool:"push_git_commit",callId:randomUUID(),arguments:{}})).rejects.toThrow();expect(f.calls).toBe(0);f.authority.close();await f.authority.settle();
 });
 it.each(["protected","stage","scoped","planning","first-party"])("does not grant controller writes to %s admission",async kind=>{
  const f=await seed();
  if(kind==="protected")await f.db.insert(agentReviewerPolicies).values({companyId:f.company.id,agentId:f.agent.id,revision:1,enabled:true,updatedByUserId:f.userId});
  const binding={...f.binding,...(kind==="protected"?{reviewerRole:true}:{}),...(kind==="stage"?{nativeStageReview:{nativeStageDecisionId:randomUUID(),nativeStageAdmissionId:randomUUID(),nativeStageStatusVersion:1}}:{}),...(kind==="scoped"?{nativeReview:{nativeReviewInteractionId:randomUUID(),nativeReviewDecisionId:randomUUID()}}:{}),...(kind==="planning"?{workMode:"planning" as const}:{}),...(kind==="first-party"?{firstPartyOnly:true}:{})};
  const authority=new PaperclipRunnerToolAuthority(f.db,binding);
  expect(authority.definitions().map(t=>t.name)).not.toContain("push_git_commit");
  await expect(authority.execute({tool:"push_git_commit",callId:randomUUID(),arguments:{}})).rejects.toMatchObject({status:403});expect(f.calls).toBe(0);authority.close();await authority.settle();
 });
 it("recovery never starts a second closed write and completed-run authority refuses",async()=>{
  const f=await seed();expect(await f.authority.recover({tool:"push_git_commit",callId:randomUUID(),arguments:{}})).toBeNull();expect(f.calls).toBe(0);
  await f.db.update(heartbeatRuns).set({status:"succeeded"}).where(eq(heartbeatRuns.id,f.run.id));await expect(f.authority.execute({tool:"comment_github_pull_request",callId:randomUUID(),arguments:{}})).rejects.toThrow();expect(f.calls).toBe(0);f.authority.close();await f.authority.settle();
 });
 it("authority retirement aborts synchronously and joins its outstanding operation",async()=>{
  const f=await seed();let release!:()=>void,settled=false;const gate=new Promise<void>(resolve=>{release=resolve;});
  const pending=f.scope.track(async()=>{await gate;f.scope.signal.throwIfAborted();});const observed=pending.catch(()=>{});
  f.authority.close();expect(f.scope.signal.aborted).toBe(true);const drain=f.authority.settle().then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);release();await Promise.all([observed,drain]);expect(settled).toBe(true);
 });
});
