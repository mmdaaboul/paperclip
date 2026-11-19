import type { Db } from "@paperclipai/db";
import { GitPushAttributionError, type GitPushReceipt, type GitPushReceiptStore } from "./github-attributed-push.js";

/** Adapt the existing database driver's parameterized query API; no new driver. */
export interface PushReceiptSqlClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  transaction<T>(work:(tx:Pick<PushReceiptSqlClient,"query">)=>Promise<T>):Promise<T>;
}

function tableIdentifier(name: string): string {
  const parts = name.split(".");
  if (parts.length > 2 || parts.some(part => !/^[a-z_][a-z0-9_]{0,62}$/.test(part))) throw new Error("Invalid push receipt table identifier");
  return parts.map(part => `"${part}"`).join(".");
}

/** Unnumbered schema recipe. Root owns actual Drizzle migration generation. */
export function gitPushReceiptSchemaSql(table = "github_push_operation_receipts"): string {
  return `CREATE TABLE ${tableIdentifier(table)} (
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    run_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    binding jsonb NOT NULL,
    request jsonb NOT NULL,
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
    state text NOT NULL CHECK (state IN ('pending','confirmed','no_change','failed','uncertain')),
    reason text,
    confirmation_source text CHECK (confirmation_source IS NULL OR confirmation_source = 'git_receive_pack_status'),
    created_at timestamptz NOT NULL,
    finished_at timestamptz,
    UNIQUE(company_id,agent_id,run_id,idempotency_key),
    CHECK (binding->>'companyId' = company_id::text AND binding->>'agentId' = agent_id::text AND binding->>'runId' = run_id::text),
    CHECK (request->>'idempotencyKey' = idempotency_key::text),
    CHECK ((state = 'confirmed') = (confirmation_source IS NOT NULL)),
    CHECK ((state = 'pending') = (finished_at IS NULL))
  );`;
}

function decode(row: Record<string, unknown>): GitPushReceipt {
  const timestamp = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
  return { id: String(row.id), binding: row.binding as GitPushReceipt["binding"], request: row.request as GitPushReceipt["request"],
    fingerprint: String(row.fingerprint), state: row.state as GitPushReceipt["state"], reason: row.reason === null ? null : String(row.reason),
    confirmationSource: row.confirmation_source as GitPushReceipt["confirmationSource"], createdAt: timestamp(row.created_at),
    finishedAt: row.finished_at === null ? null : timestamp(row.finished_at) };
}

export function createPostgresGitPushReceiptStore(db: PushReceiptSqlClient, table = "github_push_operation_receipts"): GitPushReceiptStore {
  const name = tableIdentifier(table);
  return {
    async begin(receipt) {
      return db.transaction(async tx=>{
      const scope=JSON.stringify([receipt.binding.companyId,receipt.binding.repositoryId,receipt.request.ref]);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[scope]);
      const previous=await tx.query(`SELECT * FROM ${name} WHERE company_id=$1 AND agent_id=$2 AND run_id=$3 AND idempotency_key=$4`,
        [receipt.binding.companyId,receipt.binding.agentId,receipt.binding.runId,receipt.request.idempotencyKey]);
      if(previous.rows[0])return {created:false,receipt:decode(previous.rows[0])};
      // Different keys, agents or runs cannot bypass unresolved remote effects.
      // The separate statement after the lock observes a concurrent commit.
      const unresolved=await tx.query(`SELECT id FROM ${name} WHERE company_id=$1 AND binding->>'repositoryId'=$2 AND request->>'ref'=$3 AND state IN ('pending','uncertain') LIMIT 1`,
        [receipt.binding.companyId,receipt.binding.repositoryId,receipt.request.ref]);
      if(unresolved.rows[0])throw new GitPushAttributionError("push_branch_reconciliation_required",409);
      const inserted = await tx.query(`INSERT INTO ${name}
        (id,company_id,agent_id,run_id,idempotency_key,binding,request,fingerprint,state,reason,confirmation_source,created_at,finished_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,'pending',NULL,NULL,$9,NULL)
        ON CONFLICT(company_id,agent_id,run_id,idempotency_key) DO NOTHING RETURNING *`,
      [receipt.id, receipt.binding.companyId, receipt.binding.agentId, receipt.binding.runId, receipt.request.idempotencyKey,
        JSON.stringify(receipt.binding), JSON.stringify(receipt.request), receipt.fingerprint, receipt.createdAt]);
      if (inserted.rows[0]) return { created: true, receipt: decode(inserted.rows[0]) };
      const existing = await tx.query(`SELECT * FROM ${name} WHERE company_id=$1 AND agent_id=$2 AND run_id=$3 AND idempotency_key=$4`,
        [receipt.binding.companyId, receipt.binding.agentId, receipt.binding.runId, receipt.request.idempotencyKey]);
      if (!existing.rows[0]) throw new GitPushAttributionError("push_intent_unavailable", 503);
      return { created: false, receipt: decode(existing.rows[0]) };
      });
    },
    async finish(id, fingerprint, result) {
      if (result.state === "pending" || !result.finishedAt || (result.state === "confirmed") !== (result.confirmationSource === "git_receive_pack_status")) {
        throw new Error("Invalid push receipt settlement");
      }
      const updated = await db.query(`UPDATE ${name} SET state=$3,reason=$4,confirmation_source=$5,finished_at=$6
        WHERE id=$1 AND fingerprint=$2 AND state='pending' RETURNING *`,
        [id, fingerprint, result.state, result.reason, result.confirmationSource, result.finishedAt]);
      if (updated.rows[0]) return decode(updated.rows[0]);
      const previous = await db.query(`SELECT * FROM ${name} WHERE id=$1 AND fingerprint=$2`, [id, fingerprint]);
      if (!previous.rows[0]) throw new GitPushAttributionError("push_receipt_unavailable", 503);
      // A response lost after a confirmed commit must not erase that fact.
      return decode(previous.rows[0]);
    },
  };
}

/** Use the native pool; lock acquisition and conflict reads share one transaction. */
export function nativeGitPushReceiptSql(db:Db):PushReceiptSqlClient {
  const projection=(client:Pick<Db["$client"],"unsafe">)=>({async query(statement:string,values:readonly unknown[]=[]){return {rows:[...await client.unsafe(statement,values as Parameters<Db["$client"]["unsafe"]>[1])]};}});
  return {...projection(db.$client),async transaction<T>(work:(tx:Pick<PushReceiptSqlClient,"query">)=>Promise<T>):Promise<T>{
    return await db.$client.begin("isolation level read committed",tx=>work(projection(tx as unknown as Db["$client"]))) as T;
  }};
}
