import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

let root: string;
let cwd: string;
let faux: ReturnType<typeof registerFauxProvider>;
beforeEach(() => {
  registerAgents(new Map());
  root = mkdtempSync(join(tmpdir(), "child-storage-"));
  cwd = join(root, "project");
  mkdirSync(cwd);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", join(root, "main-custom"));
  mkdirSync(join(root, "agent"));
  writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ sessionDir: join(root, "settings-main") }));
  faux = registerFauxProvider({ provider: "faux", models: [{ id: "storage" }] });
});
afterEach(() => {
  faux.unregister();
  registerAgents(new Map());
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function child(overrides: { persistSession?: boolean; sessionDir?: string } = {}, resumeSessionFile?: string) {
  const base = getAgentConfig("Explore");
  if (!base) throw new Error("missing Explore");
  registerAgents(new Map([["storage", { ...base, name: "storage", extensions: false, skills: false, ...overrides }]]));
  const model = faux.getModel();
  const ctx = { cwd, getSystemPrompt: () => "", isProjectTrusted: () => true, model, modelRegistry: {
    find: () => model, getAvailable: () => [model], getAll: () => [model],
  } } as unknown as ExtensionContext;
  // Capture actual SDK storage without network or provider execution.
  const stop = new Error("captured");
  let manager: SessionManager | undefined;
  await expect(runAgent(ctx, "storage", "go", {
    pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as Parameters<typeof runAgent>[3]["pi"],
    resumeSessionFile,
    onSessionCreated: session => {
      manager = session.sessionManager;
      manager.appendMessage({ role: "user", content: "persist me", timestamp: Date.now() });
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "saved" }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
      throw stop;
    },
  })).rejects.toBe(stop);
  if (!manager) throw new Error("no session");
  return manager;
}

it("keeps persisted children out of main SDK discovery and reopens the recorded path", async () => {
  const manager = await child();
  const file = manager.getSessionFile()!;
  expect(file.startsWith(join(root, "agent", "subagent-sessions"))).toBe(true);
  expect(await SessionManager.list(cwd)).toEqual([]);
  expect(await SessionManager.listAll()).toEqual([]);
  expect(await SessionManager.listAll(join(root, "main-custom"))).toEqual([]);
  expect(await SessionManager.listAll(join(root, "settings-main"))).toEqual([]);
  expect((await SessionManager.list(cwd, dirname(file))).map(s => s.path)).toContain(file);
  const reopened = await child({}, file);
  expect(reopened.getSessionFile()).toBe(file);
  expect(reopened.getEntries().filter(e => e.type === "message")).toHaveLength(4);
});

it("honors explicit session_dir and resumes legacy paths in place", async () => {
  const manager = await child({ sessionDir: "legacy-sessions" });
  const file = manager.getSessionFile()!;
  expect(dirname(file)).toBe(join(cwd, "legacy-sessions"));
  expect((await child({}, file)).getSessionFile()).toBe(file);
});

it("keeps persist_session false in memory", async () => {
  expect((await child({ persistSession: false })).getSessionFile()).toBeUndefined();
});
