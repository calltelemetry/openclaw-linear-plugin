/**
 * Factory functions for Linear webhook event payloads.
 *
 * Matches the shapes received at /linear/webhook from both
 * workspace webhooks and OAuth app webhooks.
 */

export function makeAgentSessionCreated(overrides?: Record<string, unknown>) {
  return {
    type: "AgentSession",
    action: "create",
    data: {
      id: "sess-1",
      context: { commentBody: "Please investigate this issue" },
    },
    issue: {
      id: "issue-1",
      identifier: "ENG-123",
      title: "Fix webhook routing",
    },
    ...overrides,
  };
}

export function makeAgentSessionPrompted(overrides?: Record<string, unknown>) {
  return {
    type: "AgentSession",
    action: "prompted",
    data: {
      id: "sess-prompted",
      context: { prompt: "Looks good, approved!" },
    },
    issue: {
      id: "issue-2",
      identifier: "ENG-124",
      title: "Approved issue",
    },
    ...overrides,
  };
}

export function makeCommentCreate(overrides?: Record<string, unknown>) {
  return {
    type: "Comment",
    action: "create",
    data: {
      id: "comment-1",
      body: "This needs work",
      user: { id: "user-1", name: "Test User" },
      issue: {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Fix webhook routing",
        team: { id: "team-1" },
        assignee: { id: "viewer-1" },
        project: null,
      },
      createdAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

export function makeIssueUpdate(overrides?: Record<string, unknown>) {
  return {
    type: "Issue",
    action: "update",
    data: {
      id: "issue-1",
      identifier: "ENG-123",
      title: "Fix webhook routing",
      state: { name: "In Progress", type: "started" },
      assignee: { id: "viewer-1", name: "Agent" },
      team: { id: "team-1" },
      project: null,
    },
    ...overrides,
  };
}

export function makeIssueCreate(overrides?: Record<string, unknown>) {
  return {
    type: "Issue",
    action: "create",
    data: {
      id: "issue-new",
      identifier: "ENG-200",
      title: "New issue",
      state: { name: "Backlog", type: "backlog" },
      assignee: null,
      team: { id: "team-1" },
      project: null,
    },
    ...overrides,
  };
}

/**
 * AgentSessionEvent.created — the actual type from OAuth app webhooks.
 * (makeAgentSessionCreated uses the legacy "AgentSession"/"create" variant.)
 */
export function makeAgentSessionEventCreated(overrides?: Record<string, unknown>) {
  return {
    type: "AgentSessionEvent",
    action: "created",
    agentSession: {
      id: "sess-event-1",
      issue: {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Fix webhook routing",
      },
    },
    previousComments: [
      {
        body: "Please investigate this issue",
        userId: "user-1",
        createdAt: new Date().toISOString(),
      },
    ],
    guidance: "Always use the main branch. Run make test before closing.",
    ...overrides,
  };
}

/**
 * AgentSessionEvent.prompted — follow-up user message in existing session.
 */
export function makeAgentSessionEventPrompted(overrides?: Record<string, unknown>) {
  return {
    type: "AgentSessionEvent",
    action: "prompted",
    agentSession: {
      id: "sess-event-1",
      issue: {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Fix webhook routing",
      },
    },
    agentActivity: { content: { body: "Follow-up question here" } },
    promptContext: "## Issue\nENG-123: Fix webhook routing\n\n## Guidance\nAlways run lint before committing.\n\n## Comments\nSome prior thread.",
    webhookId: "webhook-prompted-1",
    ...overrides,
  };
}

/**
 * Comment.create from the bot's own user (should be skipped by viewerId check).
 */
export function makeCommentCreateFromBot(viewerId: string, overrides?: Record<string, unknown>) {
  return {
    type: "Comment",
    action: "create",
    data: {
      id: `comment-bot-${Date.now()}`,
      body: "**[Mal]** Bot response text",
      user: { id: viewerId, name: "CT Claw" },
      issue: {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Fix webhook routing",
        team: { id: "team-1" },
        assignee: { id: viewerId },
        project: null,
      },
      createdAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

/**
 * Issue.update with assignment/delegation fields for dedup testing.
 */
export function makeIssueUpdateWithAssignment(overrides?: Record<string, unknown>) {
  return {
    type: "Issue",
    action: "update",
    data: {
      id: "issue-1",
      identifier: "ENG-123",
      title: "Fix webhook routing",
      state: { name: "In Progress", type: "started" },
      assignee: { id: "viewer-1", name: "Agent" },
      assigneeId: "viewer-1",
      delegateId: null,
      team: { id: "team-1" },
      project: null,
    },
    updatedFrom: {
      assigneeId: null,
    },
    ...overrides,
  };
}

export function makeAppUserNotification(overrides?: Record<string, unknown>) {
  return {
    type: "AppUserNotification",
    action: "create",
    data: {
      type: "issueAssigned",
      issue: {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Fix webhook routing",
      },
      user: { id: "user-1", name: "Test User" },
    },
    ...overrides,
  };
}
