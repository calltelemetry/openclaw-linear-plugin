import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { LinearAgentApi, resolveLinearToken } from "../api/linear-api.js";

type Action = "read" | "create" | "update" | "comment" | "list_states" | "list_labels";

interface ToolParams {
  action: Action;
  issueId?: string;
  parentIssueId?: string;
  status?: string;
  priority?: number;
  estimate?: number;
  labels?: string[];
  title?: string;
  description?: string;
  body?: string;
  teamId?: string;
  projectId?: string;
}

function buildApi(pluginConfig?: Record<string, unknown>): LinearAgentApi {
  const tokenInfo = resolveLinearToken(pluginConfig);
  if (!tokenInfo.accessToken) {
    throw new Error("No Linear access token configured. Run: openclaw openclaw-linear auth");
  }
  return new LinearAgentApi(tokenInfo.accessToken, {
    refreshToken: tokenInfo.refreshToken,
    expiresAt: tokenInfo.expiresAt,
  });
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function handleRead(api: LinearAgentApi, params: ToolParams) {
  if (!params.issueId) {
    return jsonResult({ error: "issueId is required for action='read'" });
  }
  const issue = await api.getIssueDetails(params.issueId);
  return jsonResult({
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    status: issue.state.name,
    statusType: issue.state.type,
    assignee: issue.assignee?.name ?? null,
    creator: issue.creator?.name ?? null,
    estimate: issue.estimate,
    team: { id: issue.team.id, name: issue.team.name },
    labels: issue.labels.nodes.map((l) => l.name),
    project: issue.project ? { id: issue.project.id, name: issue.project.name } : null,
    parent: issue.parent ? { id: issue.parent.id, identifier: issue.parent.identifier } : null,
    relations: issue.relations.nodes.map((r) => ({
      type: r.type,
      identifier: r.relatedIssue.identifier,
      title: r.relatedIssue.title,
    })),
    recentComments: issue.comments.nodes.map((c) => ({
      author: c.user?.name ?? "Unknown",
      body: c.body.slice(0, 500),
      createdAt: c.createdAt,
    })),
  });
}

async function handleCreate(api: LinearAgentApi, params: ToolParams) {
  if (!params.title) {
    return jsonResult({ error: "title is required for action='create'" });
  }

  // Resolve teamId: explicit param, or derive from parent issue
  let teamId = params.teamId;
  let projectId = params.projectId;

  if (params.parentIssueId) {
    // Fetch parent to get teamId and projectId
    const parent = await api.getIssueDetails(params.parentIssueId);
    teamId = teamId ?? parent.team.id;
    projectId = projectId ?? parent.project?.id ?? undefined;
  }

  if (!teamId) {
    return jsonResult({
      error: "teamId is required for action='create'. Provide it directly, or provide parentIssueId to inherit from parent.",
    });
  }

  const input: Record<string, unknown> = {
    teamId,
    title: params.title,
  };

  if (params.description) input.description = params.description;
  if (params.parentIssueId) input.parentId = params.parentIssueId;
  if (projectId) input.projectId = projectId;
  if (params.priority != null) input.priority = params.priority;
  if (params.estimate != null) input.estimate = params.estimate;

  // Resolve label names → labelIds
  if (params.labels) {
    const teamLabels = await api.getTeamLabels(teamId);
    const resolvedIds: string[] = [];
    const unmatched: string[] = [];
    for (const name of params.labels) {
      const match = teamLabels.find((l) => l.name.toLowerCase() === name.toLowerCase());
      if (match) {
        resolvedIds.push(match.id);
      } else {
        unmatched.push(name);
      }
    }
    if (unmatched.length > 0) {
      const available = teamLabels.map((l) => l.name).join(", ");
      return jsonResult({
        error: `Labels not found: ${unmatched.join(", ")}. Available: ${available}`,
      });
    }
    input.labelIds = resolvedIds;
  }

  const result = await api.createIssue(input as any);
  return jsonResult({
    success: true,
    id: result.id,
    identifier: result.identifier,
    parentIssueId: params.parentIssueId ?? null,
  });
}

async function handleUpdate(api: LinearAgentApi, params: ToolParams) {
  if (!params.issueId) {
    return jsonResult({ error: "issueId is required for action='update'" });
  }

  const hasFields = params.status || params.priority != null || params.estimate != null || params.labels || params.title;
  if (!hasFields) {
    return jsonResult({ error: "At least one field (status, priority, estimate, labels, title) is required for action='update'" });
  }

  // Fetch issue to get teamId for name-to-ID resolution
  const issue = await api.getIssueDetails(params.issueId);
  const teamId = issue.team.id;
  const updateInput: Record<string, unknown> = {};
  const changes: string[] = [];

  // Resolve status name → stateId
  if (params.status) {
    const states = await api.getTeamStates(teamId);
    const match = states.find((s) => s.name.toLowerCase() === params.status!.toLowerCase());
    if (!match) {
      const available = states.map((s) => `${s.name} (${s.type})`).join(", ");
      return jsonResult({
        error: `Status "${params.status}" not found. Available states: ${available}`,
      });
    }
    updateInput.stateId = match.id;
    changes.push(`status → ${match.name}`);
  }

  // Resolve label names → labelIds
  if (params.labels) {
    const teamLabels = await api.getTeamLabels(teamId);
    const resolvedIds: string[] = [];
    const unmatched: string[] = [];
    for (const name of params.labels) {
      const match = teamLabels.find((l) => l.name.toLowerCase() === name.toLowerCase());
      if (match) {
        resolvedIds.push(match.id);
      } else {
        unmatched.push(name);
      }
    }
    if (unmatched.length > 0) {
      const available = teamLabels.map((l) => l.name).join(", ");
      return jsonResult({
        error: `Labels not found: ${unmatched.join(", ")}. Available: ${available}`,
      });
    }
    updateInput.labelIds = resolvedIds;
    changes.push(`labels → [${params.labels.join(", ")}]`);
  }

  if (params.priority != null) {
    updateInput.priority = params.priority;
    changes.push(`priority → ${params.priority}`);
  }

  if (params.estimate != null) {
    updateInput.estimate = params.estimate;
    changes.push(`estimate → ${params.estimate}`);
  }

  if (params.title) {
    updateInput.title = params.title;
    changes.push(`title → "${params.title}"`);
  }

  const success = await api.updateIssueExtended(params.issueId, updateInput);
  return jsonResult({
    success,
    issueId: issue.identifier,
    changes,
  });
}

async function handleComment(api: LinearAgentApi, params: ToolParams) {
  if (!params.issueId) {
    return jsonResult({ error: "issueId is required for action='comment'" });
  }
  if (!params.body) {
    return jsonResult({ error: "body is required for action='comment'" });
  }
  const commentId = await api.createComment(params.issueId, params.body);
  return jsonResult({ success: true, commentId });
}

async function handleListStates(api: LinearAgentApi, params: ToolParams) {
  if (!params.teamId) {
    return jsonResult({ error: "teamId is required for action='list_states'" });
  }
  const states = await api.getTeamStates(params.teamId);
  return jsonResult({ states });
}

async function handleListLabels(api: LinearAgentApi, params: ToolParams) {
  if (!params.teamId) {
    return jsonResult({ error: "teamId is required for action='list_labels'" });
  }
  const labels = await api.getTeamLabels(params.teamId);
  return jsonResult({ labels });
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createLinearIssuesTool(
  api: OpenClawPluginApi,
): AnyAgentTool {
  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;

  return {
    name: "linear_issues",
    label: "Linear Issues",
    description:
      "Read, create, update, and manage Linear issues directly via API. " +
      "Actions: read (get issue details), create (create issue or sub-issue), " +
      "update (change status/priority/labels/estimate/title), " +
      "comment (post a comment), list_states (get workflow states for a team), " +
      "list_labels (get labels for a team). " +
      "Use action='create' with parentIssueId to create sub-issues for granular work breakdown. " +
      "Status and label names are resolved to IDs automatically.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "create", "update", "comment", "list_states", "list_labels"],
          description: "The action to perform.",
        },
        issueId: {
          type: "string",
          description: "Issue identifier (e.g. 'ENG-123') or UUID. Required for read, update, comment.",
        },
        parentIssueId: {
          type: "string",
          description: "Parent issue identifier or UUID. Used with action=create to make a sub-issue. The new issue inherits teamId and projectId from the parent.",
        },
        description: {
          type: "string",
          description: "Issue description with acceptance criteria. Used with action=create.",
        },
        projectId: {
          type: "string",
          description: "Project UUID. Used with action=create to add the issue to a project.",
        },
        status: {
          type: "string",
          description: "New status name (e.g. 'In Progress', 'Done', 'Backlog'). Used with action=update.",
        },
        priority: {
          type: "number",
          description: "Priority level 0-4 (0=none, 1=urgent, 2=high, 3=medium, 4=low). Used with action=create and action=update.",
        },
        estimate: {
          type: "number",
          description: "Story point estimate. Used with action=create and action=update.",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Label names to set on the issue. Used with action=create and action=update.",
        },
        title: {
          type: "string",
          description: "Issue title. Required for action=create. Used with action=update to rename.",
        },
        body: {
          type: "string",
          description: "Comment body text. Required for action=comment.",
        },
        teamId: {
          type: "string",
          description: "Team ID. Required for list_states, list_labels, and action=create (unless parentIssueId is provided). Get it from a read action first.",
        },
      },
      required: ["action"],
    },
    execute: async (_toolCallId: string, params: ToolParams) => {
      try {
        const linearApi = buildApi(pluginConfig);

        switch (params.action) {
          case "read":
            return await handleRead(linearApi, params);
          case "create":
            return await handleCreate(linearApi, params);
          case "update":
            return await handleUpdate(linearApi, params);
          case "comment":
            return await handleComment(linearApi, params);
          case "list_states":
            return await handleListStates(linearApi, params);
          case "list_labels":
            return await handleListLabels(linearApi, params);
          default:
            return jsonResult({ error: `Unknown action: ${params.action}. Valid: read, create, update, comment, list_states, list_labels` });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        api.logger.error(`linear_issues tool error: ${message}`);
        return jsonResult({ error: message });
      }
    },
  } as unknown as AnyAgentTool;
}
