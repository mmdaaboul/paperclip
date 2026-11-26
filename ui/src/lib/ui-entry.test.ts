import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { dotPairingRequestId, loadUiEntry } from "./ui-entry";

const id = "pcmcp_request_" + "A".repeat(43);

describe("public Dot entry boundary", () => {
  it("loads only the public entry for an exact request path", async () => {
    const board = vi.fn(async () => { throw new Error("board bootstrap ran"); });
    const dot = vi.fn(async () => "paired entry");
    expect(dotPairingRequestId("/dot-connect/" + id)).toBe(id);
    await expect(loadUiEntry("/dot-connect/" + id, { board, dot })).resolves.toBe("paired entry");
    expect(board).not.toHaveBeenCalled();
    expect(dot).toHaveBeenCalledOnce();
  });

  it.each(["/", "/auth", "/CAR/issues", "/mcp-connect/" + id, "/dot-connect/" + id + "/",
    "/DOT-connect/" + id, "/dot-connect/" + id.slice(0, -1), "/dot-connect/" + id + "A",
    "/dot-connect/" + id.replace("A", "%41"), "/dot-connect/" + id.replace("A", ".")])(
    "keeps %s on the existing board entry", async pathname => {
      const board = vi.fn(async () => "board");
      const dot = vi.fn(async () => { throw new Error("public entry captured another route"); });
      expect(dotPairingRequestId(pathname)).toBeNull();
      await expect(loadUiEntry(pathname, { board, dot })).resolves.toBe("board");
      expect(board).toHaveBeenCalledOnce();
      expect(dot).not.toHaveBeenCalled();
    });

  it("defers board startup before importing any of its side effects", () => {
    const entry = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    expect(entry).toContain('board: () => import("./main-board")');
    expect(entry).not.toContain('from "./main-board"');
    expect(entry).not.toContain("startPersistedQueryCache");
    expect(entry).not.toContain("bindConnectivity");
  });

  it.each(["loading", "complete"])("starts board service-worker handling when imported at readyState=%s", readyState => {
    const source = readFileSync(new URL("../main-board.tsx", import.meta.url), "utf8");
    // Execute the actual registration block without running board providers.
    const registration = source.slice(source.indexOf("function startBoardServiceWorkerUpdates()"), source.indexOf("function CompanyAwareBreadcrumbProvider"));
    const start = vi.fn();
    const callbacks: { callback: () => void; options: unknown }[] = [];
    const window = { addEventListener: (_event: string, callback: () => void, options: unknown) => callbacks.push({ callback, options }) };
    new Function("document", "window", "startServiceWorkerUpdates", "connectivity", "queryClient", "subscribePendingWrites", "hasPendingWrites", registration)(
      { readyState }, window, start, {}, {}, () => undefined, () => false,
    );
    if (readyState === "loading") {
      expect(start).not.toHaveBeenCalled();
      expect(callbacks).toHaveLength(1);
      expect(callbacks[0].options).toEqual({ once: true });
      callbacks[0].callback();
    } else expect(callbacks).toHaveLength(0);
    expect(start).toHaveBeenCalledOnce();
  });
});
