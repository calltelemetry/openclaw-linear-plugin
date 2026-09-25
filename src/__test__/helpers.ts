/**
 * Shared test helpers for E2E and integration tests.
 *
 * Provides reusable mock factories that consolidate patterns scattered across
 * unit test files. Existing unit tests keep their local factories; new E2E
 * tests use these from the start.
 */
import { vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { HookContext } from "../pipeline/pipeline.js";
import type { NotifyFn } from "../infra/notify.js";

// ---------------------------------------------------------------------------
// Mock OpenClaw Plugin API
// ---------------------------------------------------------------------------

export function createMockApi(overrides?: Partial<{
  logger: Partial<OpenClawPluginApi["logger"]>;
  pluginConfig: Record<string, unknown>;
  runtime: Record<string, unknown>;
}>): OpenClawPluginApi {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      ...overrides?.logger,
    },
    pluginConfig: overrides?.pluginConfig ?? {},
    runtime: {
      channel: {
        discord: { sendMessageDiscord: vi.fn().mockResolvedValue(undefined) },
        slack: { sendMessageSlack: vi.fn().mockResolvedValue(undefined) },
        telegram: { sendMessageTelegram: vi.fn().mockResolvedValue(undefined) },
        signal: { sendMessageSignal: vi.fn().mockResolvedValue(undefined) },
      },
      ...overrides?.runtime,
    },
  } as unknown as OpenClawPluginApi;
}

// ---------------------------------------------------------------------------
// Mock Linear API
// ---------------------------------------------------------------------------

export interface MockLinearApi {
  getIssueDetails: ReturnType<typeof vi.fn>;
  createComment: ReturnType<typeof vi.fn>;
  emitActivity: ReturnType<typeof vi.fn>;
  updateSession: ReturnType<typeof vi.fn>;
  getProject: ReturnType<typeof vi.fn>;
  getProjectIssues: ReturnType<typeof vi.fn>;
  getTeamStates: ReturnType<typeof vi.fn>;
  getTeamLabels: ReturnType<typeof vi.fn>;
  createIssue: ReturnType<typeof vi.fn>;
  updateIssue: ReturnType<typeof vi.fn>;
  updateIssueExtended: ReturnType<typeof vi.fn>;
  createIssueRelation: ReturnType<typeof vi.fn>;
  getViewerId: ReturnType<typeof vi.fn>;
}

export function createMockLinearApi(overrides?: Partial<MockLinearApi>): MockLinearApi {
  return {
    getIssueDetails: vi.fn().mockResolvedValue(null),
    createComment: vi.fn().mockResolvedValue("comment-id"),
    emitActivity: vi.fn().mockResolvedValue(undefined),
    updateSession: vi.fn().mockResolvedValue(undefined),
    getProject: vi.fn().mockResolvedValue({
      id: "proj-1",
      name: "Test Project",
      description: "",
      state: "started",
      teams: { nodes: [{ id: "team-1", name: "Team" }] },
    }),
    getProjectIssues: vi.fn().mockResolvedValue([]),
    getTeamStates: vi.fn().mockResolvedValue([
      { id: "st-1", name: "Backlog", type: "backlog" },
      { id: "st-2", name: "In Progress", type: "started" },
      { id: "st-3", name: "Done", type: "completed" },
    ]),
    getTeamLabels: vi.fn().mockResolvedValue([]),
    createIssue: vi.fn().mockResolvedValue({ id: "new-issue-id", identifier: "PROJ-NEW" }),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    updateIssueExtended: vi.fn().mockResolvedValue(undefined),
    createIssueRelation: vi.fn().mockResolvedValue(undefined),
    getViewerId: vi.fn().mockResolvedValue("viewer-1"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock HookContext
// ---------------------------------------------------------------------------

export function createMockHookCtx(opts: {
  configPath?: string;
  planningStatePath?: string;
  pluginConfig?: Record<string, unknown>;
  linearApi?: MockLinearApi;
  notify?: NotifyFn;
}): HookContext {
  const configPath = opts.configPath ?? tmpStatePath("claw-hook-");
  return {
    api: createMockApi({
      pluginConfig: {
        dispatchStatePath: configPath,
        planningStatePath: opts.planningStatePath ?? configPath,
        ...opts.pluginConfig,
      },
    }),
    linearApi: (opts.linearApi ?? createMockLinearApi()) as any,
    notify: opts.notify ?? vi.fn().mockResolvedValue(undefined),
    pluginConfig: {
      dispatchStatePath: configPath,
      planningStatePath: opts.planningStatePath ?? configPath,
      ...opts.pluginConfig,
    },
    configPath,
  };
}

// ---------------------------------------------------------------------------
// Temp path helper
// ---------------------------------------------------------------------------

export function tmpStatePath(prefix = "claw-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return join(dir, "state.json");
}
