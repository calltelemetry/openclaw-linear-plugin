/**
 * sub-issue-decomposition.test.ts — Mock replay of sub-issue creation flow.
 *
 * Uses recorded API responses from the smoke test to verify parent-child
 * hierarchy creation, parentId resolution, and issue relation handling.
 *
 * Run with: npx vitest run src/pipeline/sub-issue-decomposition.test.ts
 * No credentials required — all API calls use recorded fixtures.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock external dependencies before imports
vi.mock("openclaw/plugin-sdk/core", () => ({
  jsonResult: (data: any) => ({ type: "json", data, content: [{ type: "text", text: JSON.stringify(data) }], details: data }),
}));

vi.mock("../api/linear-api.js", () => ({
  LinearAgentApi: vi.fn(),
}));

import { RECORDED } from "../__test__/fixtures/recorded-sub-issue-flow.js";
import {
  createPlannerTools,
  setActivePlannerContext,
  clearActivePlannerContext,
  detectCycles,
  auditPlan,
  buildPlanSnapshot,
} from "../tools/planner-tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProjectIssue = Parameters<typeof detectCycles>[0][number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createReplayApi() {
  const api = {
    getTeamStates: vi.fn().mockResolvedValue(RECORDED.teamStates),
    createIssue: vi.fn(),
    getIssueDetails: vi.fn(),
    createIssueRelation: vi.fn().mockResolvedValue(RECORDED.createRelation),
    getProjectIssues: vi.fn(),
    getTeamLabels: vi.fn().mockResolvedValue([]),
    updateIssue: vi.fn().mockResolvedValue(true),
    updateIssueExtended: vi.fn().mockResolvedValue(true),
    getViewerId: vi.fn().mockResolvedValue("viewer-1"),
    createComment: vi.fn().mockResolvedValue("comment-id"),
    emitActivity: vi.fn().mockResolvedValue(undefined),
    updateSession: vi.fn().mockResolvedValue(undefined),
    getProject: vi.fn().mockResolvedValue({
      id: "proj-1",
      name: "Test",
      description: "",
      state: "started",
      teams: {
        nodes: [
          {
            id: RECORDED.parentDetails.team.id,
            name: RECORDED.parentDetails.team.name,
          },
        ],
      },
    }),
  };

  // Wire up getIssueDetails to return recorded response by ID
  api.getIssueDetails.mockImplementation((id: string) => {
    if (id === RECORDED.createParent.id)
      return Promise.resolve(RECORDED.parentDetails);
    if (id === RECORDED.createSubIssue1.id)
      return Promise.resolve(RECORDED.subIssue1WithRelation);
    if (id === RECORDED.createSubIssue2.id)
      return Promise.resolve(RECORDED.subIssue2WithRelation);
    throw new Error(`Unexpected issue ID in replay: ${id}`);
  });

  return api;
}

/** Build a ProjectIssue from recorded detail shapes. */
function recordedToProjectIssue(
  detail: typeof RECORDED.parentDetails,
  overrides?: Partial<ProjectIssue>,
): ProjectIssue {
  return {
    id: detail.id,
    identifier: detail.identifier,
    title: detail.title,
    description: detail.description,
    estimate: detail.estimate,
    priority: 0,
    state: detail.state,
    parent: detail.parent,
    labels: detail.labels,
    relations: detail.relations,
    ...overrides,
  } as ProjectIssue;
}

// ===========================================================================
// Group A: Direct API hierarchy (mock createIssue / getIssueDetails)
// ===========================================================================

