import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock openclaw/plugin-sdk
vi.mock("openclaw/plugin-sdk/core", () => ({
  jsonResult: (data: any) => ({ type: "json", data, content: [{ type: "text", text: JSON.stringify(data) }], details: data }),
}));

// Mock LinearAgentApi
vi.mock("../api/linear-api.js", () => ({
  LinearAgentApi: vi.fn(),
}));

import {
  createPlannerTools,
  setActivePlannerContext,
  clearActivePlannerContext,
  detectCycles,
  auditPlan,
  buildPlanSnapshot,
} from "./planner-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ProjectIssue = Parameters<typeof detectCycles>[0][number];

function makeIssue(overrides: Partial<ProjectIssue> & { identifier: string; title: string }): ProjectIssue {
  return {
    id: overrides.id ?? overrides.identifier.toLowerCase().replace("-", "_"),
    identifier: overrides.identifier,
    title: overrides.title,
    description: "description" in overrides ? overrides.description : "As a user, I want this feature so that I can be productive. Given I am logged in, When I click the button, Then the action completes.",
    estimate: "estimate" in overrides ? overrides.estimate : 3,
    priority: "priority" in overrides ? overrides.priority : 2,
    labels: overrides.labels ?? { nodes: [] },
    parent: overrides.parent ?? null,
    relations: overrides.relations ?? { nodes: [] },
  } as ProjectIssue;
}

function makeEpicIssue(overrides: Partial<ProjectIssue> & { identifier: string; title: string }): ProjectIssue {
  return makeIssue({
    ...overrides,
    labels: { nodes: [{ id: "lbl-epic", name: "Epic" }] } as any,
    estimate: overrides.estimate as any,
    priority: overrides.priority as any,
  });
}

// ---------------------------------------------------------------------------
// Mock Linear API
// ---------------------------------------------------------------------------

const mockLinearApi = {
  createIssue: vi.fn().mockResolvedValue({ id: "new-id", identifier: "PROJ-5" }),
  createIssueRelation: vi.fn().mockResolvedValue({ id: "rel-id" }),
  getProjectIssues: vi.fn().mockResolvedValue([]),
  getTeamLabels: vi.fn().mockResolvedValue([]),
  updateIssueExtended: vi.fn().mockResolvedValue(true),
};

// ---------------------------------------------------------------------------
// detectCycles (pure function — no mocks needed)
// ---------------------------------------------------------------------------

