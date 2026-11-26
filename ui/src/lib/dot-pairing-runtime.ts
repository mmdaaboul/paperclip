import { apiFetch } from "@/api/client";
import { isTransientError, parseRetryAfter } from "@/api/errors";
import { createConnectivityStore, type ProbeResult } from "./connectivity";
import { bindConnectivity, createAppQueryClient } from "./query-client";
import { dotPairingRequestId } from "./ui-entry";

const PROBE_TIMEOUT_MS = 10_000;

/** Probe the same public capability, never a board-only health/session route. */
export async function probeDotPairingRequest(requestId: string, signal?: AbortSignal): Promise<ProbeResult> {
  if (dotPairingRequestId("/dot-connect/" + requestId) !== requestId) {
    return { reachable: false, retryAfterMs: null };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await apiFetch("/api/dot-mcp/requests/" + requestId, {
      credentials: "include", redirect: "error", cache: "no-store",
      headers: { Accept: "application/json" }, signal: controller.signal,
    });
    const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
    let body: unknown;
    try { body = await response.json(); }
    catch { return { reachable: false, retryAfterMs }; }
    if (!body || typeof body !== "object") return { reachable: false, retryAfterMs };
    const data = body as Record<string, unknown>;
    if (response.ok && data.id === requestId && data.agentConnection === true) {
      return { reachable: true };
    }
    // Expired/denied requests are terminal errors, not a server outage.
    if (response.status >= 400 && response.status < 500 && !isTransientError({ status: response.status, body })
      && typeof data.error === "string") return { reachable: true };
    return { reachable: false, retryAfterMs };
  } catch {
    return { reachable: false, retryAfterMs: null };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function createDotPairingRuntime(pathname: string) {
  const requestId = dotPairingRequestId(pathname);
  if (!requestId) throw new Error("Invalid Dot pairing page");
  const lifetime = new AbortController();
  const store = createConnectivityStore({ probe: () => probeDotPairingRequest(requestId, lifetime.signal) });
  const client = createAppQueryClient({ connectivity: store }, {
    defaultOptions: { queries: { gcTime: 0, refetchOnWindowFocus: false } },
  });
  const stopConnectivity = bindConnectivity(client, store);
  return {
    pathname, requestId, store, client,
    dispose() {
      lifetime.abort();
      stopConnectivity();
      void client.cancelQueries();
      client.clear();
      store.dispose();
    },
  };
}

export type DotPairingRuntime = ReturnType<typeof createDotPairingRuntime>;
