/** Non-secret creator labels. These are visible metadata, not proof of a later push. */
export interface GitAgentAttribution {
  schema: "paperclip.git-agent-attribution.v1";
  agentId: string;
  runId: string;
  issueId: string | null;
  nameAtTime: string;
}

export function createGitAgentAttribution(input: {
  agentId: string; runId: string; issueId: string | null; nameAtTime: string;
}): GitAgentAttribution {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!uuid.test(input.agentId) || !uuid.test(input.runId) || input.issueId !== null && !uuid.test(input.issueId)) {
    throw new Error("Git attribution requires server-bound agent/run/task identities");
  }
  const nameAtTime = input.nameAtTime.replace(/[\p{C}<>]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 80) || "Paperclip agent";
  return Object.freeze({ schema: "paperclip.git-agent-attribution.v1", agentId: input.agentId,
    runId: input.runId, issueId: input.issueId, nameAtTime });
}

/** Keep the native verified GitHub email; names distinguish Paperclip creators. */
export function applyGitAgentIdentity(env: Record<string, string>, attribution: GitAgentAttribution): Record<string, string> {
  const label = `${attribution.nameAtTime} [Paperclip agent:${attribution.agentId} run:${attribution.runId}${attribution.issueId ? ` task:${attribution.issueId}` : ""}]`;
  return { ...env, GIT_AUTHOR_NAME: label, GIT_COMMITTER_NAME: label };
}

/** Shared standalone launcher code: no package dependency or credentials in files. */
export function githubAttributionLauncherHelpers(): string {
  return String.raw`
function paperclipAttributionValid(attribution) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return !!attribution && attribution.schema === 'paperclip.git-agent-attribution.v1' && uuid.test(attribution.agentId) && uuid.test(attribution.runId) &&
    (attribution.issueId === null || uuid.test(attribution.issueId)) && typeof attribution.nameAtTime === 'string' && !!attribution.nameAtTime.trim() &&
    attribution.nameAtTime.length <= 80 && !/[\x00-\x1f\x7f<>\r\n]/.test(attribution.nameAtTime);
}
function paperclipCommitArguments(args, attribution) {
  if (!paperclipAttributionValid(attribution)) return args;
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('-')) break;
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path'].includes(arg)) { index++; continue; }
    if (/^(--git-dir|--work-tree|--namespace|--config-env|--exec-path)=/.test(arg) ||
        ['--no-pager', '--paginate', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects'].includes(arg)) continue;
    return args;
  }
  // Aliases/commit-tree/gh API are deliberately not interpreted as git commit.
  if (args[index] !== 'commit') return args;
  const trailers = [
    '--trailer', 'Paperclip-Agent: ' + attribution.nameAtTime + ' (' + attribution.agentId + ')',
    '--trailer', 'Paperclip-Run: ' + attribution.runId,
    ...(attribution.issueId ? ['--trailer', 'Paperclip-Task: ' + attribution.issueId] : []),
  ];
  return [...args.slice(0, index + 1), ...trailers, ...args.slice(index + 1)];
}
`;
}
