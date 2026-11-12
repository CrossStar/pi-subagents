import { type AgentSession, createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createPowerShellToolDefinition, createReadToolDefinition, createWriteToolDefinition, type ExtensionAPI, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export const EXECUTION_PROVENANCE = "subagents:execution-provenance:v1";
/** Legacy sessions predate external execution and are local. Never rediscover. */
export function recoverLocalExecutionBackend(sessionFile: string): ExecutionBackendBinding {
  const saved = SessionManager.open(sessionFile);
  const markers = saved.getEntries().filter(entry => entry.type === "custom" && entry.customType === EXECUTION_PROVENANCE);
  if (markers.some(entry => entry.type === "custom" && entry.data !== "local")) {
    throw new Error("External execution binding unavailable for reopened session");
  }
  return createLocalExecutionBackend(saved.getCwd());
}

const sessionResources = new WeakMap<AgentSession, ExecutionBackendResources>();
export function ownExecutionResources(session: AgentSession, resources: ExecutionBackendResources): void {
  sessionResources.set(session, resources);
}
export async function disposeExecutionResources(session: AgentSession): Promise<void> {
  await sessionResources.get(session)?.dispose();
}

export const EXECUTION_BINDING = Symbol("execution-binding");
export interface ExecutionBackendCapabilities {
  worktree: boolean;
  cwdOverride: boolean;
  memory: boolean;
  nesting: boolean;
  extensions: boolean;
  skills: boolean;
  shellGates: boolean;
}
export function assertExecutionCapabilities(binding: ExecutionBackendBinding, required: Partial<ExecutionBackendCapabilities>): void {
  for (const capability of Object.keys(required) as (keyof ExecutionBackendCapabilities)[]) {
    // These features currently have host-local implementations only. A provider
    // declaration cannot turn those implementations into backend operations.
    if (required[capability] && (!isLocalExecutionBackend(binding) || !binding.capabilities?.[capability])) {
      throw new Error(`Execution backend "${binding.id}" does not support ${capability}`);
    }
  }
}
export function admitExecutionBackend(pi: Pick<ExtensionAPI, "events">, cwd: string): ExecutionBackendBinding {
  return captureExecutionBackend(pi, cwd) ?? createLocalExecutionBackend(cwd);
}

const localBindings = new WeakSet<ExecutionBackendBinding>();

export function isLocalExecutionBackend(binding: ExecutionBackendBinding): boolean {
  return localBindings.has(binding);
}

export function createLocalExecutionBackend(cwd: string): ExecutionBackendBinding {
  // Tool schemas are heterogeneous; the SDK uses the same erased registry type.
  const factories: Record<string, (cwd: string) => ToolDefinition<any, any>> = {
    read: createReadToolDefinition, write: createWriteToolDefinition, edit: createEditToolDefinition,
    bash: createBashToolDefinition, powershell: createPowerShellToolDefinition,
    find: createFindToolDefinition, grep: createGrepToolDefinition, ls: createLsToolDefinition,
  };
  const binding: ExecutionBackendBinding = Object.freeze({
    version: 1, id: "local", cwd, platform: process.platform,
    capabilities: Object.freeze({ worktree: true, cwdOverride: true, memory: true, nesting: true, extensions: true, skills: true, shellGates: true }),
    async prepare(names: readonly string[]) {
      return { tools: names.map(name => {
        if (!factories[name]) throw new Error(`Unknown builtin tool: ${name}`);
        return factories[name](cwd);
      }), dispose: async () => {} };
    },
  });
  localBindings.add(binding);
  return binding;
}

export const EXECUTION_BACKEND_EVENT = "subagents:execution-backend:v1";

/** Owned by one prepared session, never by a turn or by the reusable binding. */
export interface ExecutionBackendResources {
  /** Exactly the requested built-ins: no missing, extra, or duplicate names. */
  readonly tools: readonly ToolDefinition[];
  /** Idempotent; also called when session construction fails. */
  dispose(): Promise<void>;
}

/** Process-local reusable binding. Never persist this object in a transcript. */
export interface ExecutionBackendBinding {
  readonly version: 1;
  readonly id: string;
  readonly cwd: string;
  readonly capabilities?: Readonly<Partial<ExecutionBackendCapabilities>>;
  readonly platform: string;
  /** Every call allocates independently owned session resources. */
  prepare(toolNames: readonly string[], signal?: AbortSignal): Promise<ExecutionBackendResources>;
}

export type ExecutionBackendReply =
  | { ok: true; binding: ExecutionBackendBinding }
  | { ok: false; code: "unavailable" | "incompatible"; message: string };

export interface ExecutionBackendProvider {
  readonly version: 1;
  readonly id: string;
  /** Invoked directly by the consumer, outside the swallowing event emitter. */
  capture(cwd: string): ExecutionBackendReply;
}

export interface ExecutionBackendRequest {
  readonly version: 1;
  readonly cwd: string;
  /** Claim synchronously, before doing any work that can fail. */
  claim(provider: ExecutionBackendProvider): void;
}

/** Capture before filesystem validation or queue admission; never choose between providers. */
export function captureExecutionBackend(pi: Pick<ExtensionAPI, "events">, cwd: string): ExecutionBackendBinding | undefined {
  const claims: ExecutionBackendProvider[] = [];
  let accepting = true;
  const request: ExecutionBackendRequest = {
    version: 1,
    cwd,
    claim(provider) {
      if (!accepting) throw new Error("Execution backend must claim synchronously");
      claims.push(provider);
    },
  };
  try {
    pi.events?.emit(EXECUTION_BACKEND_EVENT, request);
  } finally {
    accepting = false;
  }
  if (claims.length > 1) throw new Error("Conflicting execution backend providers");
  if (claims.length === 0) return undefined;
  const provider = claims[0];
  if (!provider || provider.version !== 1 || typeof provider.id !== "string" || !provider.id.trim() ||
      typeof provider.capture !== "function") {
    throw new Error("Incompatible execution backend provider");
  }
  // Deliberately outside emit: throws propagate, and a claimed provider returning
  // nothing is an error rather than permission to run on the local machine.
  const reply = provider.capture(cwd);
  if (!reply || typeof reply !== "object" || typeof reply.ok !== "boolean") {
    throw new Error("Incompatible execution backend reply");
  }
  if (!reply.ok) throw new Error(`Execution backend ${reply.code}: ${reply.message}`);
  const binding = reply.binding;
  if (!binding || typeof binding !== "object" || binding.version !== 1 ||
      typeof binding.id !== "string" || !binding.id.trim() ||
      typeof binding.cwd !== "string" || !binding.cwd.trim() ||
      typeof binding.platform !== "string" || !binding.platform.trim() ||
      typeof binding.prepare !== "function") {
    throw new Error("Incompatible execution backend binding");
  }
  // v1 external providers supply execution tools only. Host-owned features need
  // additional operations before a provider can safely advertise them.
  if (Object.values(binding.capabilities ?? {}).some(value => value !== false)) {
    throw new Error("Incompatible execution backend capabilities: external v1 supports tools only");
  }
  return Object.freeze({
    version: 1, id: binding.id, cwd: binding.cwd, platform: binding.platform,
    capabilities: Object.freeze({ ...binding.capabilities }), prepare: binding.prepare.bind(binding),
  });
}

/** Validate prepared tools before exposing any executable tool to a session. */
export async function prepareExecutionBackend(
  binding: ExecutionBackendBinding,
  toolNames: readonly string[],
  signal?: AbortSignal,
): Promise<ExecutionBackendResources> {
  signal?.throwIfAborted();
  if (new Set(toolNames).size !== toolNames.length) {
    throw new Error("Duplicate requested execution backend tools");
  }
  const resources = await binding.prepare(Object.freeze([...toolNames]), signal);
  if (!resources || typeof resources.dispose !== "function") {
    throw new Error("Incompatible execution backend resources");
  }
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= Promise.resolve().then(() => resources.dispose());
  try {
    signal?.throwIfAborted();
    if (!Array.isArray(resources.tools)) throw new Error("Incompatible execution backend tools");
    const names = resources.tools.map(tool => tool?.name);
    if (names.length !== toolNames.length || new Set(names).size !== names.length ||
        names.some(name => !toolNames.includes(name)) ||
        resources.tools.some(tool => typeof tool.execute !== "function")) {
      throw new Error("Execution backend must provide exactly the requested tools");
    }
    return { tools: Object.freeze([...resources.tools]), dispose };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Execution backend preparation and cleanup failed");
    }
    throw error;
  }
}