describe("sub-issue decomposition (recorded replay)", () => {
  describe("parent-child hierarchy via direct API", () => {
    it("createIssue with parentId creates a sub-issue", async () => {
      const api = createReplayApi();
      api.createIssue.mockResolvedValueOnce(RECORDED.createSubIssue1);

      const result = await api.createIssue({
        teamId: RECORDED.parentDetails.team.id,
        title: RECORDED.subIssue1Details.title,
        parentId: RECORDED.createParent.id,
        estimate: 2,
        priority: 3,
      });

      expect(result.id).toBe(RECORDED.createSubIssue1.id);
      expect(result.identifier).toBe(RECORDED.createSubIssue1.identifier);
      expect(api.createIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          parentId: RECORDED.createParent.id,
        }),
      );
    });

    it("getIssueDetails of sub-issue returns parent reference", async () => {
      const api = createReplayApi();
      const details = await api.getIssueDetails(
        RECORDED.createSubIssue1.id,
      );

      expect(details.parent).not.toBeNull();
      expect(details.parent!.id).toBe(RECORDED.createParent.id);
      expect(details.parent!.identifier).toBe(
        RECORDED.createParent.identifier,
      );
    });

    it("getIssueDetails of parent returns null parent (root)", async () => {
      const api = createReplayApi();
      const details = await api.getIssueDetails(RECORDED.createParent.id);

      expect(details.parent).toBeNull();
    });

    it("createIssueRelation creates blocks dependency", async () => {
      const api = createReplayApi();
      const result = await api.createIssueRelation({
        issueId: RECORDED.createSubIssue1.id,
        relatedIssueId: RECORDED.createSubIssue2.id,
        type: "blocks",
      });

      expect(result.id).toBe(RECORDED.createRelation.id);
      expect(api.createIssueRelation).toHaveBeenCalledWith({
        issueId: RECORDED.createSubIssue1.id,
        relatedIssueId: RECORDED.createSubIssue2.id,
        type: "blocks",
      });
    });

    it("sub-issue details include blocks relation after linking", async () => {
      const api = createReplayApi();
      const details = await api.getIssueDetails(
        RECORDED.createSubIssue1.id,
      );

      const blocksRels = details.relations.nodes.filter(
        (r: any) => r.type === "blocks",
      );
      expect(blocksRels.length).toBeGreaterThan(0);
      expect(
        blocksRels.some(
          (r: any) => r.relatedIssue.id === RECORDED.createSubIssue2.id,
        ),
      ).toBe(true);
    });
  });

  // =========================================================================
  // Group B: Planner tools (real tool code, mocked API)
  // =========================================================================

  describe("planner tools: parentIdentifier resolution", () => {
    let tools: any[];
    let mockApi: ReturnType<typeof createReplayApi>;

    beforeEach(() => {
      vi.clearAllMocks();
      mockApi = createReplayApi();
      setActivePlannerContext({
        linearApi: mockApi as any,
        projectId: "proj-1",
        teamId: RECORDED.parentDetails.team.id,
        api: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as any,
      });
      tools = createPlannerTools();
    });

    afterEach(() => {
      clearActivePlannerContext();
    });

    function findTool(name: string) {
      const tool = tools.find((t: any) => t.name === name) as any;
      if (!tool) throw new Error(`Tool '${name}' not found`);
      return tool;
    }

    it("plan_create_issue resolves parentIdentifier to parentId", async () => {
      // Mock getProjectIssues to return the parent issue
      mockApi.getProjectIssues.mockResolvedValueOnce([
        recordedToProjectIssue(RECORDED.parentDetails),
      ]);
      mockApi.createIssue.mockResolvedValueOnce(RECORDED.createSubIssue1);

      const tool = findTool("plan_create_issue");
      const result = await tool.execute("call-1", {
        title: RECORDED.subIssue1Details.title,
        description: RECORDED.subIssue1Details.description,
        parentIdentifier: RECORDED.createParent.identifier,
        estimate: 2,
        priority: 3,
      });

      // Verify createIssue was called with resolved parentId (not identifier)
      expect(mockApi.createIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          parentId: RECORDED.createParent.id,
        }),
      );
      expect(result.details.identifier).toBe(
        RECORDED.createSubIssue1.identifier,
      );
    });

    it("plan_link_issues creates blocks relation between resolved IDs", async () => {
      // Mock getProjectIssues to return both sub-issues
      mockApi.getProjectIssues.mockResolvedValueOnce([
        recordedToProjectIssue(RECORDED.subIssue1WithRelation),
        recordedToProjectIssue(RECORDED.subIssue2WithRelation),
      ]);

      const tool = findTool("plan_link_issues");
      const result = await tool.execute("call-2", {
        fromIdentifier: RECORDED.subIssue1WithRelation.identifier,
        toIdentifier: RECORDED.subIssue2WithRelation.identifier,
        type: "blocks",
      });

      expect(mockApi.createIssueRelation).toHaveBeenCalledWith({
        issueId: RECORDED.subIssue1WithRelation.id,
        relatedIssueId: RECORDED.subIssue2WithRelation.id,
        type: "blocks",
      });
      expect(result.details.id).toBe(RECORDED.createRelation.id);
      expect(result.details.type).toBe("blocks");
    });

    it("plan_get_project shows hierarchy with parent-child nesting", async () => {
      // Return all 3 issues (parent + 2 subs)
      mockApi.getProjectIssues.mockResolvedValueOnce([
        recordedToProjectIssue(RECORDED.parentDetails),
        recordedToProjectIssue(RECORDED.subIssue1WithRelation),
        recordedToProjectIssue(RECORDED.subIssue2WithRelation),
      ]);

      const tool = findTool("plan_get_project");
      const result = await tool.execute("call-3", {});
      const snapshot = result.data?.snapshot ?? result.data?.plan ?? "";

      // All three identifiers should appear
      expect(snapshot).toContain(RECORDED.createParent.identifier);
      expect(snapshot).toContain(RECORDED.createSubIssue1.identifier);
      expect(snapshot).toContain(RECORDED.createSubIssue2.identifier);
    });

    it("plan_audit passes valid sub-issue hierarchy", async () => {
      // Build issues that pass audit: descriptions >= 50 chars, estimate, priority set
      const parent = recordedToProjectIssue(RECORDED.parentDetails, {
        priority: 2,
        estimate: 5,
      });
      const sub1 = recordedToProjectIssue(RECORDED.subIssue1WithRelation, {
        priority: 3,
        estimate: 2,
      });
      const sub2 = recordedToProjectIssue(RECORDED.subIssue2WithRelation, {
        priority: 3,
        estimate: 3,
      });

      mockApi.getProjectIssues.mockResolvedValueOnce([parent, sub1, sub2]);

      const tool = findTool("plan_audit");
      const result = await tool.execute("call-4", {});

      expect(result.details.pass).toBe(true);
      expect(result.details.problems).toHaveLength(0);
    });
  });

  // =========================================================================
  // Group C: auditPlan pure function with recorded data shapes
  // =========================================================================

  describe("auditPlan with parent-child relationships", () => {
    it("issues with parent are not flagged as orphans", () => {
      const parent = recordedToProjectIssue(RECORDED.parentDetails, {
        priority: 2,
        estimate: 5,
      });
      const sub1 = recordedToProjectIssue(RECORDED.subIssue1Details, {
        priority: 3,
        estimate: 2,
      });
      const sub2 = recordedToProjectIssue(RECORDED.subIssue2Details, {
        priority: 3,
        estimate: 3,
      });

      const result = auditPlan([parent, sub1, sub2]);

      // Sub-issues have parent set, so they're not orphans.
      // Parent may be flagged as orphan (no parent, no relations linking to it)
      // but sub-issues definitely should NOT be orphans.
      const orphanWarnings = result.warnings.filter((w) =>
        w.includes("orphan"),
      );
      const subOrphans = orphanWarnings.filter(
        (w) =>
          w.includes(RECORDED.subIssue1Details.identifier) ||
          w.includes(RECORDED.subIssue2Details.identifier),
      );
      expect(subOrphans).toHaveLength(0);
    });

    it("blocks relation between sub-issues produces valid DAG", () => {
      const sub1 = recordedToProjectIssue(RECORDED.subIssue1WithRelation, {
        priority: 3,
        estimate: 2,
      });
      const sub2 = recordedToProjectIssue(RECORDED.subIssue2WithRelation, {
        priority: 3,
        estimate: 3,
      });

      const cycles = detectCycles([sub1, sub2]);
      expect(cycles).toHaveLength(0);
    });

    it("buildPlanSnapshot nests sub-issues under parent", () => {
      const parent = recordedToProjectIssue(RECORDED.parentDetails, {
        priority: 2,
        estimate: 5,
      });
      const sub1 = recordedToProjectIssue(RECORDED.subIssue1WithRelation, {
        priority: 3,
        estimate: 2,
      });
      const sub2 = recordedToProjectIssue(RECORDED.subIssue2WithRelation, {
        priority: 3,
        estimate: 3,
      });

      const snapshot = buildPlanSnapshot([parent, sub1, sub2]);

      // Parent should appear
      expect(snapshot).toContain(RECORDED.createParent.identifier);
      // Sub-issues should appear
      expect(snapshot).toContain(RECORDED.createSubIssue1.identifier);
      expect(snapshot).toContain(RECORDED.createSubIssue2.identifier);
      // Sub-issues should be indented (nested under parent)
      const lines = snapshot.split("\n");
      const sub1Line = lines.find((l) =>
        l.includes(RECORDED.createSubIssue1.identifier),
      );
      expect(sub1Line).toBeTruthy();
      expect(sub1Line!.startsWith("  ")).toBe(true);
    });
  });
});
