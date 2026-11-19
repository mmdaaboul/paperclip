import { userInfo } from "node:os";
import { join } from "node:path";
import type { agents } from "@paperclipai/db";
import { loadConfig } from "../config.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { resolvePaperclipConfigPath, resolvePaperclipEnvPath } from "../paths.js";
import { unprocessable } from "../errors.js";
import { validateCodexReferenceDirectory } from "../vendor/paperclip-runner/index.js";

export function referenceFolderProtectedPaths(): string[] {
  const config = loadConfig(), home = userInfo().homedir;
  return [resolvePaperclipConfigPath(), resolvePaperclipEnvPath(), config.secretsMasterKeyFilePath,
    config.embeddedPostgresDataDir, config.databaseBackupDir, join(resolvePaperclipInstanceRoot(), "runtime"),
    ...[".ssh", ".codex", ".claude", ".config/gh", ".git-credentials", ".netrc"].map(path => join(home, path))];
}

export function assertReferenceFolderProvider(agent: Pick<typeof agents.$inferSelect, "adapterType" | "adapterConfig">, driver: string): void {
  const config = agent.adapterConfig;
  if (agent.adapterType !== "paperclip_runner" || (config.provider ?? "codex") !== "codex"
    || config.homeMode === "preconfigured" || driver !== "local") {
    throw unprocessable("Reference folders currently require an isolated local Codex Paperclip Runner; this execution target is unsupported");
  }
}

export async function validateReferenceFolderPath(value: string, budget: { entries: number }): Promise<string> {
  try { return validateCodexReferenceDirectory(value, referenceFolderProtectedPaths(), budget); }
  catch (error) { throw unprocessable(error instanceof Error ? error.message : "Reference folder is unavailable"); }
}
