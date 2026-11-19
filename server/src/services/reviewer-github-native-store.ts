import type { Db } from "@paperclipai/db";
import { createReviewerGitHubStore } from "./reviewer-github-store.js";

/** Adapt the application's existing postgres-js connection, not a second pool.
 * Statement text is owned by the closed receipt store; values remain bound.
 */
export function createNativeReviewerGitHubStore(db: Db, schema = "public") {
  return createReviewerGitHubStore({
    async query<T extends Record<string, unknown>>(statement: string, values: unknown[] = []) {
      const bound = values.map(value => value !== null && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)
        ? JSON.stringify(value) : value);
      const rows = await db.$client.unsafe(statement, bound as Parameters<Db["$client"]["unsafe"]>[1]);
      return { rows: [...rows] as unknown as T[] };
    },
  }, schema);
}
