import { createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";

let isolated: Promise<Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>> | undefined;
let users = 0;

/** One freshly migrated native database per isolated Vitest file. Multiple
 * postgres-js pools share it for actual contention tests. Never consult a saved
 * operational profile or DATABASE_URL. The native helper owns creation/cleanup. */
export async function reviewerNativeTestDatabase(maxConnections: 1 | 2 = 2) {
  if (!isolated) isolated = (async () => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) throw new Error("reviewer_isolated_postgres_test_unavailable");
    return startEmbeddedPostgresTestDatabase("paperclip-reviewer-policy-");
  })();
  users++;
  const temporary = await isolated;
  const db = createDb(temporary.connectionString, { maxConnections, applicationName: "paperclip-reviewer-native-test" });
  async function query<Row extends Record<string, unknown> = Record<string, unknown>>(statement: string, values: unknown[] = []) {
    const bound = values.map(value => {
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
      if (typeof value === "object") return JSON.stringify(value);
      throw new Error("Unsupported test SQL parameter");
    });
    const rows = await db.$client.unsafe<Row[]>(statement, bound);
    return { rows: [...rows] };
  }
  let ended = false;
  async function end() {
    if (ended) return; ended = true;
    await db.$client.end({ timeout: 5 });
    if (--users === 0) await temporary.cleanup();
  }
  return { db, query, end };
}