describe("detectCycles", () => {
  it("returns empty array for valid linear chain (A→B→C)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "A",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-2" } }],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-2",
        title: "B",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-3" } }],
        } as any,
      }),
      makeIssue({ identifier: "PROJ-3", title: "C" }),
    ];

    expect(detectCycles(issues)).toEqual([]);
  });

  it("detects simple 2-node cycle (A→B→A)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "A",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-2" } }],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-2",
        title: "B",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-1" } }],
        } as any,
      }),
    ];

    const cycleNodes = detectCycles(issues);
    expect(cycleNodes).toContain("PROJ-1");
    expect(cycleNodes).toContain("PROJ-2");
  });

  it("detects 3-node cycle (A→B→C→A)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "A",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-2" } }],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-2",
        title: "B",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-3" } }],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-3",
        title: "C",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-1" } }],
        } as any,
      }),
    ];

    const cycleNodes = detectCycles(issues);
    expect(cycleNodes).toHaveLength(3);
    expect(cycleNodes).toContain("PROJ-1");
    expect(cycleNodes).toContain("PROJ-2");
    expect(cycleNodes).toContain("PROJ-3");
  });

  it("passes valid diamond DAG (A→B, A→C, B→D, C→D)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "A",
        relations: {
          nodes: [
            { type: "blocks", relatedIssue: { identifier: "PROJ-2" } },
            { type: "blocks", relatedIssue: { identifier: "PROJ-3" } },
          ],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-2",
        title: "B",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-4" } }],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-3",
        title: "C",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-4" } }],
        } as any,
      }),
      makeIssue({ identifier: "PROJ-4", title: "D" }),
    ];

    expect(detectCycles(issues)).toEqual([]);
  });

  it("returns empty for issues with no relations", () => {
    const issues: ProjectIssue[] = [
      makeIssue({ identifier: "PROJ-1", title: "A" }),
      makeIssue({ identifier: "PROJ-2", title: "B" }),
      makeIssue({ identifier: "PROJ-3", title: "C" }),
    ];

    expect(detectCycles(issues)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// auditPlan (pure function)
// ---------------------------------------------------------------------------

describe("auditPlan", () => {
  it("passes valid plan with descriptions, estimates, priorities", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "Task A",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-2" } }],
        } as any,
      }),
      makeIssue({ identifier: "PROJ-2", title: "Task B", parent: { identifier: "PROJ-1" } as any }),
    ];

    const result = auditPlan(issues);
    expect(result.pass).toBe(true);
    expect(result.problems).toHaveLength(0);
  });

  it("fails: issue missing description", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "No desc",
        description: "" as any,
      }),
    ];

    const result = auditPlan(issues);
    expect(result.pass).toBe(false);
    expect(result.problems.some((p) => p.includes("PROJ-1") && p.includes("description"))).toBe(true);
  });

  it("fails: description too short (<50 chars)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "Short desc",
        description: "Too short",
      }),
    ];

    const result = auditPlan(issues);
    expect(result.pass).toBe(false);
    expect(result.problems.some((p) => p.includes("PROJ-1") && p.includes("description"))).toBe(true);
  });

  it("fails: non-epic missing estimate", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "No estimate",
        estimate: null as any,
      }),
    ];

    const result = auditPlan(issues);
    expect(result.pass).toBe(false);
    expect(result.problems.some((p) => p.includes("PROJ-1") && p.includes("estimate"))).toBe(true);
  });

  it("fails: non-epic missing priority (priority=0)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "No priority",
        priority: 0,
      }),
    ];

    const result = auditPlan(issues);
    expect(result.pass).toBe(false);
    expect(result.problems.some((p) => p.includes("PROJ-1") && p.includes("priority"))).toBe(true);
  });

  it("fails: cycle detected", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "A",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-2" } }],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-2",
        title: "B",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-1" } }],
        } as any,
      }),
    ];

    const result = auditPlan(issues);
    expect(result.pass).toBe(false);
    expect(result.problems.some((p) => p.includes("cycle") || p.includes("Cycle"))).toBe(true);
  });

  it("warns: orphan issue (no parent or relations)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({ identifier: "PROJ-1", title: "Lonely issue" }),
    ];

    const result = auditPlan(issues);
    expect(result.warnings.some((w) => w.includes("PROJ-1") && w.includes("orphan"))).toBe(true);
  });

  it("skips estimate/priority checks for epic issues", () => {
    const issues: ProjectIssue[] = [
      makeEpicIssue({
        identifier: "PROJ-1",
        title: "Epic without estimate/priority",
        estimate: null as any,
        priority: 0 as any,
      }),
    ];

    const result = auditPlan(issues);
    const estimateProblems = result.problems.filter((p) => p.includes("estimate") || p.includes("priority"));
    expect(estimateProblems).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildPlanSnapshot
// ---------------------------------------------------------------------------

describe("buildPlanSnapshot", () => {
  it("formats empty project", () => {
    const result = buildPlanSnapshot([]);
    expect(result).toBe("_No issues created yet._");
  });

  it("formats tree with epics + sub-issues + relations", () => {
    const epic = makeEpicIssue({
      identifier: "PROJ-1",
      title: "Auth Epic",
      estimate: null as any,
      priority: 2,
    });

    const child = makeIssue({
      identifier: "PROJ-2",
      title: "Login page",
      parent: { identifier: "PROJ-1" } as any,
      estimate: 3,
      priority: 3,
      relations: {
        nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-3" } }],
      } as any,
    });

    const standalone = makeIssue({
      identifier: "PROJ-3",
      title: "Dashboard",
      estimate: 5,
      priority: 1,
    });

    const result = buildPlanSnapshot([epic, child, standalone]);

    // Should contain epic section
    expect(result).toContain("### Epics (1)");
    expect(result).toContain("PROJ-1");
    expect(result).toContain("Auth Epic");

    // Child should appear indented under epic
    expect(result).toContain("PROJ-2");
    expect(result).toContain("Login page");

    // Standalone section
    expect(result).toContain("### Standalone issues (1)");
    expect(result).toContain("PROJ-3");
    expect(result).toContain("Dashboard");

    // Relations formatting
    expect(result).toContain("blocks PROJ-3");

    // Priority labels
    expect(result).toContain("pri: Urgent");
    expect(result).toContain("pri: Medium");
  });
});

// ---------------------------------------------------------------------------
// Tool execution tests
// ---------------------------------------------------------------------------

describe("createPlannerTools", () => {
  const PROJECT_ID = "proj-123";
  const TEAM_ID = "team-456";

  let tools: ReturnType<typeof createPlannerTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    setActivePlannerContext({
      linearApi: mockLinearApi as any,
      projectId: PROJECT_ID,
      teamId: TEAM_ID,
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

  // ---- plan_create_issue ----

  it("plan_create_issue: creates issue with teamId and projectId", async () => {
    const tool = findTool("plan_create_issue");

    const result = await tool.execute("call-1", {
      title: "New feature",
      description: "Implement the new feature with all necessary components",
    });

    expect(mockLinearApi.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        title: "New feature",
        description: "Implement the new feature with all necessary components",
      }),
    );

    expect(result).toMatchObject({
      type: "json",
      data: {
        id: "new-id",
        identifier: "PROJ-5",
        title: "New feature",
        isEpic: false,
      },
    });
  });

  // ---- plan_link_issues ----

  it("plan_link_issues: creates blocks relation", async () => {
    mockLinearApi.getProjectIssues.mockResolvedValueOnce([
      makeIssue({ identifier: "PROJ-1", title: "A", id: "id-1" }),
      makeIssue({ identifier: "PROJ-2", title: "B", id: "id-2" }),
    ]);

    const tool = findTool("plan_link_issues");

    const result = await tool.execute("call-2", {
      fromIdentifier: "PROJ-1",
      toIdentifier: "PROJ-2",
      type: "blocks",
    });

    expect(mockLinearApi.createIssueRelation).toHaveBeenCalledWith({
      issueId: "id-1",
      relatedIssueId: "id-2",
      type: "blocks",
    });

    expect(result).toMatchObject({
      type: "json",
      data: {
        id: "rel-id",
        from: "PROJ-1",
        to: "PROJ-2",
        type: "blocks",
      },
    });
  });

  it("plan_link_issues: throws on unknown identifier", async () => {
    mockLinearApi.getProjectIssues.mockResolvedValueOnce([
      makeIssue({ identifier: "PROJ-1", title: "A", id: "id-1" }),
    ]);

    const tool = findTool("plan_link_issues");

    await expect(
      tool.execute("call-3", {
        fromIdentifier: "PROJ-1",
        toIdentifier: "PROJ-999",
        type: "blocks",
      }),
    ).rejects.toThrow("Unknown issue identifier: PROJ-999");
  });

  // ---- plan_get_project ----

  it("plan_get_project: returns formatted snapshot", async () => {
    mockLinearApi.getProjectIssues.mockResolvedValueOnce([
      makeIssue({ identifier: "PROJ-1", title: "Task A" }),
    ]);

    const tool = findTool("plan_get_project");
    const result = await tool.execute("call-4", {});

    expect(mockLinearApi.getProjectIssues).toHaveBeenCalledWith(PROJECT_ID);
    expect(result).toMatchObject({
      type: "json",
      data: {
        issueCount: 1,
        plan: expect.stringContaining("PROJ-1"),
      },
    });
  });

  // ---- plan_audit ----

  it("plan_audit: returns audit result", async () => {
    mockLinearApi.getProjectIssues.mockResolvedValueOnce([
      makeIssue({
        identifier: "PROJ-1",
        title: "Good issue",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-2" } }],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-2",
        title: "Another good issue",
        parent: { identifier: "PROJ-1" } as any,
      }),
    ]);

    const tool = findTool("plan_audit");
    const result = await tool.execute("call-5", {});

    expect(mockLinearApi.getProjectIssues).toHaveBeenCalledWith(PROJECT_ID);
    expect(result).toMatchObject({
      type: "json",
      data: {
        pass: true,
        problems: [],
        warnings: [],
      },
    });
  });

  // ---- plan_create_issue: additional branch tests ----

  it("plan_create_issue: includes priority and estimate when provided", async () => {
    const tool = findTool("plan_create_issue");

    await tool.execute("call-6", {
      title: "Estimated task",
      description: "Full description here",
      priority: 2,
      estimate: 5,
    });

    expect(mockLinearApi.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: 2,
        estimate: 5,
      }),
    );
  });

  it("plan_create_issue: resolves parentIdentifier to parentId", async () => {
    mockLinearApi.getProjectIssues.mockResolvedValueOnce([
      makeIssue({ identifier: "PROJ-1", title: "Parent", id: "parent-id" }),
    ]);

    const tool = findTool("plan_create_issue");

    await tool.execute("call-7", {
      title: "Child task",
      description: "A child issue under parent",
      parentIdentifier: "PROJ-1",
    });

    expect(mockLinearApi.getProjectIssues).toHaveBeenCalledWith(PROJECT_ID);
    expect(mockLinearApi.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: "parent-id",
      }),
    );
  });

  it("plan_create_issue: adds Epic label when isEpic=true and label exists", async () => {
    mockLinearApi.getTeamLabels.mockResolvedValueOnce([
      { id: "label-epic", name: "epic" },
    ]);

    const tool = findTool("plan_create_issue");

    await tool.execute("call-8", {
      title: "Feature epic",
      description: "An epic issue for the project",
      isEpic: true,
    });

    expect(mockLinearApi.getTeamLabels).toHaveBeenCalledWith(TEAM_ID);
    expect(mockLinearApi.updateIssueExtended).toHaveBeenCalledWith("new-id", { labelIds: ["label-epic"] });
  });

  it("plan_create_issue: isEpic=true but no Epic label on team — no crash", async () => {
    mockLinearApi.getTeamLabels.mockResolvedValueOnce([
      { id: "label-bug", name: "bug" },
    ]);

    const tool = findTool("plan_create_issue");

    const result = await tool.execute("call-9", {
      title: "Epic without label",
      description: "Epic but team has no epic label",
      isEpic: true,
    });

    expect(mockLinearApi.getTeamLabels).toHaveBeenCalledWith(TEAM_ID);
    expect(mockLinearApi.updateIssueExtended).not.toHaveBeenCalled();
    expect(result.details.isEpic).toBe(true);
  });

  it("plan_create_issue: isEpic=true handles error when labeling fails", async () => {
    mockLinearApi.getTeamLabels.mockRejectedValueOnce(new Error("API error"));

    const tool = findTool("plan_create_issue");

    const result = await tool.execute("call-10", {
      title: "Epic with error",
      description: "Epic label fetch fails",
      isEpic: true,
    });

    // Should not throw — best-effort labeling
    expect(result.details.isEpic).toBe(true);
  });

  it("plan_create_issue: estimate=0 is passed (falsy but valid)", async () => {
    const tool = findTool("plan_create_issue");

    await tool.execute("call-11", {
      title: "Zero estimate",
      description: "Issue with zero estimate",
      estimate: 0,
    });

    expect(mockLinearApi.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        estimate: 0,
      }),
    );
  });

  // ---- plan_update_issue ----

  it("plan_update_issue: updates description, estimate, priority, and labelIds", async () => {
    mockLinearApi.getProjectIssues.mockResolvedValueOnce([
      makeIssue({ identifier: "PROJ-1", title: "Existing", id: "id-1" }),
    ]);

    const tool = findTool("plan_update_issue");

    const result = await tool.execute("call-12", {
      identifier: "PROJ-1",
      description: "Updated description text",
      estimate: 8,
      priority: 1,
      labelIds: ["label-1", "label-2"],
    });

    expect(mockLinearApi.updateIssueExtended).toHaveBeenCalledWith("id-1", {
      description: "Updated description text",
      estimate: 8,
      priority: 1,
      labelIds: ["label-1", "label-2"],
    });
    expect(result.details.updated).toBe(true);
  });

  it("plan_update_issue: only sends provided fields", async () => {
    mockLinearApi.getProjectIssues.mockResolvedValueOnce([
      makeIssue({ identifier: "PROJ-1", title: "Existing", id: "id-1" }),
    ]);

    const tool = findTool("plan_update_issue");

    await tool.execute("call-13", {
      identifier: "PROJ-1",
      estimate: 3,
    });

    expect(mockLinearApi.updateIssueExtended).toHaveBeenCalledWith("id-1", {
      estimate: 3,
    });
  });

  it("plan_update_issue: throws on unknown identifier", async () => {
    mockLinearApi.getProjectIssues.mockResolvedValueOnce([
      makeIssue({ identifier: "PROJ-1", title: "Only", id: "id-1" }),
    ]);

    const tool = findTool("plan_update_issue");

    await expect(
      tool.execute("call-14", { identifier: "PROJ-999" }),
    ).rejects.toThrow("Unknown issue identifier: PROJ-999");
  });
});

