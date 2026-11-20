import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { NativeMaintenanceHold, type MaintenanceHandle, type MaintenanceBoot } from "./native-maintenance-hold.js";

/** Native startup calls this only after native database/migration setup and
 * before identity/auth/createApp/plugin construction or recovery. No normal
 * application is initialized on this branch. Releasing requires a restart.
 */
export async function startNativeMaintenanceServer(input: {
  hold: NativeMaintenanceHold; host: string; port: number; commit: string; version: string;
}): Promise<{ server: Server; boot: MaintenanceBoot; close: () => Promise<void> }> {
  const state = input.hold.status(); if (!state) throw new Error("native_maintenance_hold_required");
  if (!["127.0.0.1", "::1", "localhost"].includes(input.host)) throw new Error("native_maintenance_only_loopback_host_qualified");
  let boot: MaintenanceBoot | undefined;
  const server = createServer({ shouldUpgradeCallback: () => false }, (req, res) => {
    if (!boot) { res.statusCode = 503; res.end(); return; }
    if (["GET", "HEAD"].includes(req.method ?? "") && ["/api/health", "/api/liveness"].includes(req.url ?? "")) {
      const candidate = req.headers["x-paperclip-maintenance-probe"];
      const matched = boot && typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate)
        && timingSafeEqual(Buffer.from(candidate), Buffer.from(boot.probeKey));
      res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ status: "ok", version: input.version, commit: input.commit, maintenance: true,
        ...(matched && boot ? { maintenanceProof: { schema: "paperclip.native-maintenance-boot.v1", holdId: boot.holdId, bootId: boot.bootId, commit: boot.commit } } : {}) })); return;
    }
    res.statusCode = 503; res.setHeader("content-type", "application/json"); res.end('{"error":"native_maintenance_active"}');
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(input.port, input.host, () => { server.off("error", reject); resolve(); }); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("native_maintenance_listener_identity");
    boot = input.hold.boot(state.holdId, { host: input.host, port: address.port, commit: input.commit });
    return { server, boot, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
  } catch (error) { server.close(); throw error; }
}

export async function verifyNativeMaintenanceBoot(hold: NativeMaintenanceHold, handle: MaintenanceHandle, expectedCommit: string): Promise<MaintenanceBoot> {
  const boot = hold.readBoot(handle); if (boot.commit !== expectedCommit) throw new Error("native_maintenance_wrong_code");
  const host = boot.host === "::1" ? "[::1]" : boot.host;
  // A same-port service replacement can leave a dead HTTP keepalive socket
  // in the controller's fetch pool. Retry only read-only transport failures;
  // wrong owner/code/response identity below never grants another attempt.
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(`http://${host}:${boot.port}/api/health`, { redirect: "error", signal: AbortSignal.timeout(2000), headers: { "x-paperclip-maintenance-probe": boot.probeKey, connection: "close" } });
      break;
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (attempt === 2 || !["ECONNRESET", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET"].includes(code ?? "")) throw error;
      if (hold.readBoot(handle).bootId !== boot.bootId) throw new Error("native_maintenance_boot_changed");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  if (!response) throw new Error("native_maintenance_live_boot_unproven");
  const body = await response.json() as { maintenance?: boolean; maintenanceProof?: Record<string, unknown>; commit?: string };
  if (!response.ok || body.maintenance !== true || body.commit !== expectedCommit || body.maintenanceProof?.schema !== boot.schema
    || body.maintenanceProof.holdId !== handle.holdId || body.maintenanceProof.bootId !== boot.bootId || body.maintenanceProof.commit !== expectedCommit) throw new Error("native_maintenance_live_boot_unproven");
  if (hold.status()?.holdId !== handle.holdId || hold.readBoot(handle).bootId !== boot.bootId) throw new Error("native_maintenance_boot_changed");
  return boot;
}
