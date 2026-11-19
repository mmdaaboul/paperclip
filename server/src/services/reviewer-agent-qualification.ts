import { eq } from "drizzle-orm";
import { environments, type agents, type Db } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import { assertReferenceFolderProvider } from "./agent-reference-folder-paths.js";
import { instanceSettingsService } from "./instance-settings.js";

/** Pure availability check: GET never retires or modifies an execution. The
 * actual run still qualifies its resolved target, trust and immutable policy. */
export async function assertReviewerAgentSupported(db: Db, agent: typeof agents.$inferSelect) {
  const settings = instanceSettingsService(db);
  if ((await settings.getGeneral()).executionMode === "kubernetes") {
    throw unprocessable("The protected Reviewer currently requires an isolated local Codex Paperclip Runner");
  }
  const id = agent.defaultEnvironmentId ?? (await settings.get()).defaultEnvironmentId;
  const [environment] = id ? await db.select({ driver: environments.driver, status: environments.status })
    .from(environments).where(eq(environments.id, id)) : [];
  if (id && (!environment || environment.status !== "active")) throw unprocessable("The configured execution environment is unavailable");
  assertReferenceFolderProvider(agent, environment?.driver ?? "local");
}
