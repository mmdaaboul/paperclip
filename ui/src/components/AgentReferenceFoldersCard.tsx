import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { updateAgentReferenceFoldersSchema, type AgentReferenceFolder, type AgentReferenceFolderConfiguration } from "@paperclipai/shared";
import { agentReferenceFoldersApi, referenceFolderQueryKey, type AgentReferenceFolderSettings } from "../api/agent-reference-folders";
import { projectsApi } from "../api/projects";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/select";

type Props = { agentId: string; companyId: string; hasPendingAgentChanges?: boolean; agentSaving?: boolean; savedAgentVersion?: string };
const copy = (entries: AgentReferenceFolder[]) => entries.map(entry => ({ ...entry }));
const same = (left: AgentReferenceFolder[], right: AgentReferenceFolder[]) => JSON.stringify(left) === JSON.stringify(right);
function message(error: unknown) { return error instanceof Error ? error.message : "The reference-folder request failed"; }

/** Independent native setting. Never invalidates generic agent detail or edits
 * its parent's overlay/footer actions; a successful authoritative save is the
 * only transition from draft to saved reference access. */
export function AgentReferenceFoldersCard({ agentId, companyId, hasPendingAgentChanges, agentSaving, savedAgentVersion }: Props) {
  const id = useId(), client = useQueryClient();
  const key = useMemo(() => referenceFolderQueryKey(companyId, agentId), [companyId, agentId]);
  const lastSavedAgentVersion = useRef(savedAgentVersion);
  useEffect(() => {
    if (lastSavedAgentVersion.current === savedAgentVersion) return;
    lastSavedAgentVersion.current = savedAgentVersion;
    // A saved runtime change can change availability. Refresh only this
    // independent setting; its local draft and the parent overlay survive.
    void client.invalidateQueries({ queryKey: key });
  }, [savedAgentVersion, client, key]);
  const reference = useQuery({ queryKey: key, queryFn: () => agentReferenceFoldersApi.get(agentId, companyId), retry: false });
  const projects = useQuery({ queryKey: queryKeys.projects.list(companyId), queryFn: () => projectsApi.list(companyId), retry: false });
  const visibleProjects = useMemo(() => (projects.data ?? []).filter(project => project.companyId === companyId), [projects.data, companyId]);
  const projectsById = useMemo(() => new Map(visibleProjects.map(project => [project.id, project])), [visibleProjects]);
  const [baseline, setBaseline] = useState<AgentReferenceFolderConfiguration | null>(null);
  const [draft, setDraft] = useState<AgentReferenceFolder[]>([]);
  const [validation, setValidation] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const dirty = baseline !== null && !same(draft, baseline.entries);
  useEffect(() => {
    if (!reference.data || (baseline && reference.data.revision < baseline.revision)) return;
    if (!baseline || (!dirty && (reference.data.revision !== baseline.revision || !same(reference.data.entries, baseline.entries) || reference.data.hiddenEntryCount !== (baseline as AgentReferenceFolderSettings).hiddenEntryCount))) {
      setBaseline(reference.data); setDraft(copy(reference.data.entries)); setStale(false);
    } else if (reference.data.revision !== baseline.revision) setStale(true);
  }, [reference.data, baseline, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const save = useMutation({
    mutationFn: (input: { expectedRevision: number; entries: AgentReferenceFolder[] }) => agentReferenceFoldersApi.update(agentId, companyId, input),
    onSuccess: saved => {
      setBaseline(saved); setDraft(copy(saved.entries)); setValidation(null); setStale(false); setSavedNotice(true);
      // Preserve capabilities/run admissions and avoid a generic agent refresh,
      // which would clear unrelated unsaved parent configuration.
      client.setQueryData<AgentReferenceFolderSettings>(key, previous => previous ? { ...previous, ...saved, hiddenEntryCount: 0 } : undefined);
      void client.invalidateQueries({ queryKey: key });
    },
    onError: error => { if (error instanceof ApiError && error.status === 409) setStale(true); },
  });
  const hiddenEntries = (reference.data?.hiddenEntryCount ?? 0) > 0;
  const canAdd = reference.data?.supported === true && reference.data.canGrantHostPaths === true && !projects.isError && !hiddenEntries;
  const onlyRevocations = baseline !== null && draft.every(entry => baseline.entries.some(saved => saved.projectId === entry.projectId && saved.path === entry.path));
  const blocked = save.isPending || !!agentSaving || reference.isError || !baseline || stale;
  function edit(entries: AgentReferenceFolder[]) { setDraft(entries); setValidation(null); setSavedNotice(false); save.reset(); }
  async function reload() {
    const result = await reference.refetch();
    if (result.data && baseline && result.data.revision < baseline.revision) { setValidation("The server returned an older revision; retry loading settings"); return; }
    if (result.data && !result.isError) { setBaseline(result.data); setDraft(copy(result.data.entries)); setStale(false); setValidation(null); setSavedNotice(false); save.reset(); }
  }
  function submit() {
    if (blocked || hiddenEntries || !dirty || (!canAdd && !onlyRevocations) || !baseline) return;
    const parsed = updateAgentReferenceFoldersSchema.safeParse({ expectedRevision: baseline.revision, entries: draft });
    if (!parsed.success) { setValidation(parsed.error.issues[0]?.message ?? "Check the project and absolute folder path"); return; }
    if (new Set(draft.map(entry => JSON.stringify([entry.projectId, entry.path]))).size !== draft.length) { setValidation("Select each project and folder only once"); return; }
    save.mutate({ expectedRevision: baseline.revision, entries: copy(draft) });
  }
  const savedEntries = baseline?.entries ?? [];
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-4">
      <div className="space-y-1">
        <h4 id={`${id}-title`} className="text-sm font-medium">Read-only reference folders</h4>
        <p className="text-xs text-muted-foreground">Optional folders this agent may read on selected projects. New runs validate and admit the saved paths. This does not grant writes.</p>
        <p className="text-xs text-muted-foreground">Saves separately from other agent settings. Running tasks are not interrupted here.</p>
      </div>
      {hasPendingAgentChanges ? <p className="text-xs text-muted-foreground">Other agent changes are still unsaved. These folders use the saved runtime configuration.</p> : null}
      {reference.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading reference-folder settings…</p> : null}
      {reference.isError ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>Could not load reference-folder settings: {message(reference.error)}</p><Button type="button" size="sm" variant="outline" onClick={() => void reference.refetch()}>Retry settings</Button></div> : null}
      {reference.data?.supported !== true && !reference.isPending ? <p role="status" className="text-sm text-muted-foreground">Adding folders is unavailable. {reference.data?.reason ?? "This runtime has not reported support for reference-folder access."} Existing entries may be removed.</p> : null}
      {reference.data && reference.data.canGrantHostPaths !== true ? <p className="text-xs text-muted-foreground">An instance administrator must add or change host paths. Authorized configurators may remove existing entries.</p> : null}
      {projects.isError ? <div role="alert" className="text-sm text-destructive">Could not load visible projects. Existing entries may be removed. <Button type="button" size="sm" variant="ghost" onClick={() => void projects.refetch()}>Retry projects</Button></div> : null}
      {baseline ? <>
        <p className="text-xs text-muted-foreground" data-reference-saved-state>{hiddenEntries ? "Some saved reference folders are private." : savedEntries.length ? `Saved revision ${baseline.revision}: ${savedEntries.length} reference folder${savedEntries.length === 1 ? "" : "s"}.` : "No reference folders saved. Additional folder access is off."}</p>
        {hiddenEntries ? <div className="space-y-2"><p role="status" className="text-sm text-muted-foreground">Some configured projects are no longer visible. Clear all saved folders to revoke access without viewing private paths. Active runs keep their admission until they end or are stopped.</p>
          <Button type="button" variant="outline" disabled={blocked} onClick={() => save.mutate({ expectedRevision: baseline.revision, entries: [] })}>Clear all reference folders</Button></div> : null}
        <div className="space-y-3">
          {(!hiddenEntries ? draft : []).map((entry, index) => {
            const available = projectsById.has(entry.projectId);
            return <div key={index} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-3">
              <label className="space-y-1 text-xs text-muted-foreground">Project
                <NativeSelect aria-label={`Reference folder ${index + 1} project`} value={entry.projectId} disabled={blocked || !canAdd || projects.isPending}
                  onChange={event => edit(draft.map((item, position) => position === index ? { ...item, projectId: event.target.value } : item))}>
                  <option value="">Select a project</option>
                  {!available && entry.projectId ? <option value={entry.projectId}>Unavailable project</option> : null}
                  {visibleProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                </NativeSelect>
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">Absolute folder path
                <Input aria-label={`Reference folder ${index + 1} path`} value={entry.path} disabled={blocked || !canAdd} maxLength={4096} placeholder="/absolute/path/in/execution/environment"
                  onChange={event => edit(draft.map((item, position) => position === index ? { ...item, path: event.target.value } : item))} />
              </label>
              <Button type="button" variant="ghost" size="sm" aria-label={`Remove reference folder ${index + 1}`} disabled={blocked} onClick={() => edit(draft.filter((_item, position) => position !== index))}>Remove</Button>
              {!available && entry.projectId ? <p className="text-xs text-muted-foreground sm:col-span-3">This project is unavailable in your current project list. Remove the entry or restore project access before saving changes.</p> : null}
            </div>;
          })}
        </div>
        <Button type="button" variant="outline" size="sm" disabled={blocked || !canAdd || projects.isPending || !visibleProjects.length || draft.length >= 32} onClick={() => edit([...draft, { projectId: "", path: "" }])}>Add reference folder</Button>
        {visibleProjects.length === 0 && !projects.isPending && !projects.isError ? <p className="text-xs text-muted-foreground">No visible projects are available.</p> : null}
        {dirty ? <p role="status" className="text-xs text-muted-foreground">Unsaved reference-folder changes. Saved access has not changed.</p> : null}
        {validation ? <p role="alert" className="text-sm text-destructive">{validation}</p> : null}
        {save.error ? <p role="alert" className="text-sm text-destructive">Could not save reference folders: {message(save.error)}</p> : null}
        {stale ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>Saved settings changed. Your draft is retained; reload before saving again.</p><Button type="button" size="sm" variant="outline" disabled={save.isPending || reference.isFetching} onClick={() => void reload()}>Discard draft and reload</Button></div> : null}
        {savedNotice && !dirty ? <p role="status" className="text-sm text-muted-foreground">Reference folders saved. New runs will validate these paths.</p> : null}
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          <Button type="button" size="sm" variant="ghost" disabled={!dirty || save.isPending} onClick={() => { edit(copy(savedEntries)); setStale(reference.data?.revision !== baseline.revision); }}>Cancel reference changes</Button>
          <Button type="button" size="sm" className="ml-auto" disabled={blocked || hiddenEntries || !dirty || (!canAdd && !onlyRevocations)} onClick={submit}>{save.isPending ? "Saving reference folders…" : "Save reference folders"}</Button>
        </div>
      </> : null}
      {(reference.data?.activeRuns?.length ?? 0) > 0 ? <div className="space-y-2 border-t border-border pt-3"><h5 className="text-xs font-medium">Active run admissions</h5>
        <p className="text-xs text-muted-foreground">Each run keeps its admitted access until it ends or is stopped. Changing the saved list does not rewrite that admission.</p>
        {reference.data!.activeRuns.map(run => {
          const admission = run.admission;
          const valid = admission?.schema === "paperclip.reference-folder-admission.v1" && admission.binding?.companyId === companyId && admission.binding.agentId === agentId && admission.binding.runId === run.runId && Number.isSafeInteger(admission.revision) && admission.revision >= 0 && Array.isArray(admission.paths) && admission.paths.every(path => typeof path === "string");
          return <div key={run.runId} className="rounded-md border border-border p-2 text-xs"><p>Run {run.runId.slice(0, 8)} · {valid ? `admitted revision ${admission.revision}${baseline && admission.revision !== baseline.revision ? " (older than saved settings)" : ""}` : "no recorded reference-folder admission"}</p>
            {valid ? <><p className="text-muted-foreground">Project: {projectsById.get(admission.binding.projectId ?? "")?.name ?? "Unavailable project"}</p><ul className="mt-1 space-y-1">{admission.paths.map(path => <li key={path} className="break-all font-mono">{path}</li>)}</ul></> : <p className="text-muted-foreground">This setting does not establish that run’s access.</p>}
          </div>;
        })}
      </div> : null}
    </section>
  );
}
