import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionBackendRequest } from "../src/execution-backend.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { runWorkflow, type WorkflowControl, type WorkflowSpawnRequest } from "../src/workflow/runtime.js";
import { ctx } from "./helpers/boot-extension.js";

const request = (id: string): WorkflowSpawnRequest => ({ agentId: id, index: 0, label: id, prompt: id, agentType: "Explore" });

describe("workflow execution binding", () => {
  let manager: AgentManager;
  beforeEach(() => {
    registerAgents(new Map());
    manager = new AgentManager();
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
    vi.mocked(runAgent).mockImplementation(async () => ({ responseText: "done", session: { dispose: vi.fn() } as Awaited<ReturnType<typeof runAgent>>["session"], aborted: false, steered: false }));
    vi.mocked(resumeAgent).mockResolvedValue({ text: "continued", aborted: false, steered: false });
  });
  afterEach(() => manager.dispose());
  it.each(["switch", "disconnect"])("preserves one binding through parallel and later spawns and live resume after %s", async change => {
    let active = "first";
    const capture = vi.fn(() => ({ ok: true as const, binding: { version: 1 as const, id: active, cwd: `/${active}`, platform: "linux", prepare: async () => ({ tools: [], dispose: async () => {} }) } }));
    const pi = { events: { emit: (_event: string, r: ExecutionBackendRequest) => { if (active) r.claim({ version: 1, id: "provider", capture }); } } } as unknown as ExtensionAPI;
    const context = ctx({});
    const host = createWorkflowHost({ pi, ctx: context, manager, workflowId: "workflow" });
    active = change === "switch" ? "second" : "";
    context.cwd = "/changed";
    const results = await Promise.all([host.spawnAgent(request("a")), host.spawnAgent(request("b"))]);
    expect(results.every(result => result.ok)).toBe(true);
    expect((await host.spawnAgent(request("retry"))).ok).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    const bindings = vi.mocked(runAgent).mock.calls.map(call => call[3].executionBackend);
    expect(bindings).toHaveLength(3);
    for (const binding of bindings) {
      expect(binding).toBe(bindings[0]);
      expect(binding).toMatchObject({ id: "first", cwd: "/first" });
    }
    expect((await host.resumeAgent?.("a", "continue"))?.ok).toBe(true);
    expect(resumeAgent).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });
  it("retains the admitted binding when runtime control retries a running child", async () => {
    let active = "original";
    const capture = vi.fn(() => ({ ok: true as const, binding: { version: 1 as const, id: active, cwd: `/${active}`, platform: "linux", prepare: async () => ({ tools: [], dispose: async () => {} }) } }));
    const pi = { events: { emit: (_event: string, r: ExecutionBackendRequest) => r.claim({ version: 1, id: "provider", capture }) } } as unknown as ExtensionAPI;
    const host = createWorkflowHost({ pi, ctx: ctx({}), manager, workflowId: "retry" });
    vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
      await new Promise<void>(resolve => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { responseText: "stopped", session: { dispose() {} } as Awaited<ReturnType<typeof runAgent>>["session"], aborted: true, steered: false };
    });
    let control: WorkflowControl | undefined;
    const done = runWorkflow({ script: 'export const meta = { name: "retry", description: "test" };\nreturn await agent("inspect", { agentType: "Explore" });', host, onControl: value => { control = value; } });
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
    active = "changed";
    expect(control?.retry(0)).toBe(true);
    await done;
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAgent).mock.calls[1][3].executionBackend).toBe(vi.mocked(runAgent).mock.calls[0][3].executionBackend);
    expect(capture).toHaveBeenCalledTimes(1);
  });
  it("reopens an evicted workflow child with its original remote binding", async () => {
    manager.dispose();
    vi.useFakeTimers();
    manager = new AgentManager();
    const capture = vi.fn(() => ({ ok: true as const, binding: { version: 1 as const, id: "original", cwd: "/original", platform: "linux", prepare: async () => ({ tools: [], dispose: async () => {} }) } }));
    const pi = { events: { emit: (_event: string, r: ExecutionBackendRequest) => r.claim({ version: 1, id: "provider", capture }) } } as unknown as ExtensionAPI;
    const directory = mkdtempSync(join(tmpdir(), "workflow-binding-"));
    const sessionFile = join(directory, "saved.jsonl");
    writeFileSync(sessionFile, "");
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      const session = { dispose: vi.fn(), sessionManager: { getSessionFile: () => sessionFile } } as unknown as Awaited<ReturnType<typeof runAgent>>["session"];
      options.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false };
    });
    try {
      const host = createWorkflowHost({ pi, ctx: ctx({}), manager, workflowId: "workflow" });
      expect((await host.spawnAgent(request("a"))).ok).toBe(true);
      const record = manager.listAgents()[0];
      if (!record) throw new Error("missing record");
      record.completedAt = Date.now() - 11 * 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(manager.getRecord(record.id)).toBeUndefined();
      capture.mockImplementation(() => { throw new Error("parent disconnected"); });
      expect((await host.resumeAgent?.("a", "continue"))?.ok).toBe(true);
      expect(vi.mocked(runAgent).mock.calls[1][3].executionBackend).toBe(vi.mocked(runAgent).mock.calls[0][3].executionBackend);
      expect(capture).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("rejects remote shell gates before invoking local exec or spawning", async () => {
    const exec = vi.fn();
    const pi = { exec, events: { emit: (_event: string, r: ExecutionBackendRequest) => r.claim({ version: 1, id: "provider", capture: () => ({ ok: true, binding: { version: 1, id: "remote", cwd: "/remote", platform: "linux", prepare: async () => ({ tools: [], dispose: async () => {} }) } }) }) } } as unknown as ExtensionAPI;
    const host = createWorkflowHost({ pi, ctx: ctx({}), manager });
    await expect(host.spawnAgent({ ...request("gate"), gate: "touch forbidden" })).rejects.toThrow("shellGates");
    await expect(host.runGate?.("touch forbidden", {})).rejects.toThrow("shellGates");
    expect(exec).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });
});