// ---------------------------------------------------------------------------
// requireContext: throws when no planner context set
// ---------------------------------------------------------------------------

describe("createPlannerTools — no context", () => {
  it("throws when tools are used without active planner context", async () => {
    clearActivePlannerContext();
    const tools = createPlannerTools();
    const tool = tools.find((t: any) => t.name === "plan_get_project") as any;

    await expect(tool.execute("call-no-ctx", {})).rejects.toThrow(
      "No active planning session",
    );
  });
});

// ---------------------------------------------------------------------------
// detectCycles — additional branch coverage
// ---------------------------------------------------------------------------

describe("detectCycles — additional branches", () => {
  it("handles blocked_by relation type", () => {
    const issues: ProjectIssue[] = [
      makeIssue({ identifier: "PROJ-1", title: "A" }),
      makeIssue({
        identifier: "PROJ-2",
        title: "B",
        relations: {
          nodes: [{ type: "blocked_by", relatedIssue: { identifier: "PROJ-1" } }],
        } as any,
      }),
    ];

    // Valid DAG — no cycle
    expect(detectCycles(issues)).toEqual([]);
  });

  it("ignores relations with null target identifier", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "A",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: null } }],
        } as any,
      }),
    ];

    expect(detectCycles(issues)).toEqual([]);
  });

  it("ignores relations with missing relatedIssue", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "A",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: null }],
        } as any,
      }),
    ];

    expect(detectCycles(issues)).toEqual([]);
  });

  it("ignores relations to identifiers not in the issue set", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "A",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "OTHER-99" } }],
        } as any,
      }),
    ];

    expect(detectCycles(issues)).toEqual([]);
  });

  it("handles issues with null/undefined relations", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "A",
        relations: null as any,
      }),
      makeIssue({
        identifier: "PROJ-2",
        title: "B",
        relations: undefined as any,
      }),
    ];

    expect(detectCycles(issues)).toEqual([]);
  });

  it("detects cycle via blocked_by relations", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "A",
        relations: {
          nodes: [{ type: "blocked_by", relatedIssue: { identifier: "PROJ-2" } }],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-2",
        title: "B",
        relations: {
          nodes: [{ type: "blocked_by", relatedIssue: { identifier: "PROJ-1" } }],
        } as any,
      }),
    ];

    const cycleNodes = detectCycles(issues);
    expect(cycleNodes).toContain("PROJ-1");
    expect(cycleNodes).toContain("PROJ-2");
  });

  it("ignores non-blocks/non-blocked_by relation types", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "A",
        relations: {
          nodes: [{ type: "related", relatedIssue: { identifier: "PROJ-2" } }],
        } as any,
      }),
      makeIssue({ identifier: "PROJ-2", title: "B" }),
    ];

    // "related" is not a dependency — no cycle
    expect(detectCycles(issues)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// auditPlan — additional branch coverage
// ---------------------------------------------------------------------------

describe("auditPlan — additional branches", () => {
  it("fails: null description", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "Null desc",
        description: null as any,
      }),
    ];

    const result = auditPlan(issues);
    expect(result.pass).toBe(false);
    expect(result.problems.some((p) => p.includes("PROJ-1") && p.includes("description"))).toBe(true);
  });

  it("fails: non-epic with null priority", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "Null priority",
        priority: null as any,
      }),
    ];

    const result = auditPlan(issues);
    expect(result.pass).toBe(false);
    expect(result.problems.some((p) => p.includes("PROJ-1") && p.includes("priority"))).toBe(true);
  });

  it("no acceptance criteria warning when description contains AC markers", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "Good AC",
        description: "As a user, I want to test this feature. Given a prerequisite, When I do something, Then I expect results.",
      }),
    ];

    const result = auditPlan(issues);
    const acWarnings = result.warnings.filter((w) => w.includes("acceptance criteria"));
    expect(acWarnings).toHaveLength(0);
  });

  it("warns: no acceptance criteria when description lacks AC markers", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "No AC",
        description: "This is a long description that has enough characters but none of the required markers or keywords whatsoever at all.",
      }),
    ];

    const result = auditPlan(issues);
    expect(result.warnings.some((w) => w.includes("PROJ-1") && w.includes("acceptance criteria"))).toBe(true);
  });

  it("does not warn about acceptance criteria for epic issues", () => {
    const issues: ProjectIssue[] = [
      makeEpicIssue({
        identifier: "PROJ-1",
        title: "Epic no AC",
        description: "This is a long epic description that has enough characters but no acceptance criteria at all whatsoever.",
      }),
    ];

    const result = auditPlan(issues);
    const acWarnings = result.warnings.filter((w) => w.includes("acceptance criteria"));
    expect(acWarnings).toHaveLength(0);
  });

  it("does not warn about acceptance criteria when description is null (already a problem)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "No desc at all",
        description: null as any,
      }),
    ];

    const result = auditPlan(issues);
    // Should have description problem but NOT an AC warning
    expect(result.problems.some((p) => p.includes("description"))).toBe(true);
    const acWarnings = result.warnings.filter((w) => w.includes("acceptance criteria") && w.includes("PROJ-1"));
    expect(acWarnings).toHaveLength(0);
  });

  it("no orphan warning for issue with parent", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "Parent",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-2" } }],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-2",
        title: "Child with parent",
        parent: { identifier: "PROJ-1" } as any,
      }),
    ];

    const result = auditPlan(issues);
    const orphanWarnings = result.warnings.filter((w) => w.includes("orphan"));
    expect(orphanWarnings).toHaveLength(0);
  });

  it("no orphan warning for issue involved in relations (even without parent)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "Has relation",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: "PROJ-2" } }],
        } as any,
      }),
      makeIssue({
        identifier: "PROJ-2",
        title: "Related to PROJ-1",
      }),
    ];

    const result = auditPlan(issues);
    const orphanWarnings = result.warnings.filter((w) => w.includes("orphan"));
    expect(orphanWarnings).toHaveLength(0);
  });

  it("handles issues with null labels (not epic)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "No labels",
        labels: null as any,
      }),
    ];

    const result = auditPlan(issues);
    // Should be treated as non-epic — no crash
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// buildPlanSnapshot — additional branch coverage
// ---------------------------------------------------------------------------

