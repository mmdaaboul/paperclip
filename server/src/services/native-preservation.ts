import {finishedFailedIdleLease} from "./idle-work-proof.js";
import { createHash, createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { NativeMaintenanceHold, type MaintenanceHandle } from "./native-maintenance-hold.js";
import { verifyNativeMaintenanceBoot } from "./native-maintenance-server.js";
import { idleWorkSnapshot } from "./task-admission.js";

export interface PreservationColumn extends Record<string, unknown> { name: string; type: string; notNull: boolean; default: string | null }
export interface PreservationTable { schema: string; name: string; columns: PreservationColumn[]; primaryKey: string[]; rows: Record<string, Record<string, string>> }
export interface PreservationSequence { schema: string; name: string; type: string; start: string; min: string; max: string; increment: string; cycle: boolean; last: string; called: boolean }
export interface NativePreservationSnapshot {
  schema: "paperclip.native-preservation.v1"; instanceId: string; holdId: string; bootId: string; commit: string;
  keyId: string; database: string; coverage: "all_non_system_tables" | "fixture_subset";
  tables: PreservationTable[]; sequences: PreservationSequence[]; digest: string;
}
export interface PreservationCompatibility {
  /** Each name is exact schema.table; never wildcards. Existing rows never exempt. */
  allowNewRows?: string[]; allowNewTables?: string[]; allowNewSequences?: string[]; allowAdvancedSequences?: string[];
  allowNewColumns?: { table: string; column: PreservationColumn }[];
}
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
};
export const preservationDigest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const hmac = (key: Buffer, value: unknown) => createHmac("sha256", key).update(canonical(value)).digest("hex");
const validateKey = (key: Buffer) => { if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("preservation_private_256bit_key_required"); };
const nonSystem = "n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'";

/** Actual native createDb transaction: RR/read-only, bounded pages, all columns
 * and stable row keys. The subset argument is test-only; production consumer
 * below does not expose it. No raw rows/secrets appear in the proof.
 */
