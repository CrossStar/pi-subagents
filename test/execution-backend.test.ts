import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { captureExecutionBackend, type ExecutionBackendBinding, type ExecutionBackendProvider, type ExecutionBackendReply, type ExecutionBackendRequest, prepareExecutionBackend } from "../src/execution-backend.js";

function api(handler: (request: ExecutionBackendRequest) => void): Pick<ExtensionAPI, "events"> {
  return { events: { emit: (_name: string, request: unknown) => {
    try { handler(request as ExecutionBackendRequest); } catch { /* Real emitter swallows listener errors. */ }
  } } } as Pick<ExtensionAPI, "events">;
}

const binding: ExecutionBackendBinding = {
  version: 1, id: "remote", cwd: "/remote", platform: "linux",
  prepare: async () => ({ tools: [], dispose: async () => {} }),
};
const provider: ExecutionBackendProvider = {
  version: 1, id: "remote", capture: () => ({ ok: true, binding }),
};

describe("execution backend preparation", () => {
  it("releases resources only once when explicitly disposed", async () => {
    let disposals = 0;
    const prepared = await prepareExecutionBackend({ ...binding, prepare: async () => ({
      tools: [], dispose: async () => { disposals++; },
    }) }, []);
    expect(disposals).toBe(0);
    await Promise.all([prepared.dispose(), prepared.dispose()]);
    expect(disposals).toBe(1);
  });
  it("cleans up a missing tool set", async () => {
    let disposals = 0;
    await expect(prepareExecutionBackend({ ...binding, prepare: async () => ({
      tools: [], dispose: async () => { disposals++; },
    }) }, ["read"])).rejects.toThrow("exactly");
    expect(disposals).toBe(1);
  });
  it("cleans up when aborted during preparation", async () => {
    const controller = new AbortController();
    let disposals = 0;
    await expect(prepareExecutionBackend({ ...binding, prepare: async () => {
      controller.abort();
      return { tools: [], dispose: async () => { disposals++; } };
    } }, [], controller.signal)).rejects.toThrow();
    expect(disposals).toBe(1);
  });
  it("reports cleanup failure together with validation failure", async () => {
    await expect(prepareExecutionBackend({ ...binding, prepare: async () => ({
      tools: [], dispose: async () => { throw new Error("cleanup"); },
    }) }, ["read"])).rejects.toBeInstanceOf(AggregateError);
  });
});

describe("execution backend capture", () => {
  it("leaves unclaimed execution local", () => {
    expect(captureExecutionBackend(api(() => {}), "/project")).toBeUndefined();
  });
  it("invokes capture outside the swallowing emitter", () => {
    expect(() => captureExecutionBackend(api(request => {
      request.claim({ ...provider, capture: () => { throw new Error("disconnected"); } });
    }), "/project")).toThrow("disconnected");
  });
  it("retains a claim when its listener subsequently throws", () => {
    expect(captureExecutionBackend(api(request => {
      request.claim(provider);
      throw new Error("listener failed");
    }), "/project")).toMatchObject({ id: binding.id, cwd: binding.cwd, platform: binding.platform });
  });
  it("refuses unavailable providers without falling back", () => {
    expect(() => captureExecutionBackend(api(request => {
      request.claim({ ...provider, capture: () => ({ ok: false, code: "unavailable", message: "disconnected" }) });
    }), "/project")).toThrow("disconnected");
  });
  it("refuses conflicts before invoking capture", () => {
    let captures = 0;
    const claimed = { ...provider, capture: () => { captures++; return provider.capture(""); } };
    expect(() => captureExecutionBackend(api(request => {
      request.claim(claimed);
      request.claim(claimed);
    }), "/project")).toThrow("Conflicting");
    expect(captures).toBe(0);
  });
  it.each([undefined, null, {}, { ok: true }, { ok: true, binding: { version: 1, id: 42 } }])("rejects claimed malformed replies: %j", result => {
    expect(() => captureExecutionBackend(api(request => {
      request.claim({ ...provider, capture: () => result as ExecutionBackendReply });
    }), "/project")).toThrow("Incompatible execution backend");
  });
  it("rejects malformed claims rather than treating them as absent", () => {
    expect(() => captureExecutionBackend(api(request => {
      request.claim(undefined as unknown as ExecutionBackendProvider);
    }), "/project")).toThrow("Incompatible execution backend provider");
  });
  it.each([0, 2, undefined])("rejects unsupported provider versions %j before capture", version => {
    let captures = 0;
    const incompatible = { ...provider, version, capture: () => { captures++; return provider.capture(""); } };
    expect(() => captureExecutionBackend(api(request => {
      request.claim(incompatible as unknown as ExecutionBackendProvider);
    }), "/project")).toThrow("Incompatible");
    expect(captures).toBe(0);
  });
  it.each(["cwd", "platform", "id"] as const)("rejects empty binding %s", field => {
    expect(() => captureExecutionBackend(api(request => {
      request.claim({ ...provider, capture: () => ({ ok: true, binding: { ...binding, [field]: " " } }) });
    }), "/project")).toThrow("Incompatible");
  });
  it("does not prepare resources during synchronous admission", () => {
    let prepares = 0;
    const captured = { ...binding, prepare: async () => { prepares++; return { tools: [], dispose: async () => {} }; } };
    let seenCwd = "";
    const result = captureExecutionBackend(api(request => {
      expect(request.version).toBe(1);
      expect(request.cwd).toBe("/parent");
      request.claim({ ...provider, capture: cwd => { seenCwd = cwd; return { ok: true, binding: captured }; } });
    }), "/parent");
    expect(result).toMatchObject({ id: captured.id, cwd: captured.cwd, platform: captured.platform });
    expect(Object.isFrozen(result)).toBe(true);
    expect(seenCwd).toBe("/parent");
    expect(prepares).toBe(0);
  });
  it("rejects an incompatible active backend without preparing resources", () => {
    expect(() => captureExecutionBackend(api(request => {
      request.claim({ ...provider, capture: () => ({ ok: false, code: "incompatible", message: "upgrade provider" }) });
    }), "/project")).toThrow("incompatible: upgrade provider");
  });
  it("rejects delayed claims", () => {
    let captured: ExecutionBackendRequest | undefined;
    captureExecutionBackend(api(request => { captured = request; }), "/project");
    expect(() => captured?.claim(provider)).toThrow("synchronously");
  });
});
