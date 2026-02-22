/**
 * E2E dispatch pipeline tests.
 *
 * Exercises the real pipeline chain: spawnWorker → triggerAudit → processVerdict
 * → handleAuditPass/handleAuditFail, with file-backed dispatch-state, real
 * artifact writes, real notification formatting, and DAG cascade.
 *
 * Only external boundaries are mocked: runAgent, LinearAgentApi, codex-worktree.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Mocks — external boundaries only (vi.hoisted + vi.mock)
// ---------------------------------------------------------------------------

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock("../agent/agent.js", () => ({
  runAgent: runAgentMock,
}));

vi.mock("../agent/watchdog.js", () => ({
  resolveWatchdogConfig: vi.fn(() => ({
    inactivityMs: 120_000,
    maxTotalMs: 7_200_000,
    toolTimeoutMs: 600_000,
  })),
}));

vi.mock("../infra/codex-worktree.js", () => ({
  createWorktree: vi.fn(),
  prepareWorkspace: vi.fn(),
}));

vi.mock("../api/linear-api.js", () => ({
  LinearAgentApi: class {},
  resolveLinearToken: vi.fn().mockReturnValue({ accessToken: "test-token", source: "env" }),
}));

vi.mock("../infra/observability.js", () => ({
  emitDiagnostic: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk", () => ({}));

// ---------------------------------------------------------------------------
// Imports (AFTER mocks)
// ---------------------------------------------------------------------------

import { spawnWorker, clearPromptCache, type HookContext } from "./pipeline.js";
import { registerDispatch, readDispatchState, type ActiveDispatch } from "./dispatch-state.js";
import { writeProjectDispatch, readProjectDispatch, type ProjectDispatchState, type ProjectIssueStatus } from "./dag-dispatch.js";
import { createMockLinearApi, type MockLinearApi } from "../__test__/helpers.js";
import { makeIssueDetails } from "../__test__/fixtures/linear-responses.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "claw-e2e-"));
}

function makeHookCtx(opts?: {
  configPath?: string;
  linearApi?: MockLinearApi;
  pluginConfig?: Record<string, unknown>;
  notifyFn?: Mock;
}): HookContext & { mockLinearApi: MockLinearApi; notifyCalls: Array<[string, unknown]> } {
  const configPath = opts?.configPath ?? join(tmpDir(), "state.json");
  const mockLinearApi = opts?.linearApi ?? createMockLinearApi();
  const notifyCalls: Array<[string, unknown]> = [];
  const notifyFn = opts?.notifyFn ?? vi.fn(async (kind: string, payload: unknown) => {
    notifyCalls.push([kind, payload]);
  });

  return {
    api: {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      pluginConfig: opts?.pluginConfig ?? {},
      runtime: {},
    } as any,
    linearApi: mockLinearApi as any,
    notify: notifyFn,
    pluginConfig: opts?.pluginConfig ?? {},
    configPath,
    mockLinearApi,
    notifyCalls,
  };
}

function makeDispatch(worktreePath: string, overrides?: Partial<ActiveDispatch>): ActiveDispatch {
  return {
    issueId: "issue-1",
    issueIdentifier: "ENG-100",
    worktreePath,
    branch: "codex/ENG-100",
    tier: "small" as const,
    model: "test-model",
    status: "dispatched",
    dispatchedAt: new Date().toISOString(),
    attempt: 0,
    ...overrides,
  };
}

function passVerdict(criteria: string[] = ["tests pass"]) {
  return JSON.stringify({ pass: true, criteria, gaps: [], testResults: "ok" });
}

function failVerdict(gaps: string[] = ["missing tests"], criteria: string[] = []) {
  return JSON.stringify({ pass: false, criteria, gaps, testResults: "failed" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E dispatch pipeline", () => {
  let worktree: string;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPromptCache();
    worktree = tmpDir();
  });

  // =========================================================================
  // Test 1: Happy path — dispatch → working → auditing → done
  // =========================================================================
  it("happy path: dispatch → audit pass → done", async () => {
    const hookCtx = makeHookCtx();
    const dispatch = makeDispatch(worktree);

    // Register the dispatch in state
    await registerDispatch(dispatch.issueIdentifier, dispatch, hookCtx.configPath);

    // Mock linearApi.getIssueDetails for pipeline
    hookCtx.mockLinearApi.getIssueDetails.mockResolvedValue(
      makeIssueDetails({ id: "issue-1", identifier: "ENG-100", title: "Fix auth" }),
    );

    // runAgent: worker returns text, then audit returns pass verdict
    let callCount = 0;
    runAgentMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Worker
        return { success: true, output: "Implemented the fix and added tests.", watchdogKilled: false };
      }
      // Audit
      return { success: true, output: passVerdict(), watchdogKilled: false };
    });

    await spawnWorker(hookCtx, dispatch);

    // Verify state transitions: dispatched → working → auditing → done → completed
    const state = await readDispatchState(hookCtx.configPath);
    expect(state.dispatches.active["ENG-100"]).toBeUndefined(); // moved to completed
    expect(state.dispatches.completed["ENG-100"]).toBeDefined();
    expect(state.dispatches.completed["ENG-100"].status).toBe("done");

    // Verify notify events
    const notifyKinds = hookCtx.notifyCalls.map(([kind]) => kind);
    expect(notifyKinds).toContain("working");
    expect(notifyKinds).toContain("auditing");
    expect(notifyKinds).toContain("audit_pass");

    // Verify Linear comment was posted for audit pass
    expect(hookCtx.mockLinearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Done"),
    );

    // Verify artifacts exist
    const clawDir = join(worktree, ".claw");
    expect(existsSync(join(clawDir, "worker-0.md"))).toBe(true);
    expect(existsSync(join(clawDir, "audit-0.json"))).toBe(true);
    expect(existsSync(join(clawDir, "log.jsonl"))).toBe(true);
  });

  // =========================================================================
  // Test 2: Rework — audit fail → retry → pass
  // =========================================================================
  it("rework: audit fail → retry → pass", async () => {
    const hookCtx = makeHookCtx({ pluginConfig: { maxReworkAttempts: 2 } });
    const dispatch = makeDispatch(worktree);

    await registerDispatch(dispatch.issueIdentifier, dispatch, hookCtx.configPath);

    hookCtx.mockLinearApi.getIssueDetails.mockResolvedValue(
      makeIssueDetails({ id: "issue-1", identifier: "ENG-100", title: "Fix auth" }),
    );

    // Call sequence: worker1, audit1(fail), then pipeline transitions to "working"
    // but does NOT re-invoke spawnWorker for rework — it just sets state.
    // So we test the first spawnWorker (fail), then manually call spawnWorker again
    // for the rework flow.
    let callCount = 0;
    runAgentMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { success: true, output: "First attempt done.", watchdogKilled: false };
      if (callCount === 2) return { success: true, output: failVerdict(["missing tests"]), watchdogKilled: false };
      if (callCount === 3) return { success: true, output: "Reworked: added tests.", watchdogKilled: false };
      return { success: true, output: passVerdict(), watchdogKilled: false };
    });

    // First run — should fail audit
    await spawnWorker(hookCtx, dispatch);

    // After fail, state should be "working" with attempt=1
    let state = await readDispatchState(hookCtx.configPath);
    const reworkDispatch = state.dispatches.active["ENG-100"];
    expect(reworkDispatch).toBeDefined();
    expect(reworkDispatch.status).toBe("working");
    expect(reworkDispatch.attempt).toBe(1);

    // Verify audit_fail notification was sent
    const failNotify = hookCtx.notifyCalls.find(([k]) => k === "audit_fail");
    expect(failNotify).toBeDefined();

    // Rework comment posted
    expect(hookCtx.mockLinearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Needs More Work"),
    );

    // Second run (rework) — dispatch is already in "working" state
    await spawnWorker(hookCtx, reworkDispatch, { gaps: ["missing tests"] });

    // Should now be completed
    state = await readDispatchState(hookCtx.configPath);
    expect(state.dispatches.active["ENG-100"]).toBeUndefined();
    expect(state.dispatches.completed["ENG-100"]).toBeDefined();
    expect(state.dispatches.completed["ENG-100"].status).toBe("done");

    const passNotify = hookCtx.notifyCalls.find(([k]) => k === "audit_pass");
    expect(passNotify).toBeDefined();
  });

  // =========================================================================
  // Test 3: Stuck — max rework exceeded
  // =========================================================================
  it("stuck: max rework exceeded → escalation", async () => {
    const hookCtx = makeHookCtx({ pluginConfig: { maxReworkAttempts: 0 } });
    const dispatch = makeDispatch(worktree);

    await registerDispatch(dispatch.issueIdentifier, dispatch, hookCtx.configPath);

    hookCtx.mockLinearApi.getIssueDetails.mockResolvedValue(
      makeIssueDetails({ id: "issue-1", identifier: "ENG-100", title: "Fix auth" }),
    );

    // Worker succeeds, audit always fails
    let callCount = 0;
    runAgentMock.mockImplementation(async () => {
      callCount++;
      if (callCount % 2 === 1) return { success: true, output: "Attempted fix.", watchdogKilled: false };
      return { success: true, output: failVerdict(["still broken"]), watchdogKilled: false };
    });

    await spawnWorker(hookCtx, dispatch);

    // maxReworkAttempts=0, so first failure should escalate (attempt 0 fails → nextAttempt=1 > max=0)
    const state = await readDispatchState(hookCtx.configPath);
    const stuckDispatch = state.dispatches.active["ENG-100"];
    expect(stuckDispatch).toBeDefined();
    expect(stuckDispatch.status).toBe("stuck");
    expect(stuckDispatch.stuckReason).toContain("audit_failed");

    // Escalation notification
    const escalation = hookCtx.notifyCalls.find(([k]) => k === "escalation");
    expect(escalation).toBeDefined();

    // Escalation comment
    expect(hookCtx.mockLinearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Needs Your Help"),
    );
  });

  // =========================================================================
  // Test 4: Watchdog kill
  // =========================================================================
  it("watchdog kill → stuck", async () => {
    const hookCtx = makeHookCtx();
    const dispatch = makeDispatch(worktree);

    await registerDispatch(dispatch.issueIdentifier, dispatch, hookCtx.configPath);

    hookCtx.mockLinearApi.getIssueDetails.mockResolvedValue(
      makeIssueDetails({ id: "issue-1", identifier: "ENG-100", title: "Fix auth" }),
    );

    // runAgent returns watchdog killed
    runAgentMock.mockResolvedValue({
      success: false,
      output: "",
      watchdogKilled: true,
    });

    await spawnWorker(hookCtx, dispatch);

    // State should be stuck with watchdog reason
    const state = await readDispatchState(hookCtx.configPath);
    const stuckDispatch = state.dispatches.active["ENG-100"];
    expect(stuckDispatch).toBeDefined();
    expect(stuckDispatch.status).toBe("stuck");
    expect(stuckDispatch.stuckReason).toBe("watchdog_kill_2x");

    // Watchdog kill notification
    const wdNotify = hookCtx.notifyCalls.find(([k]) => k === "watchdog_kill");
    expect(wdNotify).toBeDefined();

    // Watchdog comment
    expect(hookCtx.mockLinearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Agent Timed Out"),
    );
  });

  // =========================================================================
  // Test 5: DAG cascade — pass triggers next issue
  // =========================================================================
  it("DAG cascade: audit pass triggers next issue dispatch", async () => {
    const configDir = tmpDir();
    const configPath = join(configDir, "state.json");
    const hookCtx = makeHookCtx({ configPath });
    const dispatch = makeDispatch(worktree, { project: "proj-1" });

    await registerDispatch(dispatch.issueIdentifier, dispatch, configPath);

    hookCtx.mockLinearApi.getIssueDetails.mockResolvedValue(
      makeIssueDetails({ id: "issue-1", identifier: "ENG-100", title: "Fix auth" }),
    );

    // Set up project dispatch state (ENG-100 → ENG-101)
    const projectDispatch: ProjectDispatchState = {
      projectId: "proj-1",
      projectName: "Test Project",
      rootIdentifier: "PROJ-1",
      status: "dispatching",
      startedAt: new Date().toISOString(),
      maxConcurrent: 3,
      issues: {
        "ENG-100": {
          identifier: "ENG-100",
          issueId: "issue-1",
          dependsOn: [],
          unblocks: ["ENG-101"],
          dispatchStatus: "dispatched",
        },
        "ENG-101": {
          identifier: "ENG-101",
          issueId: "issue-2",
          dependsOn: ["ENG-100"],
          unblocks: [],
          dispatchStatus: "pending",
        },
      },
    };
    await writeProjectDispatch(projectDispatch, configPath);

    // Worker + audit pass
    let callCount = 0;
    runAgentMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { success: true, output: "Done.", watchdogKilled: false };
      return { success: true, output: passVerdict(), watchdogKilled: false };
    });

    await spawnWorker(hookCtx, dispatch);

    // Wait a tick for the async DAG cascade (void fire-and-forget)
    await new Promise((r) => setTimeout(r, 100));

    // Read project dispatch state — ENG-100 should be done, ENG-101 should be dispatched
    const updatedProject = await readProjectDispatch("proj-1", configPath);
    expect(updatedProject).not.toBeNull();
    expect(updatedProject!.issues["ENG-100"].dispatchStatus).toBe("done");
    expect(updatedProject!.issues["ENG-101"].dispatchStatus).toBe("dispatched");

    // Verify project_progress notification
    const progressNotify = hookCtx.notifyCalls.find(([k]) => k === "project_progress");
    expect(progressNotify).toBeDefined();
  });

  // =========================================================================
  // Test 6: DAG cascade — stuck propagates
  // =========================================================================
  it("DAG cascade: stuck propagates to project", async () => {
    const configDir = tmpDir();
    const configPath = join(configDir, "state.json");
    const hookCtx = makeHookCtx({ configPath, pluginConfig: { maxReworkAttempts: 0 } });
    const dispatch = makeDispatch(worktree, { project: "proj-1" });

    await registerDispatch(dispatch.issueIdentifier, dispatch, configPath);

    hookCtx.mockLinearApi.getIssueDetails.mockResolvedValue(
      makeIssueDetails({ id: "issue-1", identifier: "ENG-100", title: "Fix auth" }),
    );

    // Set up project dispatch state (ENG-100 → ENG-101, only 2 issues)
    const projectDispatch: ProjectDispatchState = {
      projectId: "proj-1",
      projectName: "Test Project",
      rootIdentifier: "PROJ-1",
      status: "dispatching",
      startedAt: new Date().toISOString(),
      maxConcurrent: 3,
      issues: {
        "ENG-100": {
          identifier: "ENG-100",
          issueId: "issue-1",
          dependsOn: [],
          unblocks: ["ENG-101"],
          dispatchStatus: "dispatched",
        },
        "ENG-101": {
          identifier: "ENG-101",
          issueId: "issue-2",
          dependsOn: ["ENG-100"],
          unblocks: [],
          dispatchStatus: "pending",
        },
      },
    };
    await writeProjectDispatch(projectDispatch, configPath);

    // Worker succeeds, audit fails
    let callCount = 0;
    runAgentMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { success: true, output: "Attempted.", watchdogKilled: false };
      return { success: true, output: failVerdict(["still broken"]), watchdogKilled: false };
    });

    await spawnWorker(hookCtx, dispatch);

    // Wait for async DAG cascade
    await new Promise((r) => setTimeout(r, 100));

    // Project should be stuck since ENG-100 is stuck and ENG-101 depends on it
    const updatedProject = await readProjectDispatch("proj-1", configPath);
    expect(updatedProject).not.toBeNull();
    expect(updatedProject!.issues["ENG-100"].dispatchStatus).toBe("stuck");
    expect(updatedProject!.issues["ENG-101"].dispatchStatus).toBe("pending");
    expect(updatedProject!.status).toBe("stuck");
  });

  // =========================================================================
  // Test 7: Artifact integrity
  // =========================================================================
  it("artifact integrity: manifest, worker output, audit verdict, dispatch log", async () => {
    const hookCtx = makeHookCtx();
    const dispatch = makeDispatch(worktree);

    await registerDispatch(dispatch.issueIdentifier, dispatch, hookCtx.configPath);

    // Pre-create manifest (as webhook.ts handleDispatch would)
    const { ensureClawDir, writeManifest } = await import("./artifacts.js");
    ensureClawDir(worktree);
    writeManifest(worktree, {
      issueIdentifier: "ENG-100",
      issueId: "issue-1",
      tier: "small",
      status: "dispatched",
      attempts: 0,
      dispatchedAt: new Date().toISOString(),
    });

    hookCtx.mockLinearApi.getIssueDetails.mockResolvedValue(
      makeIssueDetails({ id: "issue-1", identifier: "ENG-100", title: "Fix auth" }),
    );

    let callCount = 0;
    runAgentMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { success: true, output: "Worker output here.", watchdogKilled: false };
      return { success: true, output: passVerdict(["unit tests", "lint"]), watchdogKilled: false };
    });

    await spawnWorker(hookCtx, dispatch);

    const clawDir = join(worktree, ".claw");

    // Manifest (updated by pipeline: status→done, attempts→1)
    const manifest = JSON.parse(readFileSync(join(clawDir, "manifest.json"), "utf8"));
    expect(manifest.status).toBe("done");
    expect(manifest.attempts).toBe(1);

    // Worker output
    const workerOutput = readFileSync(join(clawDir, "worker-0.md"), "utf8");
    expect(workerOutput).toBe("Worker output here.");

    // Audit verdict
    const verdict = JSON.parse(readFileSync(join(clawDir, "audit-0.json"), "utf8"));
    expect(verdict.pass).toBe(true);
    expect(verdict.criteria).toContain("unit tests");

    // Dispatch log (JSONL format)
    const logContent = readFileSync(join(clawDir, "log.jsonl"), "utf8");
    const logLines = logContent.trim().split("\n").map((l) => JSON.parse(l));
    expect(logLines.some((e) => e.phase === "worker")).toBe(true);
    expect(logLines.some((e) => e.phase === "audit")).toBe(true);
  });

  // =========================================================================
  // Test 8: Multi-target notify with rich format
  // =========================================================================
  it("multi-target notify: discord + telegram called for lifecycle events", async () => {
    // For this test, we use real createNotifierFromConfig + mock runtime channels
    const { createNotifierFromConfig } = await import("../infra/notify.js");

    const mockRuntime = {
      channel: {
        discord: { sendMessageDiscord: vi.fn().mockResolvedValue(undefined) },
        telegram: { sendMessageTelegram: vi.fn().mockResolvedValue(undefined) },
        slack: { sendMessageSlack: vi.fn().mockResolvedValue(undefined) },
        signal: { sendMessageSignal: vi.fn().mockResolvedValue(undefined) },
      },
    };

    const pluginConfig = {
      notifications: {
        targets: [
          { channel: "discord", target: "discord-channel-1" },
          { channel: "telegram", target: "telegram-chat-1" },
        ],
        richFormat: true,
      },
    };

    const notify = createNotifierFromConfig(pluginConfig, mockRuntime as any);

    const configDir = tmpDir();
    const configPath = join(configDir, "state.json");
    const hookCtx = makeHookCtx({
      configPath,
      pluginConfig,
    });
    // Override notify with the real notifier
    (hookCtx as any).notify = notify;

    const dispatch = makeDispatch(worktree);
    await registerDispatch(dispatch.issueIdentifier, dispatch, configPath);

    hookCtx.mockLinearApi.getIssueDetails.mockResolvedValue(
      makeIssueDetails({ id: "issue-1", identifier: "ENG-100", title: "Fix auth" }),
    );

    let callCount = 0;
    runAgentMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { success: true, output: "Done.", watchdogKilled: false };
      return { success: true, output: passVerdict(), watchdogKilled: false };
    });

    await spawnWorker(hookCtx, dispatch);

    // Both channels should have been called for "working", "auditing", "audit_pass"
    const discordCalls = mockRuntime.channel.discord.sendMessageDiscord.mock.calls;
    const telegramCalls = mockRuntime.channel.telegram.sendMessageTelegram.mock.calls;

    // At least 3 events (working, auditing, audit_pass) × both channels
    expect(discordCalls.length).toBeGreaterThanOrEqual(3);
    expect(telegramCalls.length).toBeGreaterThanOrEqual(3);

    // Verify Discord got the right target
    for (const call of discordCalls) {
      expect(call[0]).toBe("discord-channel-1");
    }

    // Verify Telegram got the right target with HTML (rich format)
    for (const call of telegramCalls) {
      expect(call[0]).toBe("telegram-chat-1");
    }
  });

  // =========================================================================
  // Test 9: Watchdog kill → stuck with artifact verification
  // =========================================================================
  it("watchdog kill writes correct artifacts (log.jsonl, manifest)", async () => {
    const hookCtx = makeHookCtx();
    const dispatch = makeDispatch(worktree);

    await registerDispatch(dispatch.issueIdentifier, dispatch, hookCtx.configPath);

    // Pre-create manifest (as webhook.ts handleDispatch would)
    const { ensureClawDir, writeManifest } = await import("./artifacts.js");
    ensureClawDir(worktree);
    writeManifest(worktree, {
      issueIdentifier: "ENG-100",
      issueId: "issue-1",
      tier: "small",
      status: "dispatched",
      attempts: 0,
      dispatchedAt: new Date().toISOString(),
    });

    hookCtx.mockLinearApi.getIssueDetails.mockResolvedValue(
      makeIssueDetails({ id: "issue-1", identifier: "ENG-100", title: "Fix auth" }),
    );

    runAgentMock.mockResolvedValue({
      success: false,
      output: "partial work before timeout",
      watchdogKilled: true,
    });

    await spawnWorker(hookCtx, dispatch);

    // State should be stuck
    const state = await readDispatchState(hookCtx.configPath);
    expect(state.dispatches.active["ENG-100"].status).toBe("stuck");
    expect(state.dispatches.active["ENG-100"].stuckReason).toBe("watchdog_kill_2x");

    // Artifacts should exist
    const clawDir = join(worktree, ".claw");
    expect(existsSync(join(clawDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(clawDir, "log.jsonl"))).toBe(true);

    // Manifest should reflect stuck status
    const manifest = JSON.parse(readFileSync(join(clawDir, "manifest.json"), "utf8"));
    expect(manifest.status).toBe("stuck");
    expect(manifest.attempts).toBe(1);

    // Log should contain watchdog phase entry
    const logContent = readFileSync(join(clawDir, "log.jsonl"), "utf8");
    const logLines = logContent.trim().split("\n").map((l) => JSON.parse(l));
    const wdEntry = logLines.find((e) => e.phase === "watchdog");
    expect(wdEntry).toBeDefined();
    expect(wdEntry.success).toBe(false);
    expect(wdEntry.watchdog).toBeDefined();
    expect(wdEntry.watchdog.reason).toBe("inactivity");
    expect(wdEntry.watchdog.retried).toBe(true);
    expect(wdEntry.watchdog.thresholdSec).toBeGreaterThan(0);
    expect(wdEntry.outputPreview).toBe("partial work before timeout");

    // Should NOT have audit artifacts (no audit on watchdog kill)
    expect(existsSync(join(clawDir, "audit-0.json"))).toBe(false);
  });

  // =========================================================================
  // Test 10: Watchdog kill comment includes remediation steps
  // =========================================================================
  it("watchdog kill comment includes remediation guidance", async () => {
    const hookCtx = makeHookCtx();
    const dispatch = makeDispatch(worktree);

    await registerDispatch(dispatch.issueIdentifier, dispatch, hookCtx.configPath);

    hookCtx.mockLinearApi.getIssueDetails.mockResolvedValue(
      makeIssueDetails({ id: "issue-1", identifier: "ENG-100", title: "Fix auth" }),
    );

    runAgentMock.mockResolvedValue({
      success: false,
      output: "",
      watchdogKilled: true,
    });

    await spawnWorker(hookCtx, dispatch);

    // Comment should include all remediation steps
    const commentCall = hookCtx.mockLinearApi.createComment.mock.calls[0];
    expect(commentCall).toBeDefined();
    const [issueId, comment] = commentCall;
    expect(issueId).toBe("issue-1");
    expect(comment).toContain("Agent Timed Out");
    expect(comment).toContain("Try again");
    expect(comment).toContain("/dispatch retry ENG-100");
    expect(comment).toContain("Break it down");
    expect(comment).toContain("Increase timeout");
    expect(comment).toContain("inactivitySec");
    expect(comment).toContain("log.jsonl");
    expect(comment).toContain("Stuck — waiting for you");
  });

  // =========================================================================
  // Test 11: Watchdog notification payload shape
  // =========================================================================
  it("watchdog kill sends notification with correct payload", async () => {
    const hookCtx = makeHookCtx();
    const dispatch = makeDispatch(worktree);

    await registerDispatch(dispatch.issueIdentifier, dispatch, hookCtx.configPath);

    hookCtx.mockLinearApi.getIssueDetails.mockResolvedValue(
      makeIssueDetails({ id: "issue-1", identifier: "ENG-100", title: "Fix auth" }),
    );

    runAgentMock.mockResolvedValue({
      success: false,
      output: "",
      watchdogKilled: true,
    });

    await spawnWorker(hookCtx, dispatch);

    // Find the watchdog_kill notification
    const wdNotify = hookCtx.notifyCalls.find(([k]) => k === "watchdog_kill");
    expect(wdNotify).toBeDefined();
    const [kind, payload] = wdNotify!;
    expect(kind).toBe("watchdog_kill");
    expect(payload).toMatchObject({
      identifier: "ENG-100",
      title: "Fix auth",
      status: "stuck",
      attempt: 0,
    });
    expect((payload as any).reason).toMatch(/no I\/O for \d+s/);
  });
});
