/**
 * linear-issues-tool.test.ts — Tests for the native linear_issues tool.
 *
 * Mocks LinearAgentApi and resolveLinearToken to test each action handler
 * (read, update, comment, list_states, list_labels) in isolation.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { makeIssueDetails } from "../__test__/fixtures/linear-responses.js";

// ---------------------------------------------------------------------------
// Mocks — use vi.hoisted() so they're available in the hoisted vi.mock factory
// ---------------------------------------------------------------------------

const {
  mockGetIssueDetails,
  mockUpdateIssueExtended,
  mockCreateComment,
  mockCreateIssue,
  mockGetTeamStates,
  mockGetTeamLabels,
  mockResolveLinearToken,
} = vi.hoisted(() => ({
  mockGetIssueDetails: vi.fn(),
  mockUpdateIssueExtended: vi.fn(),
  mockCreateComment: vi.fn(),
  mockCreateIssue: vi.fn(),
  mockGetTeamStates: vi.fn(),
  mockGetTeamLabels: vi.fn(),
  mockResolveLinearToken: vi.fn(() => ({
    accessToken: "test-token",
    source: "env" as const,
  })),
}));

vi.mock("../api/linear-api.js", () => ({
  resolveLinearToken: mockResolveLinearToken,
  LinearAgentApi: class MockLinearAgentApi {
    getIssueDetails = mockGetIssueDetails;
    updateIssueExtended = mockUpdateIssueExtended;
    createComment = mockCreateComment;
    createIssue = mockCreateIssue;
    getTeamStates = mockGetTeamStates;
    getTeamLabels = mockGetTeamLabels;
  },
}));

import { createLinearIssuesTool } from "./linear-issues-tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApi() {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    pluginConfig: {},
  } as any;
}

async function executeTool(params: Record<string, unknown>) {
  const tool = createLinearIssuesTool(makeApi());
  return (tool as any).execute("call-1", params);
}

function parseResult(result: any): any {
  // jsonResult returns { content: [{ type: "text", text: JSON.stringify(...) }], details: payload }
  if (result?.content && Array.isArray(result.content)) {
    const textBlock = result.content.find((r: any) => r.type === "text");
    if (textBlock) return JSON.parse(textBlock.text);
  }
  // Direct details access
  if (result?.details) return result.details;
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Reset default token mock
  mockResolveLinearToken.mockReturnValue({
    accessToken: "test-token",
    source: "env" as const,
  });
});

describe("linear_issues tool", () => {
  describe("read action", () => {
    it("returns formatted issue details", async () => {
      const issue = makeIssueDetails({
        comments: {
          nodes: [
            { body: "First comment", user: { name: "Alice" }, createdAt: "2025-01-01T00:00:00Z" },
          ],
        },
        labels: { nodes: [{ id: "label-1", name: "bug" }] },
      });
      mockGetIssueDetails.mockResolvedValueOnce(issue);

      const result = parseResult(await executeTool({ action: "read", issueId: "ENG-123" }));

      expect(mockGetIssueDetails).toHaveBeenCalledWith("ENG-123");
      expect(result.identifier).toBe("ENG-123");
      expect(result.title).toBe("Fix webhook routing");
      expect(result.status).toBe("In Progress");
      expect(result.labels).toEqual(["bug"]);
      expect(result.recentComments).toHaveLength(1);
      expect(result.recentComments[0].author).toBe("Alice");
    });

    it("returns error when issueId missing", async () => {
      const result = parseResult(await executeTool({ action: "read" }));
      expect(result.error).toMatch(/issueId is required/);
    });
  });

  describe("update action", () => {
    it("resolves status name to stateId", async () => {
      mockGetIssueDetails.mockResolvedValueOnce(makeIssueDetails());
      mockGetTeamStates.mockResolvedValueOnce([
        { id: "state-1", name: "Backlog", type: "backlog" },
        { id: "state-2", name: "In Progress", type: "started" },
        { id: "state-3", name: "Done", type: "completed" },
      ]);
      mockUpdateIssueExtended.mockResolvedValueOnce(true);

      const result = parseResult(await executeTool({
        action: "update",
        issueId: "ENG-123",
        status: "Done",
      }));

      expect(mockGetTeamStates).toHaveBeenCalledWith("team-1");
      expect(mockUpdateIssueExtended).toHaveBeenCalledWith("ENG-123", { stateId: "state-3" });
      expect(result.success).toBe(true);
      expect(result.changes).toContain("status → Done");
    });

    it("resolves status name case-insensitively", async () => {
      mockGetIssueDetails.mockResolvedValueOnce(makeIssueDetails());
      mockGetTeamStates.mockResolvedValueOnce([
        { id: "state-2", name: "In Progress", type: "started" },
      ]);
      mockUpdateIssueExtended.mockResolvedValueOnce(true);

      const result = parseResult(await executeTool({
        action: "update",
        issueId: "ENG-123",
        status: "in progress",
      }));

      expect(mockUpdateIssueExtended).toHaveBeenCalledWith("ENG-123", { stateId: "state-2" });
      expect(result.success).toBe(true);
    });

    it("resolves label names to labelIds", async () => {
      mockGetIssueDetails.mockResolvedValueOnce(makeIssueDetails());
      mockGetTeamLabels.mockResolvedValueOnce([
        { id: "label-1", name: "bug" },
        { id: "label-2", name: "urgent" },
        { id: "label-3", name: "feature" },
      ]);
      mockUpdateIssueExtended.mockResolvedValueOnce(true);

      const result = parseResult(await executeTool({
        action: "update",
        issueId: "ENG-123",
        labels: ["bug", "urgent"],
      }));

      expect(mockGetTeamLabels).toHaveBeenCalledWith("team-1");
      expect(mockUpdateIssueExtended).toHaveBeenCalledWith("ENG-123", {
        labelIds: ["label-1", "label-2"],
      });
      expect(result.success).toBe(true);
    });

    it("returns error for unknown status", async () => {
      mockGetIssueDetails.mockResolvedValueOnce(makeIssueDetails());
      mockGetTeamStates.mockResolvedValueOnce([
        { id: "state-1", name: "Backlog", type: "backlog" },
        { id: "state-2", name: "In Progress", type: "started" },
      ]);

      const result = parseResult(await executeTool({
        action: "update",
        issueId: "ENG-123",
        status: "Nonexistent",
      }));

      expect(result.error).toMatch(/Status "Nonexistent" not found/);
      expect(result.error).toMatch(/Available states:/);
      expect(mockUpdateIssueExtended).not.toHaveBeenCalled();
    });

    it("returns error for unknown labels", async () => {
      mockGetIssueDetails.mockResolvedValueOnce(makeIssueDetails());
      mockGetTeamLabels.mockResolvedValueOnce([
        { id: "label-1", name: "bug" },
      ]);

      const result = parseResult(await executeTool({
        action: "update",
        issueId: "ENG-123",
        labels: ["bug", "nonexistent"],
      }));

      expect(result.error).toMatch(/Labels not found: nonexistent/);
      expect(mockUpdateIssueExtended).not.toHaveBeenCalled();
    });

    it("updates priority and estimate together", async () => {
      mockGetIssueDetails.mockResolvedValueOnce(makeIssueDetails());
      mockUpdateIssueExtended.mockResolvedValueOnce(true);

      const result = parseResult(await executeTool({
        action: "update",
        issueId: "ENG-123",
        priority: 2,
        estimate: 5,
      }));

      expect(mockUpdateIssueExtended).toHaveBeenCalledWith("ENG-123", {
        priority: 2,
        estimate: 5,
      });
      expect(result.success).toBe(true);
      expect(result.changes).toContain("priority → 2");
      expect(result.changes).toContain("estimate → 5");
    });

    it("returns error when issueId missing", async () => {
      const result = parseResult(await executeTool({ action: "update", status: "Done" }));
      expect(result.error).toMatch(/issueId is required/);
    });

    it("returns error when no fields provided", async () => {
      const result = parseResult(await executeTool({ action: "update", issueId: "ENG-123" }));
      expect(result.error).toMatch(/At least one field/);
    });
  });

  describe("create action", () => {
    it("creates a new issue with teamId", async () => {
      mockCreateIssue.mockResolvedValueOnce({ id: "issue-new", identifier: "ENG-200" });

      const result = parseResult(await executeTool({
        action: "create",
        title: "New feature",
        description: "Build the thing",
        teamId: "team-1",
        priority: 2,
        estimate: 3,
      }));

      expect(mockCreateIssue).toHaveBeenCalledWith({
        teamId: "team-1",
        title: "New feature",
        description: "Build the thing",
        priority: 2,
        estimate: 3,
      });
      expect(result.success).toBe(true);
      expect(result.identifier).toBe("ENG-200");
      expect(result.parentIssueId).toBeNull();
    });

    it("creates a sub-issue under a parent", async () => {
      const parentIssue = makeIssueDetails({
        project: { id: "proj-1", name: "My Project" },
      });
      mockGetIssueDetails.mockResolvedValueOnce(parentIssue);
      mockCreateIssue.mockResolvedValueOnce({ id: "issue-sub", identifier: "ENG-201" });

      const result = parseResult(await executeTool({
        action: "create",
        title: "Sub-task: handle edge case",
        description: "Fix the edge case for empty input",
        parentIssueId: "ENG-123",
      }));

      expect(mockGetIssueDetails).toHaveBeenCalledWith("ENG-123");
      expect(mockCreateIssue).toHaveBeenCalledWith({
        teamId: "team-1",
        projectId: "proj-1",
        title: "Sub-task: handle edge case",
        description: "Fix the edge case for empty input",
        parentId: "ENG-123",
      });
      expect(result.success).toBe(true);
      expect(result.identifier).toBe("ENG-201");
      expect(result.parentIssueId).toBe("ENG-123");
    });

    it("inherits teamId from parent when not provided", async () => {
      mockGetIssueDetails.mockResolvedValueOnce(makeIssueDetails());
      mockCreateIssue.mockResolvedValueOnce({ id: "issue-sub", identifier: "ENG-202" });

      const result = parseResult(await executeTool({
        action: "create",
        title: "Child issue",
        description: "Some work",
        parentIssueId: "ENG-123",
      }));

      expect(result.success).toBe(true);
      // teamId inherited from parent's team.id ("team-1" in makeIssueDetails)
      expect(mockCreateIssue).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: "team-1" }),
      );
    });

    it("resolves label names when creating", async () => {
      mockGetTeamLabels.mockResolvedValueOnce([
        { id: "label-1", name: "bug" },
        { id: "label-2", name: "backend" },
      ]);
      mockCreateIssue.mockResolvedValueOnce({ id: "issue-new", identifier: "ENG-203" });

      const result = parseResult(await executeTool({
        action: "create",
        title: "Bug fix",
        description: "Fix it",
        teamId: "team-1",
        labels: ["bug", "backend"],
      }));

      expect(mockGetTeamLabels).toHaveBeenCalledWith("team-1");
      expect(mockCreateIssue).toHaveBeenCalledWith(
        expect.objectContaining({ labelIds: ["label-1", "label-2"] }),
      );
      expect(result.success).toBe(true);
    });

    it("returns error when title missing", async () => {
      const result = parseResult(await executeTool({ action: "create", teamId: "team-1" }));
      expect(result.error).toMatch(/title is required/);
    });

    it("returns error when teamId missing and no parent", async () => {
      const result = parseResult(await executeTool({
        action: "create",
        title: "Orphan issue",
      }));
      expect(result.error).toMatch(/teamId is required/);
    });

    it("returns error for unknown labels", async () => {
      mockGetTeamLabels.mockResolvedValueOnce([
        { id: "label-1", name: "bug" },
      ]);

      const result = parseResult(await executeTool({
        action: "create",
        title: "Test",
        description: "Test",
        teamId: "team-1",
        labels: ["bug", "nonexistent"],
      }));

      expect(result.error).toMatch(/Labels not found: nonexistent/);
      expect(mockCreateIssue).not.toHaveBeenCalled();
    });
  });

  describe("comment action", () => {
    it("posts comment and returns ID", async () => {
      mockCreateComment.mockResolvedValueOnce("comment-42");

      const result = parseResult(await executeTool({
        action: "comment",
        issueId: "ENG-123",
        body: "This is a test comment",
      }));

      expect(mockCreateComment).toHaveBeenCalledWith("ENG-123", "This is a test comment");
      expect(result.success).toBe(true);
      expect(result.commentId).toBe("comment-42");
    });

    it("returns error when body missing", async () => {
      const result = parseResult(await executeTool({ action: "comment", issueId: "ENG-123" }));
      expect(result.error).toMatch(/body is required/);
    });
  });

  describe("list_states action", () => {
    it("returns team workflow states", async () => {
      const states = [
        { id: "s1", name: "Backlog", type: "backlog" },
        { id: "s2", name: "In Progress", type: "started" },
        { id: "s3", name: "Done", type: "completed" },
      ];
      mockGetTeamStates.mockResolvedValueOnce(states);

      const result = parseResult(await executeTool({ action: "list_states", teamId: "team-1" }));

      expect(mockGetTeamStates).toHaveBeenCalledWith("team-1");
      expect(result.states).toEqual(states);
    });

    it("returns error when teamId missing", async () => {
      const result = parseResult(await executeTool({ action: "list_states" }));
      expect(result.error).toMatch(/teamId is required/);
    });
  });

  describe("list_labels action", () => {
    it("returns team labels", async () => {
      const labels = [
        { id: "l1", name: "bug" },
        { id: "l2", name: "feature" },
      ];
      mockGetTeamLabels.mockResolvedValueOnce(labels);

      const result = parseResult(await executeTool({ action: "list_labels", teamId: "team-1" }));

      expect(mockGetTeamLabels).toHaveBeenCalledWith("team-1");
      expect(result.labels).toEqual(labels);
    });
  });

  describe("error handling", () => {
    it("returns error when no token available", async () => {
      mockResolveLinearToken.mockReturnValueOnce({
        accessToken: null,
        source: "none" as const,
      });

      const result = parseResult(await executeTool({ action: "read", issueId: "ENG-123" }));
      expect(result.error).toMatch(/No Linear access token/);
    });

    it("returns error for unknown action", async () => {
      const result = parseResult(await executeTool({ action: "delete" }));
      expect(result.error).toMatch(/Unknown action: delete/);
    });

    it("catches API errors gracefully", async () => {
      mockGetIssueDetails.mockRejectedValueOnce(new Error("API timeout"));

      const result = parseResult(await executeTool({ action: "read", issueId: "ENG-123" }));
      expect(result.error).toMatch(/API timeout/);
    });
  });
});
