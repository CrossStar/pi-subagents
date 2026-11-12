import type * as CodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ options: undefined as Record<string, unknown> | undefined, disposed: 0, createError: false, bindError: false }));
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const actual = await importOriginal<typeof CodingAgent>();
  return { ...actual,
    DefaultResourceLoader: class {
      async reload() {}
      getExtensions() { return { extensions: [] }; }
    },
    SettingsManager: { create: () => ({ getSessionDir: () => undefined }) },
    createAgentSession: async (options: Record<string, unknown>) => {
      state.options = options;
      if (state.createError) throw new Error("create failed");
      return { session: {
        messages: [], setSessionName() {}, async bindExtensions() { if (state.bindError) throw new Error("bind failed"); },
        subscribe: () => () => {}, async prompt() {}, dispose() { state.disposed++; },
      } };
    },
  };
});

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import type { ExecutionBackendRequest as importRequest } from "../src/execution-backend.js";

describe("backend session integration", () => {
  afterEach(() => registerAgents(new Map()));
  it.each([false, true])("filters denylist and reports asynchronous cleanup failure (%s)", async cleanupFails => {
    const base = getAgentConfig("Explore");
    if (!base) throw new Error("missing Explore config");
    registerAgents(new Map([["restricted", { ...base, name: "restricted", builtinToolNames: ["read", "bash"], disallowedTools: ["bash"] }]]));
    const dispose = vi.fn(async () => { if (cleanupFails) throw new Error("cleanup failed"); });
    const activity = vi.fn();
    let requested: readonly string[] = [];
    const result = await runAgent({ cwd: "/local", getSystemPrompt: () => "", isProjectTrusted: () => false, modelRegistry: { find: () => undefined } } as unknown as ExtensionContext, "restricted", "inspect", {
      pi: {} as Parameters<typeof runAgent>[3]["pi"], onToolActivity: activity,
      executionBackend: { version: 1, id: "remote", cwd: "/remote", platform: "linux", prepare: async names => {
        requested = names;
        return { tools: names.map(name => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [], details: undefined }) })), dispose };
      } },
    });
    expect(requested).toEqual(["read"]);
    expect(state.options?.customTools).toEqual([expect.objectContaining({ name: "read" })]);
    expect(state.options?.noTools).toBe("builtin");
    expect(dispose).not.toHaveBeenCalled();
    result.session.dispose();
    result.session.dispose();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    if (cleanupFails) await vi.waitFor(() => expect(activity).toHaveBeenCalledWith(expect.objectContaining({ toolName: expect.stringContaining("cleanup failed") })));
  });
  it("releases backend resources when the manager evicts a completed session", async () => {
    vi.useFakeTimers();
    const manager = new AgentManager();
    const dispose = vi.fn(async () => {});
    const binding = { version: 1 as const, id: "remote", cwd: "/remote", platform: "linux", prepare: async (names: readonly string[]) => ({ tools: names.map(name => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [], details: undefined }) })), dispose }) };
    try {
      const pi = { events: { emit: (_event: string, request: importRequest) => request.claim({ version: 1, id: "remote", capture: () => ({ ok: true, binding }) }) } } as unknown as Parameters<typeof runAgent>[3]["pi"];
      const id = manager.spawn(pi, { cwd: "/local", getSystemPrompt: () => "", isProjectTrusted: () => false, modelRegistry: { find: () => undefined } } as unknown as ExtensionContext, "Explore", "inspect", { description: "inspect", isBackground: true });
      const record = manager.getRecord(id);
      if (!record) throw new Error("missing record");
      await record.promise;
      expect(dispose).not.toHaveBeenCalled();
      record.completedAt = Date.now() - 11 * 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(manager.getRecord(id)).toBeUndefined();
      expect(dispose).toHaveBeenCalledTimes(1);
      manager.dispose();
      await Promise.resolve();
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally { manager.dispose(); vi.useRealTimers(); }
  });
  beforeEach(() => { registerAgents(new Map()); state.options = undefined; state.disposed = 0; state.createError = false; state.bindError = false; });
  it.each(["missing", "duplicate", "extra"])("rejects %s provider tools before SDK session creation", async mode => {
    const dispose = vi.fn(async () => {});
    await expect(runAgent({ cwd: "/local", getSystemPrompt: () => "", isProjectTrusted: () => false, modelRegistry: { find: () => undefined } } as unknown as ExtensionContext, "Explore", "inspect", {
      pi: { exec: vi.fn(() => { throw new Error("local forbidden"); }) } as unknown as Parameters<typeof runAgent>[3]["pi"],
      executionBackend: { version: 1, id: "remote", cwd: "/remote", platform: "linux", prepare: async names => {
        const selected = mode === "missing" ? names.slice(1) : mode === "duplicate" ? [...names, names[0]] : [...names, "unexpected"];
        return { tools: selected.map(name => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [], details: undefined }) })), dispose };
      } },
    })).rejects.toThrow("exactly");
    expect(state.options).toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it.each(["create", "bind"])("releases prepared resources after %s failure", async phase => {
    state.createError = phase === "create";
    state.bindError = phase === "bind";
    const dispose = vi.fn(async () => {});
    await expect(runAgent({ cwd: "/local", getSystemPrompt: () => "", isProjectTrusted: () => false, modelRegistry: { find: () => undefined } } as unknown as ExtensionContext, "Explore", "inspect", {
      pi: {} as Parameters<typeof runAgent>[3]["pi"],
      executionBackend: { version: 1, id: "remote", cwd: "/remote", platform: "linux", prepare: async names => ({ tools: names.map(name => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [], details: undefined }) })), dispose }) },
    })).rejects.toThrow(`${phase} failed`);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(state.disposed).toBe(phase === "bind" ? 1 : 0);
  });
  it("runs with provider tools and local storage, releasing only on dispose", async () => {
    let released = 0;
    const exec = vi.fn(() => { throw new Error("local probe forbidden"); });
    const result = await runAgent({
      cwd: "/local", getSystemPrompt: () => "", isProjectTrusted: () => false,
      modelRegistry: { find: () => undefined },
    } as unknown as ExtensionContext, "Explore", "inspect", {
      pi: { exec } as unknown as Parameters<typeof runAgent>[3]["pi"],
      executionBackend: {
        version: 1, id: "test", cwd: "/remote/nonexistent", platform: "remote-os",
        prepare: async names => ({ tools: names.map(name => ({
          name, label: name, description: name, parameters: Type.Object({}),
          execute: async () => ({ content: [], details: undefined }),
        })), dispose: async () => { released++; } }),
      },
    });
    expect(exec).not.toHaveBeenCalled();
    expect(state.options?.cwd).toBe("/local");
    expect(state.options?.noTools).toBe("builtin");
    expect(state.options?.customTools).not.toEqual([]);
    expect(released).toBe(0);
    result.session.dispose();
    result.session.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(released).toBe(1);
  });
});
