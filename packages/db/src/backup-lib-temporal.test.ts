import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { runDatabaseBackup } from "./backup-lib.js";

const transport = vi.hoisted(() => ({ type: "", udt: "", value: null as string | null, projection: "" }));
vi.mock("postgres", () => ({ default: () => {
  const sql = async (parts: TemplateStringsArray) => {
    const query = parts.join("?");
    if (query.includes("FROM information_schema.tables")) return [{ schema_name: "public", tablename: "temporal_fixture" }];
    if (query.includes("FROM information_schema.columns")) return [{ column_name: "value", data_type: transport.type, udt_name: transport.udt, udt_schema: "pg_catalog", is_nullable: "YES", is_identity: "NO", column_default: null }];
    return [];
  };
  return Object.assign(sql, { end: async () => {}, unsafe: (query: string) => query.startsWith("SELECT count(*)") ? Promise.resolve([{ n: 1 }])
    : query.startsWith("SELECT ") && query.includes('FROM "public"."temporal_fixture"')
      ? { values: () => ({ cursor: async function* () { transport.projection = query; yield [[transport.value]]; } }) } : query });
} }));

describe("native JavaScript backup lossless temporal SQL", () => {
  it.each([
    ["timestamp without time zone", "timestamp", "2026-11-20 01:02:03.123456"],
    ["timestamp with time zone", "timestamptz", "2026-11-19 20:02:03.987654-05"],
    ["date", "date", "0001-01-01 BC"],
    ["ARRAY", "_timestamp", '[0:1][3:4]={{"2026-11-20 01:02:03.123456",NULL},{infinity,"2026-11-20 01:02:03.000001"}}'],
    ["ARRAY", "_timestamptz", '{"2026-11-19 20:02:03.987654-05",NULL,infinity}'],
    ["ARRAY", "_date", '{"0001-01-01 BC",NULL,infinity}'],
    ["timestamp with time zone", "timestamptz", null],
  ])("preserves backend %s/%s text %s without Date decoding", async (type, udt, value) => {
    transport.type = type as string; transport.udt = udt as string; transport.value = value;
    const directory = await mkdtemp(path.join(os.tmpdir(), "backup-temporal-sql-"));
    try {
      const archive = await runDatabaseBackup({ connectionString: "postgres://unused/temporal_test", backupDir: directory,
        backupEngine: "javascript", retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 } });
      const body = gunzipSync(await readFile(archive.backupFile)).toString("utf8");
      expect(body).toContain("SET LOCAL DateStyle = 'ISO, YMD';");
      expect(transport.projection).toBe('SELECT "value"::text AS "value" FROM "public"."temporal_fixture"');
      expect(body.split("\n").filter(line => line.startsWith("INSERT INTO"))).toEqual([
        `INSERT INTO "public"."temporal_fixture" ("value") VALUES (${value === null ? "NULL" : `$paperclip$${value}$paperclip$`});`,
      ]);
      expect(archive.prunedCount).toBe(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
