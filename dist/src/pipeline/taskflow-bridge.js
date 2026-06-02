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
const CONTROLLER_PREFIX = "linear-dispatch";
/**
 * Locate the managed task-flow mutation API across OpenClaw SDK versions.
 */
function resolveTaskFlowApi(api) {
    const runtime = api.runtime;
    if (!runtime)
        return null;
    const tasks = runtime.tasks;
    for (const candidate of [tasks?.managedFlows, tasks?.flow, runtime.taskFlow]) {
        if (candidate && typeof candidate.bindSession === "function") {
            return candidate;
        }
    }
    return null;
}
/**
 * Bind the task-flow API to the session that owns the Linear dispatch.
 */
function bindFlow(api, sessionKey) {
    const taskFlow = resolveTaskFlowApi(api);
    if (!taskFlow)
        return null;
    try {
        return taskFlow.bindSession({ sessionKey });
    }
    catch (err) {
        api.logger.debug?.(`taskflow-bridge: bindSession failed: ${formatErr(err)}`);
        return null;
    }
}
/**
 * Normalize thrown values for debug logging without leaking stack traces.
 */
function formatErr(err) {
    return err instanceof Error ? err.message : String(err);
}
/**
 * Build the stable OpenClaw controller identifier for a Linear issue.
 */
function controllerIdFor(dispatch) {
    return `${CONTROLLER_PREFIX}:${dispatch.issueIdentifier}`;
}
/**
 * Build the task-flow goal shown in OpenClaw task views.
 */
function goalFor(dispatch) {
    const title = dispatch.issueTitle ?? "(no title)";
    return `Resolve ${dispatch.issueIdentifier}: ${title}`;
}
/**
 * Resolve a session key to bind the managed flow under. We prefer the
 * worker session key (set when the agent is dispatched) and fall back to
 * a synthetic key per issue so the bridge still works when the worker
 * hasn't started yet.
 */
function sessionKeyFor(dispatch) {
    return (dispatch.workerSessionKey ??
        dispatch.auditSessionKey ??
        `linear:dispatch:${dispatch.issueIdentifier}`);
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
export function createManagedFlowForDispatch(api, dispatch) {
    const flow = bindFlow(api, sessionKeyFor(dispatch));
    if (!flow)
        return dispatch;
    try {
        const created = flow.createManaged({
            controllerId: controllerIdFor(dispatch),
            goal: goalFor(dispatch),
            currentStep: "dispatched",
        });
        api.logger.info(`taskflow-bridge: created managed flow ${created.id} for ${dispatch.issueIdentifier} ` +
            `(controller=${controllerIdFor(dispatch)})`);
        return {
            ...dispatch,
            taskFlowId: created.id,
            taskFlowRevision: created.revision,
        };
    }
    catch (err) {
        api.logger.debug?.(`taskflow-bridge: createManaged failed for ${dispatch.issueIdentifier}: ${formatErr(err)}`);
        return dispatch;
    }
}
/**
 * Record a child task for a dispatch phase ("worker" / "audit"). The flow
 * runtime will then track that child via the gateway's task registry.
 */
export function recordPhaseTask(api, dispatch, phase, agentId, childSessionKey) {
    if (!dispatch.taskFlowId)
        return;
    const flow = bindFlow(api, sessionKeyFor(dispatch));
    if (!flow)
        return;
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
    }
    catch (err) {
        api.logger.debug?.(`taskflow-bridge: runTask(${phase}) failed for ${dispatch.issueIdentifier}: ${formatErr(err)}`);
    }
}
/**
 * Mark the flow as waiting (between phases, or stuck on user input).
 */
export function markFlowWaiting(api, dispatch, step, blockedSummary) {
    if (!dispatch.taskFlowId || dispatch.taskFlowRevision == null)
        return dispatch;
    const flow = bindFlow(api, sessionKeyFor(dispatch));
    if (!flow)
        return dispatch;
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
    }
    catch (err) {
        api.logger.debug?.(`taskflow-bridge: setWaiting failed for ${dispatch.issueIdentifier}: ${formatErr(err)}`);
    }
    return dispatch;
}
/**
 * Resume the flow into a running phase (used after rework / re-dispatch).
 */
export function markFlowResumed(api, dispatch, step) {
    if (!dispatch.taskFlowId || dispatch.taskFlowRevision == null)
        return dispatch;
    const flow = bindFlow(api, sessionKeyFor(dispatch));
    if (!flow)
        return dispatch;
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
    }
    catch (err) {
        api.logger.debug?.(`taskflow-bridge: resume failed for ${dispatch.issueIdentifier}: ${formatErr(err)}`);
    }
    return dispatch;
}
/**
 * Terminal: finish (success) or fail (with a summary).
 */
export function markFlowTerminal(api, dispatch, outcome, reason) {
    if (!dispatch.taskFlowId || dispatch.taskFlowRevision == null)
        return;
    const flow = bindFlow(api, sessionKeyFor(dispatch));
    if (!flow)
        return;
    try {
        if (outcome === "done") {
            flow.finish({
                flowId: dispatch.taskFlowId,
                expectedRevision: dispatch.taskFlowRevision,
                endedAt: Date.now(),
            });
        }
        else {
            flow.fail({
                flowId: dispatch.taskFlowId,
                expectedRevision: dispatch.taskFlowRevision,
                blockedSummary: reason,
                endedAt: Date.now(),
            });
        }
        api.logger.info(`taskflow-bridge: ${outcome === "done" ? "finished" : "failed"} flow ` +
            `${dispatch.taskFlowId} for ${dispatch.issueIdentifier}` +
            (reason ? ` (${reason})` : ""));
    }
    catch (err) {
        api.logger.debug?.(`taskflow-bridge: ${outcome} failed for ${dispatch.issueIdentifier}: ${formatErr(err)}`);
    }
}
