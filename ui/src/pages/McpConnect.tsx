import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip } from "lucide-react";
import { Link, useParams } from "@/lib/router";
import type { McpConnection } from "@paperclipai/shared";
import { deriveInitials, Identity } from "@/components/Identity";
import { assistantConnectionDisplayName } from "./apps/connection-owner";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "../api/client";
import { describeError } from "../api/errors";
import { McpConnectRequest } from "./McpConnectRequest";

export function McpConnectPage({ agentPairingOnly = false }: { agentPairingOnly?: boolean } = {}) {
  const { id = "" } = useParams();
  return <McpConnectRequest key={id} id={id} agentPairingOnly={agentPairingOnly} NavigationLink={agentPairingOnly ? undefined : Link} />;
}

export function McpDevicePage({ initialCode }: { initialCode?: string } = {}) {
  const [code, setCode] = useState(initialCode ?? new URLSearchParams(window.location.search).get("user_code") ?? "");
  const [submitted, setSubmitted] = useState(code);
  if (submitted) return <McpConnectRequest key={submitted} id={submitted} device NavigationLink={Link} onEditCode={() => setSubmitted("")} />;
  return <div className="mx-auto max-w-xl py-10"><Card className="space-y-4 p-6"><div className="flex items-center gap-3"><Paperclip className="size-8 shrink-0" /><h1 className="min-w-0 text-xl font-semibold">Connect your assistant to Paperclip</h1></div>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); setSubmitted(code.trim()); }}>
      <label htmlFor="device-code" className="text-sm">Enter the code shown by your assistant</label>
      <Input id="device-code" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} required maxLength={12} />
      <div className="flex justify-end"><Button type="submit">Continue</Button></div>
    </form></Card></div>;
}

export function AssistantConnectionsPage() {
  const client = useQueryClient();
  const connections = useQuery({ queryKey: ["mcp-connections"], queryFn: () => api.get<McpConnection[]>("/mcp/connections") });
  const connectionsView = useQueryView(connections);
  const active = connections.data?.filter(connection => !connection.revokedAt);
  const revoke = useMutation({ mutationFn: (id: string) => api.delete(`/mcp/connections/${id}`), onSuccess: (_, id) => {
    client.setQueryData<McpConnection[]>(["mcp-connections"], rows => rows?.filter(row => row.id !== id));
    return client.invalidateQueries({ queryKey: ["mcp-connections"] });
  } });
  return <div className="mx-auto max-w-xl space-y-4 py-10">
    <h1 className="text-xl font-semibold">Assistant connections</h1>
    <p className="text-sm text-muted-foreground">Revoking a connection stops its future tool calls. Work already delegated continues under your organization’s normal controls.</p>
    {(connectionsView.kind === "loading" || connectionsView.kind === "reconnecting") && <p role="status" className="text-sm text-muted-foreground">Loading connections…</p>}
    {connectionsView.kind === "error" && <QueryErrorState error={connectionsView.error} action="load assistant connections" onRetry={connectionsView.retry} retrying={connectionsView.isFetching} />}
    {revoke.error && <p role="alert" className="text-sm text-destructive">{describeError(revoke.error, { action: "revoke the connection" }).body}</p>}
    {active?.length === 0 && <p className="text-sm">No assistant connections.</p>}
    {active?.map((connection) => <Card key={connection.id} className="block space-y-2 p-4">
      <h2 className="font-medium"><Identity name={assistantConnectionDisplayName(connection)} avatarUrl={connection.user?.image} initials={deriveInitials(connection.user?.name ?? "You")} /></h2>
      <p className="text-sm text-muted-foreground">Organization: {connection.companyName}</p>
      {connection.agent && <p className="text-sm">Works as <Link className="underline" to={`/${connection.companyPrefix ?? connection.companyId}/agents/${connection.agent.id}/runtime`}>{connection.agent.name}</Link>{connection.user ? ` · Authorized by ${connection.user.name}` : ""}</p>}
      <p className="text-sm">{connection.scopes.includes("paperclip:agent") ? "Agent connection" : connection.scopes.includes("paperclip:write") ? "Read and edit work" : "Read only"}</p>
      {connection.scopes.includes("paperclip:configure") && <p className="text-sm">Configure agents, projects and skills</p>}
      <Button variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate(connection.id)}>Revoke connection</Button>
    </Card>)}
    <Link className="text-sm underline" to="/">Back to Paperclip</Link>
  </div>;
}