describe("buildPlanSnapshot — additional branches", () => {
  it("formats priority label: Low (4)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({ identifier: "PROJ-1", title: "Low pri", priority: 4 }),
    ];
    const result = buildPlanSnapshot(issues);
    expect(result).toContain("pri: Low");
  });

  it("formats priority label: None (5 or unrecognized)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({ identifier: "PROJ-1", title: "No pri", priority: 5 }),
    ];
    const result = buildPlanSnapshot(issues);
    expect(result).toContain("pri: None");
  });

  it("formats priority label: None (0)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({ identifier: "PROJ-1", title: "Zero pri", priority: 0 }),
    ];
    const result = buildPlanSnapshot(issues);
    expect(result).toContain("pri: None");
  });

  it("formats estimate as dash when null", () => {
    const issues: ProjectIssue[] = [
      makeIssue({ identifier: "PROJ-1", title: "No est", estimate: null as any }),
    ];
    const result = buildPlanSnapshot(issues);
    expect(result).toContain("est: -");
  });

  it("formats only standalone section when no epics", () => {
    const issues: ProjectIssue[] = [
      makeIssue({ identifier: "PROJ-1", title: "Task A" }),
      makeIssue({ identifier: "PROJ-2", title: "Task B" }),
    ];
    const result = buildPlanSnapshot(issues);
    expect(result).toContain("### Standalone issues (2)");
    expect(result).not.toContain("### Epics");
  });

  it("formats only epics section when no standalone issues", () => {
    const epic = makeEpicIssue({
      identifier: "PROJ-1",
      title: "Only Epic",
      priority: 2,
    });
    const child = makeIssue({
      identifier: "PROJ-2",
      title: "Under epic",
      parent: { identifier: "PROJ-1" } as any,
    });
    const result = buildPlanSnapshot([epic, child]);
    expect(result).toContain("### Epics (1)");
    expect(result).not.toContain("### Standalone issues");
  });

  it("formats issue with no relations as empty relation string", () => {
    const issues: ProjectIssue[] = [
      makeIssue({ identifier: "PROJ-1", title: "No rels", relations: { nodes: [] } as any }),
    ];
    const result = buildPlanSnapshot(issues);
    // Should not have any "→" relation markers
    expect(result).not.toContain("→");
  });

  it("formats multiple relations on a single issue", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "Multi-rel",
        relations: {
          nodes: [
            { type: "blocks", relatedIssue: { identifier: "PROJ-2" } },
            { type: "related", relatedIssue: { identifier: "PROJ-3" } },
          ],
        } as any,
      }),
      makeIssue({ identifier: "PROJ-2", title: "B" }),
      makeIssue({ identifier: "PROJ-3", title: "C" }),
    ];
    const result = buildPlanSnapshot(issues);
    expect(result).toContain("blocks PROJ-2");
    expect(result).toContain("related PROJ-3");
  });

  it("formats nested children (grandchildren)", () => {
    const epic = makeEpicIssue({
      identifier: "PROJ-1",
      title: "Epic",
      priority: 2,
    });
    const child = makeIssue({
      identifier: "PROJ-2",
      title: "Child",
      parent: { identifier: "PROJ-1" } as any,
    });
    const grandchild = makeIssue({
      identifier: "PROJ-3",
      title: "Grandchild",
      parent: { identifier: "PROJ-2" } as any,
    });
    const result = buildPlanSnapshot([epic, child, grandchild]);
    // Grandchild should be double-indented
    expect(result).toContain("PROJ-3");
  });

  it("handles issues with null relations in snapshot (formatRelations null guard)", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "Null rels",
        relations: null as any,
      }),
    ];
    const result = buildPlanSnapshot(issues);
    expect(result).toContain("PROJ-1");
    expect(result).not.toContain("→");
  });

  it("handles issues with undefined relations.nodes in snapshot", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "Undef nodes",
        relations: {} as any,
      }),
    ];
    const result = buildPlanSnapshot(issues);
    expect(result).toContain("PROJ-1");
    expect(result).not.toContain("→");
  });
});