export async function readNativePreservationContent(db: Db, key: Buffer, fixtureSchemas?: string[]): Promise<{ database: string; coverage: NativePreservationSnapshot["coverage"]; tables: PreservationTable[]; sequences: PreservationSequence[] }> {
  validateKey(key);
  if (fixtureSchemas && (!fixtureSchemas.length || fixtureSchemas.some(s => !/^pc_no21_[a-z0-9_]+$/.test(s)))) throw new Error("preservation_fixture_schema_required");
  return db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
    await tx.execute(sql`SET LOCAL timezone = 'UTC'`);
    await tx.execute(sql`SET LOCAL datestyle = 'ISO, YMD'`);
    await tx.execute(sql`SET LOCAL extra_float_digits = 3`);
    await tx.execute(sql`SET LOCAL bytea_output = 'hex'`);
    const mode = await tx.execute<{ isolation: string; readonly: string; database: string }>(sql`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly,current_database() AS database`);
    if (mode[0]?.isolation !== "repeatable read" || mode[0].readonly !== "on") throw new Error("preservation_snapshot_transaction_unproven");
    const found = await tx.execute<{ schema: string; name: string }>(sql.raw(`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND ${nonSystem} ORDER BY n.nspname,c.relname`));
    const selected = found.filter(t => !fixtureSchemas || fixtureSchemas.includes(t.schema));
    if (selected.length > 1000 || selected.length === 0) throw new Error("preservation_catalog_scope_unsupported");
    const tables: PreservationTable[] = [];
    for (const table of selected) {
      const qualified = `${quote(table.schema)}.${quote(table.name)}`;
      const columns = await tx.execute<PreservationColumn>(sql`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS "notNull",pg_get_expr(d.adbin,d.adrelid) AS default FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname=${table.schema} AND c.relname=${table.name} AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`);
      const keys = await tx.execute<{ name: string }>(sql`SELECT a.attname AS name FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY AS u(attnum,position) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=u.attnum WHERE k.contype='p' AND n.nspname=${table.schema} AND c.relname=${table.name} ORDER BY u.position`);
      const primaryKey = keys.map(k => k.name); const rows: PreservationTable["rows"] = Object.create(null);
      if (!columns.length || columns.length > 512) throw new Error(`preservation_columns_unsupported:${table.schema}.${table.name}`);

      let offset = 0;
      for (;;) {
        const batch = await tx.execute<{ values: Record<string, string | null> }>(sql.raw(`SELECT (SELECT jsonb_object_agg(k,v::text) FROM jsonb_each(to_jsonb(t)) AS e(k,v)) AS values FROM ${qualified} t ${primaryKey.length ? `ORDER BY ${primaryKey.map(quote).join(",")}` : ""} LIMIT 100 OFFSET ${offset}`));
        if (batch.length && primaryKey.length === 0) throw new Error(`preservation_stable_key_missing:${table.schema}.${table.name}`);
        for (const row of batch) {
          if (Buffer.byteLength(canonical(row.values)) > 1024 * 1024) throw new Error("preservation_row_size_unsupported");
          const rowKey = hmac(key, { table, key: primaryKey.map(c => [c, row.values[c]]) });
          if (rows[rowKey]) throw new Error("preservation_duplicate_key");
          rows[rowKey] = Object.fromEntries(columns.map(c => [c.name, hmac(key, { table, rowKey, column: c.name, value: row.values[c.name] })]));
        }
        offset += batch.length; if (offset > 1000000) throw new Error("preservation_row_capacity_unsupported");
        if (batch.length < 100) break;
      }
      tables.push({ ...table, columns: [...columns], primaryKey, rows });
    }
    const sequenceCatalog = await tx.execute<Omit<PreservationSequence, "last" | "called"> & Record<string,unknown>>(sql.raw(`SELECT n.nspname AS schema,c.relname AS name,format_type(s.seqtypid,NULL) AS type,s.seqstart::text AS start,s.seqmin::text AS min,s.seqmax::text AS max,s.seqincrement::text AS increment,s.seqcycle AS cycle FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${nonSystem} ORDER BY n.nspname,c.relname`));
    const sequences: PreservationSequence[] = [];
    for (const sequence of sequenceCatalog.filter(v => !fixtureSchemas || fixtureSchemas.includes(v.schema))) {
      const row = await tx.execute<{ last: string; called: boolean }>(sql.raw(`SELECT last_value::text AS last,is_called AS called FROM ${quote(sequence.schema)}.${quote(sequence.name)}`));
      if (row.length !== 1 || !/^-?\d+$/.test(row[0].last) || typeof row[0].called !== "boolean") throw new Error("preservation_sequence_state_unknown");
      sequences.push({ ...sequence, ...row[0] });
    }
    return { database: mode[0].database, coverage: fixtureSchemas ? "fixture_subset" as const : "all_non_system_tables" as const, tables, sequences };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export function compareNativePreservation(before: NativePreservationSnapshot, after: NativePreservationSnapshot, compatibility: PreservationCompatibility = {}): void {
  const { digest: bd, ...b } = before, { digest: ad, ...a } = after;
  if (preservationDigest(b) !== bd || preservationDigest(a) !== ad) throw new Error("preservation_proof_digest_changed");
  if (before.schema !== after.schema || before.instanceId !== after.instanceId || before.holdId !== after.holdId || before.keyId !== after.keyId || before.database !== after.database || before.coverage !== after.coverage) throw new Error("preservation_proof_binding_changed");
  const found = new Map(after.tables.map(t => [`${t.schema}.${t.name}`, t]));
  for (const baseline of before.tables) {
    const name = `${baseline.schema}.${baseline.name}`, current = found.get(name); if (!current) throw new Error(`preservation_table_lost:${name}`);
    if (canonical(current.primaryKey) !== canonical(baseline.primaryKey)) throw new Error(`preservation_key_changed:${name}`);
    const columns = new Map(current.columns.map(c => [c.name, c]));
    for (const column of baseline.columns) if (canonical(column) !== canonical(columns.get(column.name))) throw new Error(`preservation_column_conflict:${name}.${column.name}`);
    for (const column of current.columns) if (!baseline.columns.some(c => c.name === column.name) && !compatibility.allowNewColumns?.some(c => c.table === name && canonical(c.column) === canonical(column))) throw new Error(`preservation_unqualified_column:${name}.${column.name}`);
    for (const [identity, oldRow] of Object.entries(baseline.rows)) {
      const row = current.rows[identity]; if (!row) throw new Error(`preservation_existing_row_lost:${name}`);
      for (const column of baseline.columns) if (row[column.name] !== oldRow[column.name]) throw new Error(`preservation_existing_content_changed:${name}.${column.name}`);
    }
    if (Object.keys(current.rows).some(id => !baseline.rows[id]) && !compatibility.allowNewRows?.includes(name)) throw new Error(`preservation_unqualified_new_row:${name}`);
    found.delete(name);
  }
  for (const name of found.keys()) if (!compatibility.allowNewTables?.includes(name)) throw new Error(`preservation_unqualified_table:${name}`);
  const sequences = new Map(after.sequences.map(v => [`${v.schema}.${v.name}`,v]));
  for (const baseline of before.sequences) {
    const name = `${baseline.schema}.${baseline.name}`, current = sequences.get(name); if (!current) throw new Error(`preservation_sequence_lost:${name}`);
    const {last:oldValue,called:oldCalled,...oldShape}=baseline, {last:newValue,called:newCalled,...newShape}=current;
    if (canonical(oldShape)!==canonical(newShape)) throw new Error(`preservation_sequence_conflict:${name}`);
    if (oldValue!==newValue || oldCalled!==newCalled) {
      const advanced=BigInt(baseline.increment)>0n ? BigInt(newValue)>=BigInt(oldValue) : BigInt(newValue)<=BigInt(oldValue);
      if (!advanced || oldCalled && !newCalled || !compatibility.allowAdvancedSequences?.includes(name)) throw new Error(`preservation_sequence_changed:${name}`);
    }
    sequences.delete(name);
  }
  for (const name of sequences.keys()) if (!compatibility.allowNewSequences?.includes(name)) throw new Error(`preservation_unqualified_sequence:${name}`);
}

/** Persistence is checked in addition to the native maintenance-only boot. A
 * terminal run label is insufficient for external/machine processes; such
 * layouts must remain unsupported until their owner receipts are qualified.
 */
export async function assertNativeMaintenanceWorkStopped(db: Db): Promise<void> {
  const checks = [
    "SELECT 1 FROM heartbeat_runs WHERE status NOT IN ('succeeded','failed','cancelled','timed_out','interrupted') OR cost_accounting_pending",
    "SELECT 1 FROM workspace_operations WHERE status NOT IN ('succeeded','failed','cancelled')",
    `SELECT 1 FROM environment_leases l WHERE l.status NOT IN ('released','expired') AND (${finishedFailedIdleLease("l")}) IS NOT TRUE`,
    "SELECT 1 FROM decision_invocations WHERE status='running'",
    "SELECT 1 FROM prompt_injection_invocations WHERE status='running'",
    "SELECT 1 FROM github_push_operation_receipts WHERE state IN ('pending','uncertain')",
    "SELECT 1 FROM reviewer_github_operations WHERE status IN ('pending','writing','uncertain')",
  ];
  await db.transaction(async tx => {
    for (const query of checks) { const result = await tx.execute<{ blocked: boolean }>(sql.raw(`SELECT EXISTS(${query}) AS blocked`)); if (result[0]?.blocked !== false) throw new Error("native_maintenance_persisted_work_present"); }
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Production caller supplies a private HMAC key, never config/env proof flags.
 * The live boot is revalidated on either side of actual content capture.
 */
export async function captureNativePreservation(input: { db: Db; hold: NativeMaintenanceHold; handle: MaintenanceHandle; key: Buffer; commit: string }): Promise<NativePreservationSnapshot> {
  validateKey(input.key); const before = idleWorkSnapshot(); if (before.active) throw new Error("native_maintenance_local_work_present");
  const boot = await verifyNativeMaintenanceBoot(input.hold, input.handle, input.commit);
  await assertNativeMaintenanceWorkStopped(input.db);
  const content = await readNativePreservationContent(input.db, input.key);
  for (const name of ["companies", "agents", "projects", "issues", "heartbeat_runs", "activity_log", "agent_reviewer_policies", "reviewer_github_operations", "agent_reference_folder_configs", "github_push_operation_receipts", "issue_review_cycle_budgets", "issue_scoped_reviews"]) {
    if (!content.tables.some(table => table.schema === "public" && table.name === name)) throw new Error(`preservation_selected_feature_schema_missing:${name}`);
  }
  await assertNativeMaintenanceWorkStopped(input.db);
  const after = idleWorkSnapshot(); const again = await verifyNativeMaintenanceBoot(input.hold, input.handle, input.commit);
  if (after.active !== 0 || before.generation !== after.generation || boot.bootId !== again.bootId) throw new Error("native_maintenance_work_or_boot_changed");
  const result = { schema: "paperclip.native-preservation.v1" as const, instanceId: input.handle.instanceId, holdId: input.handle.holdId, bootId: boot.bootId,
    commit: input.commit, keyId: hmac(input.key, "paperclip.private-preservation-key.v1"), ...content };
  return { ...result, digest: preservationDigest(result) };
}
export async function captureNativePreservationBaseline(input: Parameters<typeof captureNativePreservation>[0]): Promise<NativePreservationSnapshot> {
  const state = input.hold.authorize(input.handle); if (input.commit !== state.installedSha || state.phase !== "draining") throw new Error("preservation_baseline_source_or_phase");
  const proof = await captureNativePreservation(input); input.hold.bindBaseline(input.handle, proof.digest); return proof;
}
export async function verifyNativePreservationCandidate(input: Parameters<typeof captureNativePreservation>[0] & { baseline: NativePreservationSnapshot; compatibility?: PreservationCompatibility }): Promise<NativePreservationSnapshot> {
  const state = input.hold.authorize(input.handle); if (input.commit !== state.candidateSha || input.baseline.digest !== state.baselineDigest || input.baseline.coverage !== "all_non_system_tables") throw new Error("preservation_candidate_source_or_baseline");
  try { const proof = await captureNativePreservation(input); compareNativePreservation(input.baseline, proof, input.compatibility); input.hold.bindVerified(input.handle, input.baseline.digest, proof.digest); return proof; }
  catch (error) { input.hold.recovery(input.handle, "preservation_validation_failed"); throw error; }
}
