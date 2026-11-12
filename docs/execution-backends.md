# Execution backends

For extension authors providing a tool execution environment to pi-subagents.
The protocol types are defined in `src/execution-backend.ts`; this is an in-process integration, not a JSON RPC or subprocess protocol.

## Discovery and capture

The event name is `subagents:execution-backend:v1` (`EXECUTION_BACKEND_EVENT`). Its payload is `ExecutionBackendRequest`:

```ts
interface ExecutionBackendRequest {
  readonly version: 1;
  readonly cwd: string;
  claim(provider: ExecutionBackendProvider): void;
}
interface ExecutionBackendProvider {
  readonly version: 1;
  readonly id: string;
  capture(cwd: string): ExecutionBackendReply;
}
type ExecutionBackendReply =
  | { ok: true; binding: ExecutionBackendBinding }
  | { ok: false; code: "unavailable" | "incompatible"; message: string };
```

Register the listener during extension activation, before tasks can be admitted. An inactive provider makes no claim. An active provider must call `request.claim(provider)` synchronously, before any potentially failing work. Do not await connection checks in the listener. `captureExecutionBackend` invokes the claimed provider's `capture` directly after event emission returns; exceptions from capture therefore propagate even when the event bus swallows listener exceptions.

No claim permits the built-in local backend. More than one claim is an error, including duplicate claims from the same provider. An incompatible provider, invalid reply, failed capture, or unavailable active environment is an error, never permission to run locally. The protocol cannot detect a listener that throws before claiming: claim-first is a mandatory provider obligation, not an optional optimization. Claims after event emission are rejected.

Discovery is the capability handshake. Providers must not inspect source patches, install patches, or use a separate “patched” flag. There is no compatibility channel for the old child protocol.

## Binding and preparation

```ts
interface ExecutionBackendCapabilities {
  worktree: boolean;
  cwdOverride: boolean;
  memory: boolean;
  nesting: boolean;
  extensions: boolean;
  skills: boolean;
  shellGates: boolean;
}
interface ExecutionBackendBinding {
  readonly version: 1;
  readonly id: string;
  readonly cwd: string;
  readonly capabilities?: Readonly<Partial<ExecutionBackendCapabilities>>;
  readonly platform: string;
  prepare(toolNames: readonly string[], signal?: AbortSignal):
    Promise<ExecutionBackendResources>;
}
interface ExecutionBackendResources {
  readonly tools: readonly ToolDefinition[];
  dispose(): Promise<void>;
}
```

`ToolDefinition` is pi's tool definition type. IDs, cwd and platform must be nonempty strings. Capture is synchronous and creates a reusable process-local binding. The consumer freezes a copy of its metadata and capabilities and binds its `prepare` method to the provider's original object; it does not preserve provider object identity or freeze the provider's closure. Preparation is asynchronous and allocates independently owned resources for one session. A provider must close over the captured environment: tool execution and subsequent prepare calls must not consult the parent's current host, current directory, or connection selection. Losing the captured connection must fail against that environment, never reroute.

The provider must return exactly the requested built-in tool names, without missing, duplicate or extra entries. Tool permissions belong to subagents: the provider must not widen the agent type's scope or undo its denylist. Local helpers such as `StructuredOutput` are separate from this list. Supplying a remote `read` does not authorize a same-named local built-in to execute.

A successful prepare transfers resources to the session. Dispose must be idempotent and release only that session's leases/tools; it must not close a shared parent connection or destroy the reusable binding. If prepare fails before returning resources, the provider owns cleanup of partial allocations. If it returns successfully but session creation fails or aborts, the consumer owns disposal. A completed turn is not session disposal: retained sessions can resume. Eviction and final session disposal release resources. Providers must handle abort during preparation and must return cleanup failures as rejected promises, never detached unhandled rejections.

## Capabilities and admission

External v1 providers supply execution tools only. Omitted capabilities mean unsupported; supplied entries must be `false`. Capture rejects any supplied value other than `false`, including a claim of support for a host-owned feature. The built-in local binding declares every capability `true`. `assertExecutionCapabilities(binding, required: Partial<ExecutionBackendCapabilities>): void` requires both a consumer-created local binding and the requested capability. An external object named `local`, or a directly supplied external binding declaring `true`, cannot authorize local host operations.

| Capability | Request that requires it |
|---|---|
| `worktree` | Effective worktree isolation |
| `cwdOverride` | Explicit spawn `cwd` override; the provider's captured cwd itself needs no override |
| `memory` | Agent persistent memory |
| `nesting` | Non-isolated agent with `allowed_subagents` |
| `extensions` | Explicit extension lists, extension tool selectors or MCP patterns |
| `skills` | Explicit skill list |
| `shellGates` | Workflow shell verification gate |