// ---------------------------------------------------------------------------
// auditPlan — orphan check with relation having null relatedIssue
// ---------------------------------------------------------------------------

describe("auditPlan — orphan relation edge cases", () => {
  it("relation with null relatedIssue.identifier does not count as having-relation", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "Has broken relation",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: { identifier: null } }],
        } as any,
      }),
    ];

    const result = auditPlan(issues);
    // PROJ-1 has a relation node, so hasRelation.add(issue.identifier) fires,
    // but rel.relatedIssue?.identifier is null so the second add doesn't fire.
    // PROJ-1 still counts as having a relation (from the first add).
    const orphanWarnings = result.warnings.filter((w) => w.includes("orphan"));
    expect(orphanWarnings).toHaveLength(0);
  });

  it("relation with null relatedIssue skips identifier add", () => {
    const issues: ProjectIssue[] = [
      makeIssue({
        identifier: "PROJ-1",
        title: "Broken rel",
        relations: {
          nodes: [{ type: "blocks", relatedIssue: null }],
        } as any,
      }),
    ];

    const result = auditPlan(issues);
    // PROJ-1 still gets added to hasRelation set from the outer loop
    const orphanWarnings = result.warnings.filter((w) => w.includes("orphan"));
    expect(orphanWarnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createPlannerTools — plan_update_issue: exercise all optional param branches
// ---------------------------------------------------------------------------

describe("createPlannerTools — plan_update_issue branch coverage", () => {
  const PROJECT_ID = "proj-123";
  const TEAM_ID = "team-456";

  let tools: ReturnType<typeof createPlannerTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    setActivePlannerContext({
      linearApi: mockLinearApi as any,
      projectId: PROJECT_ID,
      teamId: TEAM_ID,
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

  it("plan_update_issue: sends only description when only description provided", async () => {
    mockLinearApi.getProjectIssues.mockResolvedValueOnce([
      makeIssue({ identifier: "PROJ-1", title: "Existing", id: "id-1" }),
    ]);

    const tool = findTool("plan_update_issue");

    await tool.execute("call-desc", {
      identifier: "PROJ-1",
      description: "New desc only",
    });

    expect(mockLinearApi.updateIssueExtended).toHaveBeenCalledWith("id-1", {
      description: "New desc only",
    });
  });

  it("plan_update_issue: sends only priority when only priority provided", async () => {
    mockLinearApi.getProjectIssues.mockResolvedValueOnce([
      makeIssue({ identifier: "PROJ-1", title: "Existing", id: "id-1" }),
    ]);

    const tool = findTool("plan_update_issue");

    await tool.execute("call-pri", {
      identifier: "PROJ-1",
      priority: 1,
    });

    expect(mockLinearApi.updateIssueExtended).toHaveBeenCalledWith("id-1", {
      priority: 1,
    });
  });

  it("plan_update_issue: sends only labelIds when only labelIds provided", async () => {
    mockLinearApi.getProjectIssues.mockResolvedValueOnce([
      makeIssue({ identifier: "PROJ-1", title: "Existing", id: "id-1" }),
    ]);

    const tool = findTool("plan_update_issue");

    await tool.execute("call-labels", {
      identifier: "PROJ-1",
      labelIds: ["lbl-1"],
    });

    expect(mockLinearApi.updateIssueExtended).toHaveBeenCalledWith("id-1", {
      labelIds: ["lbl-1"],
    });
  });

  it("plan_update_issue: sends empty updates when no optional fields provided", async () => {
    mockLinearApi.getProjectIssues.mockResolvedValueOnce([
      makeIssue({ identifier: "PROJ-1", title: "Existing", id: "id-1" }),
    ]);

    const tool = findTool("plan_update_issue");

    await tool.execute("call-none", {
      identifier: "PROJ-1",
    });

    expect(mockLinearApi.updateIssueExtended).toHaveBeenCalledWith("id-1", {});
  });
});
