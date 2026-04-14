/**
 * taskflow-bridge.ts — Bridge between the plugin's dispatch-state lifecycle
 * and OpenClaw 2026.4's first-class durable task-flow runtime.
 *
 * OpenClaw 2026.4 added `api.runtime.taskFlow` — a durable, restart-safe task
 * registry with `createManaged`, `runTask`, `setWaiting`, `finish`, `fail`,
 * and `requestCancel` operations. The Linear plugin already keeps its own
 * dispatch-state for tier/issueId/webhook attempt tracking; this bridge
 * mirrors that lifecycle into the openclaw task registry so dispatches show
 * up in any task-aware UI/CLI without us discarding the Linear-specific
 * metadata that doesn't map cleanly onto TaskRunView.
 *
 * Design choices:
 *
 *   • Best-effort. Every call is wrapped in try/catch. If the runtime
 *     surface is missing (older openclaw, test fakes, or the API gets
 *     renamed in a future release) the plugin keeps working — the bridge
 *     logs at debug and the dispatch proceeds without a flow record.
 *
 *   • Stateless from the bridge's perspective. The flowId and the latest
 *     observed revision are stored back into ActiveDispatch so all callers
 *     can resume mutations from whatever the file lock last persisted.
 *
 *   • Phase mapping:
 *       dispatch     → createManaged({ goal: "Resolve <ID>: <title>" })
 *       working      → runTask({ task: "worker", status: "running" })
 *       auditing     → runTask({ task: "audit", status: "running" })
 *       stuck/rework → setWaiting({ blockedSummary })
 *       done         → finish({})
 *       failed       → fail({ blockedSummary })
 *
 *   • Identifier convention: controllerId is `linear-dispatch:<issueIdentifier>`
 *     so tasks created across dispatches stay correlated to a single Linear
 *     issue even after retries.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ActiveDispatch } from "./dispatch-state.js";

const CONTROLLER_PREFIX = "linear-dispatch";

// ---------------------------------------------------------------------------
// Runtime probing
// ---------------------------------------------------------------------------
//
// `api.runtime.taskFlow` and `api.runtime.tasks.flow` are both typed in the
// 2026.4 plugin SDK — the top-level alias is marked @deprecated in favor of
// `api.runtime.tasks.flows` (the read-only DTO API) but the *mutating*
// surface (createManaged, runTask, setWaiting, finish, fail) only exists on
// PluginRuntimeTaskFlow. Until openclaw exposes a non-deprecated mutation
// path we use whichever surface actually has the methods at runtime.

/**
 * `TaskRuntime` enumerates the runtimes the openclaw task registry knows
 * how to auto-settle: `"subagent" | "acp" | "cli" | "cron"`. The Linear
 * plugin's worker/audit phases run via `api.runtime.agent.runEmbeddedPiAgent`
 * which doesn't fit any of these cleanly, but `"subagent"` is the closest —
 * we are spawning a child session on behalf of the dispatch's parent flow.
 *
 * See the runtime in
 * `node_modules/openclaw/dist/plugin-sdk/src/tasks/task-registry.types.d.ts:2`.
 */
type TaskRuntime = "subagent" | "acp" | "cli" | "cron";

interface BoundFlow {
  createManaged(params: {
    controllerId: string;
    goal: string;
    currentStep?: string | null;
    notifyPolicy?: unknown;
    stateJson?: unknown;
    waitJson?: unknown;
  }): { id: string; revision: number };
  runTask(params: {
    flowId: string;
    runtime: TaskRuntime;
    task: string;
    status?: "queued" | "running";
    childSessionKey?: string;
    agentId?: string;
    label?: string;
    progressSummary?: string | null;
  }): unknown;
  setWaiting(params: {
    flowId: string;
    expectedRevision: number;
    currentStep?: string | null;
    blockedSummary?: string | null;
    waitJson?: unknown;
  }): { applied: boolean; flow?: { revision: number } };
  resume(params: {
    flowId: string;
    expectedRevision: number;
    status?: "queued" | "running";
    currentStep?: string | null;
  }): { applied: boolean; flow?: { revision: number } };
  finish(params: {
    flowId: string;
    expectedRevision: number;
    endedAt?: number;
  }): { applied: boolean; flow?: { revision: number } };
  fail(params: {
    flowId: string;
    expectedRevision: number;
    blockedSummary?: string | null;
    endedAt?: number;
  }): { applied: boolean; flow?: { revision: number } };
}