Ambient extension and skill inheritance is disabled for external bindings, including the default `true` settings. Explicit requests above fail before execution. These booleans do not supply worktree or gate operations: advertising them cannot enable those host-local implementations for an external provider.

The manager captures before queue admission and local cwd validation, retains the binding through queue drain and live resume, and indexes saved session files to their binding for reopening within its lifetime. Workflow tool and CLI entry points capture before resolving their local script source. Hosts pass that binding to their children, including parallel calls and retries. `resumeFromRunId` reuses the original run's process-local binding and fails if it is missing; journal replay does not reconstruct it. Reopening a child prepares independent resources using the manager's session-file binding. Internal propagation uses the `EXECUTION_BINDING` symbol, never a JSON spawn option. Session eviction removes the live agent's binding but retains the session-file index until manager disposal.

Model execution, authentication, configuration discovery and session storage remain local. The execution prompt uses the binding's cwd and platform; external paths are not passed to local environment/git detection. Workflow scripts and journals also remain local.

Bindings never enter model parameters, RPC JSON, journals or transcripts. The runner writes only an inert custom session entry with type `subagents:execution-provenance:v1` and data `"local"` or `"external"`, before creating the SDK session. This provenance records execution origin; it contains no provider, connection or executable binding.

When reopening without a retained session-file binding, `recoverLocalExecutionBackend(sessionFile)` reads that provenance and the saved session cwd:

- All provenance entries contain `"local"`: reconstruct the built-in local binding using `SessionManager.getCwd()`.
- No provenance entry: treat the legacy session as local and use its saved cwd.
- Any provenance entry contains `"external"` or any unknown value: refuse with `External execution binding unavailable for reopened session`.

Recovery never emits discovery, so a newly active provider cannot redirect an old local session. External bindings have no serialization or restart recovery; selecting an environment with the same name cannot restore one. Existing worktree/session reopen restrictions still apply. Saved results can be read independently of execution recovery.

## Implementing a provider in sydney-kit

Register a listener for `subagents:execution-backend:v1` when the extension activates. Its synchronous decision is whether its execution environment is active. If inactive, return without claiming. If active, immediately call `request.claim(provider)`, even if the connection is broken. Put fallible validation in `provider.capture(cwd)`, which the consumer invokes directly.

Implement the exact interfaces above: `version: 1`, a nonempty provider `id`, synchronous `capture(cwd)` returning the discriminated reply, and a successful binding with its own `version`, `id`, captured `cwd`, `platform`, and asynchronous `prepare(toolNames, signal)`. Capture must snapshot the selected endpoint and cwd. Return `{ ok: false, code: "unavailable", message }` for an unusable active connection, or `"incompatible"` for an unsupported integration. Omit capabilities or supply only `false` entries.

Preparation must construct the requested pi `ToolDefinition` objects against that snapshot. Built-in names are `read`, `write`, `edit`, `bash`, `powershell`, `find`, `grep`, and `ls`; the actual request is the consumer's filtered subset. Each tool needs its exact name and callable `execute`, plus the normal pi schema and metadata. A transport supporting only a subset must reject an unsupported request; it must never substitute a local tool. Allocate session-owned leases and return an idempotent asynchronous `dispose`. Keep shared parent transport ownership with sydney-kit.

Use the versioned request and capability validation as the compatibility check. This integration requires no source patch or patch marker; spawn RPC protocol version alone does not establish backend support. Observing a discovery request proves that a consumer is asking for v1, but a registered listener alone does not prove an older consumer will call it. The provider must arrange its own unsupported-consumer diagnostic if needed. Transport-specific configuration and connection management stay in sydney-kit.

## Cleanup behavior

`prepareExecutionBackend` checks abort before calling prepare and again after it returns. It freezes a copy of the requested names, rejects duplicate requests, and validates exact returned names and callable executors. Validation failure or an abort after successful preparation disposes the returned resources. If both validation and disposal fail, it throws an `AggregateError` containing both errors. A return without a callable `dispose` cannot be cleaned up by the consumer; the provider must never return such a partially constructed resource object.

The runner uses the same preparation path for local and external bindings. For external bindings it disables SDK built-ins and registers prepared tools alongside local orchestration helpers such as `StructuredOutput`. Local sessions retain SDK built-in registration to preserve shell settings, image settings and extension overrides. Session creation or initialization failures dispose resources and preserve cleanup failures in an `AggregateError`. Normal session disposal starts asynchronous cleanup; rejection is reported through a `backend-cleanup-error:…` tool-activity event. Manager teardown additionally awaits the session's tracked cleanup and logs a warning if it rejects. Turn completion retains resources while the session remains resumable.
