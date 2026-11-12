import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { type ExecutionBackendRequest } from "../src/execution-backend.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));

import { runAgent } from "../src/agent-runner.js";

describe("manager backend admission", () => {
  let manager: AgentManager;
  afterEach(() => { manager?.dispose(); vi.clearAllMocks(); });
  it.each(["switch", "disconnect", "connect"])("keeps queued execution fixed after parent %s", async change => {
    manager = new AgentManager(undefined, 1);
    let host: string | undefined = change === "connect" ? undefined : "first";
    const captures: string[] = [];
    const pi = { events: { emit: (_name: string, request: ExecutionBackendRequest) => {
      if (!host) return;
      const capturedHost = host;
      request.claim({ version: 1, id: "provider", capture: () => {
        captures.push(capturedHost);
        return { ok: true, binding: { version: 1, id: capturedHost, cwd: `/${capturedHost}`, platform: "linux", prepare: async () => ({ tools: [], dispose: async () => {} }) } };
      } });
    } } } as unknown as ExtensionAPI;
    const ctx = { cwd: "/tmp" } as ExtensionContext;
    let finish: (() => void) | undefined;
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({ responseText: "done", session: { dispose() {} } as Awaited<ReturnType<typeof runAgent>>["session"], aborted: false, steered: false });
    }));
    manager.spawn(pi, ctx, "Explore", "first", { description: "first", isBackground: true });
    const queued = manager.spawn(pi, ctx, "Explore", "queued", { description: "queued", isBackground: true });
    expect(manager.getRecord(queued)?.status).toBe("queued");
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
    host = change === "disconnect" ? undefined : "second";
    ctx.cwd = "/changed";
    finish?.();
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    const binding = vi.mocked(runAgent).mock.calls[1][3].executionBackend;
    expect(binding?.id).toBe(change === "connect" ? "local" : "first");
    expect(binding?.cwd).toBe(change === "connect" ? "/tmp" : "/first");
    expect(captures).toHaveLength(change === "connect" ? 0 : 2);
    finish?.();
  });
});
