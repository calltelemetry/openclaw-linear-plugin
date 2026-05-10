import { describe, it, expect, vi } from "vitest";
import {
  createManagedFlowForDispatch,
  recordPhaseTask,
  markFlowWaiting,
  markFlowResumed,
  markFlowTerminal,
} from "./taskflow-bridge.js";
import type { ActiveDispatch } from "./dispatch-state.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeDispatch(overrides: Partial<ActiveDispatch> = {}): ActiveDispatch {
  return {
    issueId: "issue-1",
    issueIdentifier: "ENG-100",
    issueTitle: "Fix the auth bug",
    worktreePath: "/tmp/worktree",
    branch: "fix/auth",
    tier: "medium",
    model: "anthropic/sonnet",
    status: "dispatched",
    dispatchedAt: "2026-04-14T00:00:00.000Z",
    attempt: 0,
    workerSessionKey: "worker-session-1",
    ...overrides,
  };
}

function makeApi(taskFlowImpl?: unknown) {
  const logs: { level: string; msg: string }[] = [];
  return {
    api: {
      logger: {
        info: (msg: string) => logs.push({ level: "info", msg }),
        warn: (msg: string) => logs.push({ level: "warn", msg }),
        debug: (msg: string) => logs.push({ level: "debug", msg }),
        error: (msg: string) => logs.push({ level: "error", msg }),
      },
      runtime: taskFlowImpl
        ? { tasks: { managedFlows: taskFlowImpl } }
        : {},
    } as any,
    logs,
  };
}

function makeFlow() {
  const flow = {
    createManaged: vi.fn().mockReturnValue({ id: "flow-1", revision: 1 }),
    runTask: vi.fn().mockReturnValue({ created: true }),
    setWaiting: vi.fn().mockReturnValue({ applied: true, flow: { revision: 2 } }),
    resume: vi.fn().mockReturnValue({ applied: true, flow: { revision: 3 } }),
    finish: vi.fn().mockReturnValue({ applied: true, flow: { revision: 4 } }),
    fail: vi.fn().mockReturnValue({ applied: true, flow: { revision: 4 } }),
  };
  const taskFlow = {
    bindSession: vi.fn().mockReturnValue(flow),
  };
  return { taskFlow, flow };
}

// ---------------------------------------------------------------------------
// createManagedFlowForDispatch
// ---------------------------------------------------------------------------