interface TaskFlowApi {
  bindSession(params: { sessionKey: string }): BoundFlow;
}

function resolveTaskFlowApi(api: OpenClawPluginApi): TaskFlowApi | null {
  const runtime = api.runtime as Record<string, unknown> | undefined;
  if (!runtime) return null;
  // Prefer `api.runtime.tasks.flow` (post-2026.4 namespace), fall back to
  // top-level `api.runtime.taskFlow` (deprecated alias still typed in SDK).
  const tasks = runtime.tasks as { flow?: unknown } | undefined;
  const candidate = (tasks?.flow ?? runtime.taskFlow) as TaskFlowApi | undefined;
  if (!candidate || typeof candidate.bindSession !== "function") return null;
  return candidate;
}

function bindFlow(api: OpenClawPluginApi, sessionKey: string): BoundFlow | null {
  const taskFlow = resolveTaskFlowApi(api);
  if (!taskFlow) return null;
  try {
    return taskFlow.bindSession({ sessionKey });
  } catch (err) {
    api.logger.debug?.(`taskflow-bridge: bindSession failed: ${formatErr(err)}`);
    return null;
  }
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function controllerIdFor(dispatch: ActiveDispatch): string {
  return `${CONTROLLER_PREFIX}:${dispatch.issueIdentifier}`;
}

function goalFor(dispatch: ActiveDispatch): string {
  const title = dispatch.issueTitle ?? "(no title)";
  return `Resolve ${dispatch.issueIdentifier}: ${title}`;
}

/**
 * Resolve a session key to bind the managed flow under. We prefer the
 * worker session key (set when the agent is dispatched) and fall back to
 * a synthetic key per issue so the bridge still works when the worker
 * hasn't started yet.
 */
function sessionKeyFor(dispatch: ActiveDispatch): string {
  return (
    dispatch.workerSessionKey ??
    dispatch.auditSessionKey ??
    `linear:dispatch:${dispatch.issueIdentifier}`
  );
}

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Create a managed task flow for a freshly registered dispatch and return
 * the patched ActiveDispatch (with `taskFlowId` + `taskFlowRevision` set).
 *
 * Returns the original dispatch unchanged when the runtime surface is
 * unavailable. Never throws — bridge failures are logged at debug level.
 */
export function createManagedFlowForDispatch(
  api: OpenClawPluginApi,
  dispatch: ActiveDispatch,
): ActiveDispatch {
  const flow = bindFlow(api, sessionKeyFor(dispatch));
  if (!flow) return dispatch;
  try {
    const created = flow.createManaged({
      controllerId: controllerIdFor(dispatch),
      goal: goalFor(dispatch),
      currentStep: "dispatched",
    });
    api.logger.info(
      `taskflow-bridge: created managed flow ${created.id} for ${dispatch.issueIdentifier} ` +
        `(controller=${controllerIdFor(dispatch)})`,
    );
    return {
      ...dispatch,
      taskFlowId: created.id,
      taskFlowRevision: created.revision,
    };
  } catch (err) {
    api.logger.debug?.(
      `taskflow-bridge: createManaged failed for ${dispatch.issueIdentifier}: ${formatErr(err)}`,
    );
    return dispatch;
  }
}

/**
 * Record a child task for a dispatch phase ("worker" / "audit"). The flow
 * runtime will then track that child via the gateway's task registry.
 */
export function recordPhaseTask(
  api: OpenClawPluginApi,
  dispatch: ActiveDispatch,
  phase: "worker" | "audit",
  agentId: string,
  childSessionKey?: string,
): void {
  if (!dispatch.taskFlowId) return;
  const flow = bindFlow(api, sessionKeyFor(dispatch));
  if (!flow) return;
  try {
    flow.runTask({
      flowId: dispatch.taskFlowId,
      // `runtime: "subagent"` is the closest valid TaskRuntime value for
      // our embedded-agent-via-runEmbeddedPiAgent path. The runtime's
      // auto-settlement (subagent-registry → completeTaskRunByRunId) keys
      // off `(runtime, runId, childSessionKey)`. We don't currently
      // register with subagent-registry, so per-task auto-settlement won't
      // fire — but the FLOW-level finish/fail in `markFlowTerminal`
      // cascades the in-progress tasks regardless, which is what we care
      // about for dispatch observability.
      runtime: "subagent",
      task: phase,
      status: "running",
      agentId,
      childSessionKey,
      label: `${dispatch.issueIdentifier} ${phase} (attempt ${dispatch.attempt + 1})`,
      progressSummary: `attempt ${dispatch.attempt + 1}`,
    });
  } catch (err) {
    api.logger.debug?.(
      `taskflow-bridge: runTask(${phase}) failed for ${dispatch.issueIdentifier}: ${formatErr(err)}`,
    );
  }
}

/**
 * Mark the flow as waiting (between phases, or stuck on user input).
 */
export function markFlowWaiting(
  api: OpenClawPluginApi,
  dispatch: ActiveDispatch,
  step: string,
  blockedSummary?: string,
): ActiveDispatch {
  if (!dispatch.taskFlowId || dispatch.taskFlowRevision == null) return dispatch;
  const flow = bindFlow(api, sessionKeyFor(dispatch));
  if (!flow) return dispatch;
  try {
    const result = flow.setWaiting({
      flowId: dispatch.taskFlowId,
      expectedRevision: dispatch.taskFlowRevision,
      currentStep: step,
      blockedSummary,
    });
    if (result.applied && result.flow) {
      return { ...dispatch, taskFlowRevision: result.flow.revision };
    }
  } catch (err) {
    api.logger.debug?.(
      `taskflow-bridge: setWaiting failed for ${dispatch.issueIdentifier}: ${formatErr(err)}`,
    );
  }
  return dispatch;
}

/**
 * Resume the flow into a running phase (used after rework / re-dispatch).
 */
export function markFlowResumed(
  api: OpenClawPluginApi,
  dispatch: ActiveDispatch,
  step: string,
): ActiveDispatch {
  if (!dispatch.taskFlowId || dispatch.taskFlowRevision == null) return dispatch;
  const flow = bindFlow(api, sessionKeyFor(dispatch));
  if (!flow) return dispatch;
  try {
    const result = flow.resume({
      flowId: dispatch.taskFlowId,
      expectedRevision: dispatch.taskFlowRevision,
      status: "running",
      currentStep: step,
    });
    if (result.applied && result.flow) {
      return { ...dispatch, taskFlowRevision: result.flow.revision };
    }
  } catch (err) {
    api.logger.debug?.(
      `taskflow-bridge: resume failed for ${dispatch.issueIdentifier}: ${formatErr(err)}`,
    );
  }
  return dispatch;
}

/**
 * Terminal: finish (success) or fail (with a summary).
 */
export function markFlowTerminal(
  api: OpenClawPluginApi,
  dispatch: ActiveDispatch,
  outcome: "done" | "failed",
  reason?: string,
): void {
  if (!dispatch.taskFlowId || dispatch.taskFlowRevision == null) return;
  const flow = bindFlow(api, sessionKeyFor(dispatch));
  if (!flow) return;
  try {
    if (outcome === "done") {
      flow.finish({
        flowId: dispatch.taskFlowId,
        expectedRevision: dispatch.taskFlowRevision,
        endedAt: Date.now(),
      });
    } else {
      flow.fail({
        flowId: dispatch.taskFlowId,
        expectedRevision: dispatch.taskFlowRevision,
        blockedSummary: reason,
        endedAt: Date.now(),
      });
    }
    api.logger.info(
      `taskflow-bridge: ${outcome === "done" ? "finished" : "failed"} flow ` +
        `${dispatch.taskFlowId} for ${dispatch.issueIdentifier}` +
        (reason ? ` (${reason})` : ""),
    );
  } catch (err) {
    api.logger.debug?.(
      `taskflow-bridge: ${outcome} failed for ${dispatch.issueIdentifier}: ${formatErr(err)}`,
    );
  }
}
