import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { updateAgentReviewerPolicySchema, type AgentReviewerPolicyConfiguration, type AgentReviewerScope } from "@paperclipai/shared";
import { agentReviewerPolicyApi, reviewerPolicyQueryKey, type ReviewerPolicySettings } from "../api/agent-reviewer-policy";
import { projectsApi } from "../api/projects";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/select";

type Props = { agentId: string; companyId: string; hasPendingAgentChanges?: boolean; agentSaving?: boolean; savedAgentVersion?: string };
const copy = (config: AgentReviewerPolicyConfiguration) => ({ ...config, scopes: config.scopes.map(scope => ({ ...scope })) });
const same = (a: AgentReviewerPolicyConfiguration, b: AgentReviewerPolicyConfiguration) => a.enabled === b.enabled && JSON.stringify(a.scopes) === JSON.stringify(b.scopes);
const message = (error: unknown) => error instanceof Error ? error.message : "Reviewer settings could not be saved";

/** Operator-owned configuration is independent of editable agent JSON and its
 * parent draft. Provider IDs are verified by the server, never typed by users. */
export function AgentReviewerPolicyCard({ agentId, companyId, hasPendingAgentChanges, agentSaving, savedAgentVersion }: Props) {
  const id = useId(), client = useQueryClient();
  const key = useMemo(() => reviewerPolicyQueryKey(companyId, agentId), [companyId, agentId]);
  const version = useRef(savedAgentVersion);
  useEffect(() => {
    if (version.current === savedAgentVersion) return;
    version.current = savedAgentVersion;
    void client.invalidateQueries({ queryKey: key });
  }, [savedAgentVersion, key, client]);
  const settings = useQuery({ queryKey: key, queryFn: () => agentReviewerPolicyApi.get(agentId, companyId), retry: false });
  const projects = useQuery({ queryKey: queryKeys.projects.list(companyId), queryFn: () => projectsApi.list(companyId), retry: false });
  const visibleProjects = useMemo(() => (projects.data ?? []).filter(project => project.companyId === companyId), [projects.data, companyId]);
  const projectsById = useMemo(() => new Map(visibleProjects.map(project => [project.id, project])), [visibleProjects]);
  const [baseline, setBaseline] = useState<AgentReviewerPolicyConfiguration | null>(null);
  const [draft, setDraft] = useState<AgentReviewerPolicyConfiguration | null>(null);
  const [projectId, setProjectId] = useState(""), [repository, setRepository] = useState("");
  const [stale, setStale] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const dirty = !!baseline && !!draft && !same(baseline, draft);
  useEffect(() => {
    if (!settings.data || (baseline && settings.data.revision < baseline.revision)) return;
    if (!baseline || (!dirty && (settings.data.revision !== baseline.revision || !same(settings.data, baseline) || settings.data.hiddenScopeCount !== (baseline as ReviewerPolicySettings).hiddenScopeCount))) {
      setBaseline(copy(settings.data)); setDraft(copy(settings.data)); setStale(false);
    } else if (settings.data.revision !== baseline.revision) setStale(true);
  }, [settings.data, baseline, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const save = useMutation({
    mutationFn: (input: { expectedRevision: number; enabled: boolean; scopes: AgentReviewerScope[] }) => agentReviewerPolicyApi.update(agentId, companyId, input),
    onSuccess: saved => {
      setBaseline(copy(saved)); setDraft(copy(saved)); setStale(false); setNotice("Reviewer settings saved");
      client.setQueryData<ReviewerPolicySettings>(key, previous => previous ? { ...previous, ...saved, hiddenScopeCount: 0 } : undefined);
      void client.invalidateQueries({ queryKey: key });
    },
    onError: error => { if (error instanceof ApiError && error.status === 409) setStale(true); },
  });
  const resolve = useMutation({
    mutationFn: () => agentReviewerPolicyApi.resolveRepository(agentId, companyId, { projectId, repository: repository.trim() }),
    onSuccess: scope => {
      setDraft(previous => previous ? { ...previous, scopes: previous.scopes.some(item => item.projectId === scope.projectId && item.repositoryId === scope.repositoryId) ? previous.scopes : [...previous.scopes, scope] } : previous);
      setRepository(""); setNotice(null); save.reset();
    },
  });
  const busy = save.isPending || resolve.isPending || !!agentSaving;
  const hiddenScopes = (settings.data?.hiddenScopeCount ?? 0) > 0;
  const canAdd = settings.data?.supported === true && !projects.isError && !hasPendingAgentChanges && !hiddenScopes;
  function edit(patch: Partial<AgentReviewerPolicyConfiguration>) { setDraft(previous => previous ? { ...previous, ...patch } : previous); setNotice(null); save.reset(); }
  async function reload() {
    const result = await settings.refetch();
    if (!result.data || result.isError) return;
    if (baseline && result.data.revision < baseline.revision) { setNotice("The server returned an older revision; retry loading settings"); return; }
    setBaseline(copy(result.data)); setDraft(copy(result.data)); setStale(false); setNotice(null); save.reset(); resolve.reset();
  }
  function submit() {
    if (!baseline || !draft || busy || stale || hiddenScopes || settings.isError || !dirty || (draft.enabled && !canAdd)) return;
    const parsed = updateAgentReviewerPolicySchema.safeParse({ expectedRevision: baseline.revision, enabled: draft.enabled, scopes: draft.scopes });
    if (!parsed.success) { setNotice(parsed.error.issues[0]?.message ?? "Verify a project repository first"); return; }
    save.mutate(parsed.data);
  }
  return <section aria-labelledby={`${id}-title`} className="space-y-4">
    <div><h4 id={`${id}-title`} className="text-sm font-medium">Protected Reviewer</h4>
      <p className="text-sm text-muted-foreground">Optional. Read-only candidate and Git files, private writable scratch, and discussion limited to the assigned PR. No push, merge, formal PR approval or raw credentials.</p></div>
    {settings.isPending ? <p role="status">Loading Reviewer settings…</p> : null}
    {settings.isError ? <p role="alert">{message(settings.error)}</p> : null}
    {settings.data?.supported === false ? <p role="status">{settings.data.reason ?? "This saved runtime does not support the protected Reviewer"}</p> : null}
    {hasPendingAgentChanges ? <p className="text-sm text-muted-foreground">Save other agent changes before enabling the role or adding a repository. Disabling remains available.</p> : null}
    {draft ? <>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled}
        disabled={busy || hiddenScopes || (!draft.enabled && !canAdd)} onChange={event => edit({ enabled: event.target.checked })} />Enable protected Reviewer</label>
      {hiddenScopes ? <div className="space-y-2"><p role="status">Some configured scopes are private. You can disable the role and remove all scopes without viewing those project or repository details.</p>
        <Button variant="outline" disabled={busy || stale || settings.isError} onClick={() => save.mutate({ expectedRevision: baseline!.revision, enabled: false, scopes: [] })}>Disable Reviewer and clear all scopes</Button></div> : null}
      <ul className="space-y-2">{(!hiddenScopes ? draft.scopes : []).map(scope => <li key={`${scope.projectId}:${scope.repositoryId}`} className="flex items-center justify-between gap-2 text-sm">
        <span>{projectsById.get(scope.projectId)?.name ?? "Selected project"}: {scope.repository}</span>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => edit({ scopes: draft.scopes.filter(item => item !== scope) })} aria-label={`Remove ${scope.repository}`}>Remove</Button>
      </li>)}</ul>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-sm">Project<NativeSelect aria-label="Reviewer project" value={projectId} disabled={!canAdd || busy}
          onChange={event => { setProjectId(event.target.value); resolve.reset(); }}><option value="">Select project</option>{visibleProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</NativeSelect></label>
        <label className="space-y-1 text-sm">GitHub repository<Input aria-label="Reviewer repository" placeholder="owner/repository" value={repository} disabled={!canAdd || busy}
          onChange={event => { setRepository(event.target.value); resolve.reset(); }} /></label>
      </div>
      <Button variant="outline" disabled={!canAdd || busy || !projectId || !repository.trim() || draft.scopes.length >= 32} onClick={() => resolve.mutate()}>{resolve.isPending ? "Verifying…" : "Verify and add repository"}</Button>
      {resolve.isError ? <p role="alert">{message(resolve.error)}</p> : null}
      <p className="text-sm text-muted-foreground">Uses this agent’s selected native GitHub identity. Stop active runs before changing the role. Existing admissions stay restricted; unsupported or conflicting assignments are refused.</p>
      {settings.data?.activeRunCount ? <p role="status">{settings.data.activeRunCount} active or queued run(s) must stop before saving a changed role.</p> : null}
      {stale ? <p role="alert">Reviewer settings changed elsewhere. Reload before saving; your draft has been retained.</p> : null}
      {save.isError ? <p role="alert">{message(save.error)}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <div className="flex gap-2"><Button variant="outline" disabled={busy || settings.isFetching} onClick={() => void reload()}>Reload Reviewer settings</Button>
        <Button className="ml-auto" disabled={busy || !dirty || stale || hiddenScopes || settings.isError || (draft.enabled && !canAdd)} onClick={submit}>{save.isPending ? "Saving…" : "Save Reviewer settings"}</Button></div>
    </> : null}
  </section>;
}