describe("createManagedFlowForDispatch", () => {
  it("creates a managed flow and patches the dispatch with id+revision", () => {
    const { taskFlow, flow } = makeFlow();
    const { api } = makeApi(taskFlow);
    const dispatch = makeDispatch();

    const next = createManagedFlowForDispatch(api, dispatch);

    expect(taskFlow.bindSession).toHaveBeenCalledWith({ sessionKey: "worker-session-1" });
    expect(flow.createManaged).toHaveBeenCalledWith({
      controllerId: "linear-dispatch:ENG-100",
      goal: "Resolve ENG-100: Fix the auth bug",
      currentStep: "dispatched",
    });
    expect(next.taskFlowId).toBe("flow-1");
    expect(next.taskFlowRevision).toBe(1);
    // Original is not mutated
    expect(dispatch.taskFlowId).toBeUndefined();
  });

  it("falls back to a synthetic session key when no worker key is set", () => {
    const { taskFlow } = makeFlow();
    const { api } = makeApi(taskFlow);
    const dispatch = makeDispatch({ workerSessionKey: undefined, auditSessionKey: undefined });

    createManagedFlowForDispatch(api, dispatch);

    expect(taskFlow.bindSession).toHaveBeenCalledWith({ sessionKey: "linear:dispatch:ENG-100" });
  });

  it("returns the original dispatch unchanged when runtime.taskFlow is missing", () => {
    const { api } = makeApi(undefined);
    const dispatch = makeDispatch();

    const next = createManagedFlowForDispatch(api, dispatch);

    expect(next).toBe(dispatch);
  });

  it("swallows createManaged errors and logs at debug level", () => {
    const flow = {
      createManaged: vi.fn().mockImplementation(() => { throw new Error("boom"); }),
      runTask: vi.fn(),
      setWaiting: vi.fn(),
      resume: vi.fn(),
      finish: vi.fn(),
      fail: vi.fn(),
    };
    const taskFlow = { bindSession: vi.fn().mockReturnValue(flow) };
    const { api, logs } = makeApi(taskFlow);
    const dispatch = makeDispatch();

    const next = createManagedFlowForDispatch(api, dispatch);

    expect(next).toBe(dispatch);
    expect(next.taskFlowId).toBeUndefined();
    expect(logs.some((l) => l.level === "debug" && l.msg.includes("createManaged failed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// recordPhaseTask
// ---------------------------------------------------------------------------

describe("recordPhaseTask", () => {
  it("calls runTask with phase + agent metadata when the flow exists", () => {
    const { taskFlow, flow } = makeFlow();
    const { api } = makeApi(taskFlow);
    const dispatch = makeDispatch({ taskFlowId: "flow-1", taskFlowRevision: 1, attempt: 2 });

    recordPhaseTask(api, dispatch, "worker", "kaylee", "session-key");

    expect(flow.runTask).toHaveBeenCalledWith({
      flowId: "flow-1",
      // "subagent" is the closest valid TaskRuntime for our embedded path.
      runtime: "subagent",
      task: "worker",
      status: "running",
      agentId: "kaylee",
      childSessionKey: "session-key",
      label: "ENG-100 worker (attempt 3)",
      progressSummary: "attempt 3",
    });
  });

  it("no-ops when dispatch has no taskFlowId", () => {
    const { taskFlow, flow } = makeFlow();
    const { api } = makeApi(taskFlow);
    const dispatch = makeDispatch(); // no taskFlowId

    recordPhaseTask(api, dispatch, "worker", "kaylee");

    expect(taskFlow.bindSession).not.toHaveBeenCalled();
    expect(flow.runTask).not.toHaveBeenCalled();
  });

  it("no-ops when runtime.taskFlow is missing", () => {
    const { api } = makeApi(undefined);
    const dispatch = makeDispatch({ taskFlowId: "flow-1", taskFlowRevision: 1 });

    expect(() => recordPhaseTask(api, dispatch, "audit", "inara")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// markFlowWaiting / markFlowResumed
// ---------------------------------------------------------------------------

describe("markFlowWaiting", () => {
  it("calls setWaiting and bumps the cached revision", () => {
    const { taskFlow, flow } = makeFlow();
    const { api } = makeApi(taskFlow);
    const dispatch = makeDispatch({ taskFlowId: "flow-1", taskFlowRevision: 1 });

    const next = markFlowWaiting(api, dispatch, "auditing", "blocked on review");

    expect(flow.setWaiting).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 1,
      currentStep: "auditing",
      blockedSummary: "blocked on review",
    });
    expect(next.taskFlowRevision).toBe(2);
  });

  it("returns the dispatch unchanged when no taskFlowId is set", () => {
    const { taskFlow } = makeFlow();
    const { api } = makeApi(taskFlow);
    const dispatch = makeDispatch();

    const next = markFlowWaiting(api, dispatch, "auditing");

    expect(next).toBe(dispatch);
  });
});

describe("markFlowResumed", () => {
  it("calls resume with status running and updates the cached revision", () => {
    const { taskFlow, flow } = makeFlow();
    const { api } = makeApi(taskFlow);
    const dispatch = makeDispatch({ taskFlowId: "flow-1", taskFlowRevision: 2 });

    const next = markFlowResumed(api, dispatch, "rework");

    expect(flow.resume).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 2,
      status: "running",
      currentStep: "rework",
    });
    expect(next.taskFlowRevision).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// markFlowTerminal
// ---------------------------------------------------------------------------

describe("markFlowTerminal", () => {
  it("calls finish on success", () => {
    const { taskFlow, flow } = makeFlow();
    const { api } = makeApi(taskFlow);
    const dispatch = makeDispatch({ taskFlowId: "flow-1", taskFlowRevision: 3 });

    markFlowTerminal(api, dispatch, "done");

    expect(flow.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: "flow-1",
        expectedRevision: 3,
      }),
    );
    expect(flow.fail).not.toHaveBeenCalled();
  });

  it("calls fail with the blocked summary on failure", () => {
    const { taskFlow, flow } = makeFlow();
    const { api } = makeApi(taskFlow);
    const dispatch = makeDispatch({ taskFlowId: "flow-1", taskFlowRevision: 3 });

    markFlowTerminal(api, dispatch, "failed", "audit failed 2x");

    expect(flow.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: "flow-1",
        expectedRevision: 3,
        blockedSummary: "audit failed 2x",
      }),
    );
    expect(flow.finish).not.toHaveBeenCalled();
  });

  it("no-ops when the dispatch has no taskFlowId", () => {
    const { taskFlow, flow } = makeFlow();
    const { api } = makeApi(taskFlow);

    markFlowTerminal(api, makeDispatch(), "done");

    expect(flow.finish).not.toHaveBeenCalled();
    expect(taskFlow.bindSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Compatibility with OpenClaw task-flow namespaces
// ---------------------------------------------------------------------------

describe("namespace fallback", () => {
  it("prefers runtime.tasks.managedFlows over deprecated aliases", () => {
    const { taskFlow: managedFlows, flow } = makeFlow();
    const deprecatedFlow = { bindSession: vi.fn() };
    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      runtime: { tasks: { managedFlows, flow: deprecatedFlow }, taskFlow: deprecatedFlow },
    } as any;

    const next = createManagedFlowForDispatch(api, makeDispatch());

    expect(managedFlows.bindSession).toHaveBeenCalled();
    expect(deprecatedFlow.bindSession).not.toHaveBeenCalled();
    expect(flow.createManaged).toHaveBeenCalled();
    expect(next.taskFlowId).toBe("flow-1");
  });

  it("uses runtime.tasks.flow when api.runtime.taskFlow is absent", () => {
    const { taskFlow, flow } = makeFlow();
    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      runtime: { tasks: { flow: taskFlow } }, // no top-level taskFlow
    } as any;

    const next = createManagedFlowForDispatch(api, makeDispatch());

    expect(taskFlow.bindSession).toHaveBeenCalled();
    expect(flow.createManaged).toHaveBeenCalled();
    expect(next.taskFlowId).toBe("flow-1");
  });

  it("uses runtime.taskFlow for OpenClaw 2026.4 compatibility", () => {
    const { taskFlow, flow } = makeFlow();
    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      runtime: { taskFlow },
    } as any;

    const next = createManagedFlowForDispatch(api, makeDispatch());

    expect(taskFlow.bindSession).toHaveBeenCalled();
    expect(flow.createManaged).toHaveBeenCalled();
    expect(next.taskFlowId).toBe("flow-1");
  });
});
