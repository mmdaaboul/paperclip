import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, mkdtempSync, realpathSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createDb, ensurePostgresDatabase, applyPendingMigrations, runDatabaseBackup, runDatabaseRestore, type Db } from "@paperclipai/db";
import {reviewerNativeTestDatabase} from "../__tests__/helpers/reviewer-native-database.js";
import { NativeMaintenanceHold, type MaintenanceHandle } from "./native-maintenance-hold.js";
import { startNativeMaintenanceServer } from "./native-maintenance-server.js";
import { captureNativePreservationBaseline, verifyNativePreservationCandidate, assertNativeMaintenanceWorkStopped, readNativePreservationContent } from "./native-preservation.js";
const key=randomBytes(32),old="a".repeat(40),next="b".repeat(40),companies:string[]=[];
let fixture:Awaited<ReturnType<typeof reviewerNativeTestDatabase>>;
let db:Db,hold:NativeMaintenanceHold,handle:MaintenanceHandle,root:string,company:string,agent:string,run:string;
let close:(()=>Promise<void>)|undefined;
beforeAll(async()=>{fixture=await reviewerNativeTestDatabase();db=fixture.db;},30000);
beforeEach(async()=>{company=randomUUID();agent=randomUUID();run=randomUUID();const project=randomUUID(),issue=randomUUID();companies.push(company);const client=db.$client;
 await client.unsafe("INSERT INTO companies(id,name,issue_prefix) VALUES($1,'No21 full-native fixture',$2)",[company,"N"+randomUUID().replaceAll('-','').slice(0,12)]);
 await client.unsafe("INSERT INTO agents(id,company_id,name,status) VALUES($1,$2,'Native fixture agent','paused')",[agent,company]);
 await client.unsafe("INSERT INTO projects(id,company_id,name) VALUES($1,$2,'Native fixture project')",[project,company]);
 await client.unsafe("INSERT INTO issues(id,company_id,project_id,title,status) VALUES($1,$2,$3,'Retained fixture task','done')",[issue,company,project]);
 await client.unsafe("INSERT INTO heartbeat_runs(id,company_id,agent_id,status,finished_at) VALUES($1,$2,$3,'succeeded',now())",[run,company,agent]);
 await client.unsafe("INSERT INTO agent_reviewer_policies(company_id,agent_id,revision,enabled,updated_by_user_id) VALUES($1,$2,1,true,'fixture-owner')",[company,agent]);
 await client.unsafe("INSERT INTO agent_reference_folder_configs(company_id,agent_id,revision,entries,updated_by_user_id) VALUES($1,$2,1,'[]','fixture-owner')",[company,agent]);
 await client.unsafe("INSERT INTO issue_review_cycle_budgets(issue_id,company_id,ledger) VALUES($1,$2,'{\"scope\":\"synthetic-content-only\"}')",[issue,company]);
 await client.unsafe("INSERT INTO issue_scoped_reviews(id,company_id,issue_id,snapshot,state) VALUES($1,$2,$3,'{\"scope\":\"synthetic-content-only\"}','draft')",[randomUUID(),company,issue]);
 const receipt=randomUUID(),requestKey=randomUUID();await client.unsafe("INSERT INTO github_push_operation_receipts(id,company_id,agent_id,run_id,idempotency_key,binding,request,fingerprint,state,created_at,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'failed',now(),now())",[receipt,company,agent,run,requestKey,JSON.stringify({companyId:company,agentId:agent,runId:run}),JSON.stringify({idempotencyKey:requestKey}),"f".repeat(64)]);
 await client.unsafe("INSERT INTO reviewer_github_operations(id,company_id,agent_id,run_id,issue_id,project_id,repository_id,repository,pull_number,head_sha,action,idempotency_key,request_hash,agent_name,status,request_payload) VALUES($1,$2,$3,$4,$5,$6,'99','fixture/repo',1,$7,'comment','fixture-op','fixture-hash','Native fixture agent','rejected','{}')",[randomUUID(),company,agent,run,issue,project,old]);
 root=realpathSync(mkdtempSync(join(process.env.TMPDIR!,'f09-full-native-')));chmodSync(root,0o700);hold=new NativeMaintenanceHold(root,'fixture');handle=hold.acquire(old,next);const server=await startNativeMaintenanceServer({hold,host:'127.0.0.1',port:0,commit:old,version:'fixture'});close=server.close;
});
afterEach(async()=>{if(close)await close();close=undefined;if(root)rmSync(root,{recursive:true,force:true});});
afterAll(async()=>{await fixture?.end();});
describe('actual native migrations/full schema and private maintenance capture consumers; simulated code replacement',()=>{
 it('captures every native/custom table and verifies unchanged settings/history across a real listener replacement before exact release',async()=>{
  await assertNativeMaintenanceWorkStopped(db);const baseline=await captureNativePreservationBaseline({db,hold,handle,key,commit:old});expect(baseline.coverage).toBe('all_non_system_tables');for(const name of ['agent_reviewer_policies','agent_reference_folder_configs','github_push_operation_receipts','reviewer_github_operations','issue_review_cycle_budgets','issue_scoped_reviews']){const table=baseline.tables.find(t=>t.name===name&&t.schema==='public');expect(table?.columns.length,name).toBeGreaterThan(0);expect(Object.keys(table!.rows).length,name).toBeGreaterThan(0);}
  await close!();const replacement=await startNativeMaintenanceServer({hold:new NativeMaintenanceHold(root,'fixture'),host:'127.0.0.1',port:0,commit:next,version:'fixture'});close=replacement.close;
  const after=await verifyNativePreservationCandidate({db,hold,handle,key,commit:next,baseline});expect(after.bootId).not.toBe(baseline.bootId);expect(hold.status()?.phase).toBe('verified');hold.release(handle,after.digest);expect(hold.status()).toBeNull();expect((await fetch(`http://127.0.0.1:${replacement.boot.port}/api/issues`)).status).toBe(503); // Release never hot-enables an app.
 },60000);
 it('actual changed No12 settings produce a sticky recovery hold rather than accepting equal row counts',async()=>{
  const baseline=await captureNativePreservationBaseline({db,hold,handle,key,commit:old});await close!();const replacement=await startNativeMaintenanceServer({hold,host:'127.0.0.1',port:0,commit:next,version:'fixture'});close=replacement.close;
  await db.$client.unsafe("UPDATE agent_reference_folder_configs SET revision=revision+1 WHERE company_id=$1 AND agent_id=$2",[company,agent]);await expect(verifyNativePreservationCandidate({db,hold,handle,key,commit:next,baseline})).rejects.toThrow('existing_content_changed');expect(hold.status()?.phase).toBe('recovery_required');expect(()=>hold.release(handle,baseline.digest)).toThrow('validation_required');
 },60000);
 it('persisted active run prevents baseline admission despite maintenance health',async()=>{await db.$client.unsafe("UPDATE heartbeat_runs SET status='running' WHERE id=$1",[run]);try{await expect(captureNativePreservationBaseline({db,hold,handle,key,commit:old})).rejects.toThrow('persisted_work_present');expect(hold.status()?.baselineDigest).toBeUndefined();}finally{await db.$client.unsafe("UPDATE heartbeat_runs SET status='succeeded' WHERE id=$1",[run]);}},60000);
 it('restores every native/custom table cell, column and sequence through native JavaScript backup without losing microseconds',async()=>{
  await db.$client.unsafe("UPDATE heartbeat_runs SET finished_at='2026-11-20 01:02:03.123456+00'::timestamptz WHERE id=$1",[run]);
  expect((await db.$client.unsafe("SELECT mod(extract(microseconds FROM finished_at)::bigint,1000)=456 AS precise FROM heartbeat_runs WHERE id=$1",[run]))[0]?.precise).toBe(true);
  const baseline=await captureNativePreservationBaseline({db,hold,handle,key,commit:old});
  const backup=await runDatabaseBackup({connectionString:fixture.connectionString,backupDir:join(root,'owned-native-backup'),backupEngine:'javascript',retention:{dailyDays:1,weeklyWeeks:1,monthlyMonths:1}});
  expect(backup.prunedCount).toBe(0);expect(backup.sizeBytes).toBeGreaterThan(0);
  const name='pc_f10_native_restore_'+randomUUID().replaceAll('-','');expect((await db.$client.unsafe('SELECT 1 FROM pg_database WHERE datname=$1',[name])).length).toBe(0);
  await db.$client.unsafe('CREATE DATABASE "'+name+'"');const url=new URL(fixture.connectionString);url.pathname='/'+name;let restored:Db|undefined;
  try{
   await runDatabaseRestore({connectionString:url.href,backupFile:backup.backupFile});restored=createDb(url.href,{maxConnections:1});const actual=await readNativePreservationContent(restored,key);
   expect(actual.database).not.toBe(baseline.database);expect(actual.coverage).toBe('all_non_system_tables');expect(actual.tables).toEqual(baseline.tables);expect(actual.sequences).toEqual(baseline.sequences);
   const unchanged=await readNativePreservationContent(db,key);expect(unchanged.tables).toEqual(baseline.tables);expect(unchanged.sequences).toEqual(baseline.sequences);
  }finally{await restored?.$client.end({timeout:5});await db.$client.unsafe('DROP DATABASE "'+name+'"');}
 },60000);

});
