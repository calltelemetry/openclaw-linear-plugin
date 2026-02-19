import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refreshLinearToken } from "./auth.js";
import { withResilience } from "../infra/resilience.js";

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
export const AUTH_PROFILES_PATH = join(
  process.env.HOME ?? "/home/claw",
  ".openclaw",
  "auth-profiles.json",
);

export type ActivityContent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter?: string; result?: string }
  | { type: "response"; body: string }
  | { type: "elicitation"; body: string }
  | { type: "error"; body: string };

export interface ExternalUrl {
  label: string;
  url: string;
}

/**
 * Resolve a Linear access token from multiple sources in priority order:
 * 1. pluginConfig.accessToken (static config)
 * 2. LINEAR_ACCESS_TOKEN env var
 * 3. Auth profile store (~/.openclaw/auth-profiles.json) — from OAuth flow
 */
export function resolveLinearToken(pluginConfig?: Record<string, unknown>): {
  accessToken: string | null;
  refreshToken?: string;
  expiresAt?: number;
  source: "config" | "env" | "profile" | "none";
} {
  // 1. Static config
  const fromConfig = pluginConfig?.accessToken;
  if (typeof fromConfig === "string" && fromConfig) {
    return { accessToken: fromConfig, source: "config" };
  }

  // 2. Auth profile store (from OAuth flow) — preferred because OAuth tokens
  //    carry app:assignable/app:mentionable scopes needed for Agent Sessions
  try {
    const raw = readFileSync(AUTH_PROFILES_PATH, "utf8");
    const store = JSON.parse(raw);
    const profile = store?.profiles?.["linear:default"];
    if (profile?.accessToken || profile?.access) {
      return {
        accessToken: profile.accessToken ?? profile.access,
        refreshToken: profile.refreshToken ?? profile.refresh,
        expiresAt: profile.expiresAt ?? profile.expires,
        source: "profile",
      };
    }
  } catch {
    // Profile store doesn't exist or is unreadable
  }

  // 3. Env var fallback (personal API key — works for comments but not Agent Sessions)
  const fromEnv = process.env.LINEAR_ACCESS_TOKEN ?? process.env.LINEAR_API_KEY;
  if (fromEnv) {
    return { accessToken: fromEnv, source: "env" };
  }

  return { accessToken: null, source: "none" };
}

export class LinearAgentApi {
  private accessToken: string;
  private refreshToken?: string;
  private expiresAt?: number;
  private clientId?: string;
  private clientSecret?: string;
  private viewerId?: string;

  constructor(
    accessToken: string,
    opts?: {
      refreshToken?: string;
      expiresAt?: number;
      clientId?: string;
      clientSecret?: string;
    },
  ) {
    this.accessToken = accessToken;
    this.refreshToken = opts?.refreshToken;
    this.expiresAt = opts?.expiresAt;
    this.clientId = opts?.clientId;
    this.clientSecret = opts?.clientSecret;
  }

  async getViewerId(): Promise<string | null> {
    if (this.viewerId) return this.viewerId;
    try {
      const data = await this.gql<{ viewer: { id: string } }>(
        `query { viewer { id } }`,
      );
      this.viewerId = data.viewer.id;
      return this.viewerId;
    } catch {
      return null;
    }
  }

  /** Refresh the token if it's expired (or about to expire in 60s) */
  private async ensureValidToken(): Promise<void> {
    if (!this.refreshToken || !this.clientId || !this.clientSecret) return;
    if (!this.expiresAt) return;

    const bufferMs = 60_000; // refresh 60s before expiry
    if (Date.now() < this.expiresAt - bufferMs) return;

    const result = await refreshLinearToken(this.clientId, this.clientSecret, this.refreshToken);
    this.accessToken = result.access_token;
    if (result.refresh_token) this.refreshToken = result.refresh_token;
    this.expiresAt = Date.now() + result.expires_in * 1000;

    // Persist refreshed token back to auth profile store
    this.persistToken();
  }

  private persistToken(): void {
    try {
      const raw = readFileSync(AUTH_PROFILES_PATH, "utf8");
      const store = JSON.parse(raw);
      if (store.profiles?.["linear:default"]) {
        store.profiles["linear:default"].accessToken = this.accessToken;
        store.profiles["linear:default"].access = this.accessToken;
        if (this.refreshToken) {
          store.profiles["linear:default"].refreshToken = this.refreshToken;
          store.profiles["linear:default"].refresh = this.refreshToken;
        }
        if (this.expiresAt) {
          store.profiles["linear:default"].expiresAt = this.expiresAt;
          store.profiles["linear:default"].expires = this.expiresAt;
        }
        writeFileSync(AUTH_PROFILES_PATH, JSON.stringify(store, null, 2), "utf8");
      }
    } catch {
      // Best-effort persistence
    }
  }

  private authHeader(): string {
    // OAuth tokens (which have a refreshToken) require Bearer prefix;
    // personal API keys do not.
    return this.refreshToken ? `Bearer ${this.accessToken}` : this.accessToken;
  }

  private async gql<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    await this.ensureValidToken();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: this.authHeader(),
      ...extraHeaders,
    };

    const res = await withResilience(() =>
      fetch(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
      }),
    );

    // If 401, try refreshing token once (outside resilience — own retry semantics)
    if (res.status === 401 && this.refreshToken && this.clientId && this.clientSecret) {
      this.expiresAt = 0; // force refresh
      await this.ensureValidToken();

      const retryHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: this.authHeader(),
        ...extraHeaders,
      };

      const retryRes = await fetch(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: retryHeaders,
        body: JSON.stringify({ query, variables }),
      });

      if (!retryRes.ok) {
        const text = await retryRes.text();
        throw new Error(`Linear API authentication failed (${retryRes.status}). Your token may have expired. Run: openclaw openclaw-linear auth`);
      }

      const payload = await retryRes.json();
      if (payload.errors?.length) {
        throw new Error(`Linear GraphQL: ${JSON.stringify(payload.errors)}`);
      }
      return payload.data as T;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Linear API ${res.status}: ${text}`);
    }

    const payload = await res.json();
    if (payload.errors?.length) {
      throw new Error(`Linear GraphQL: ${JSON.stringify(payload.errors)}`);
    }

    return payload.data as T;
  }

  async emitActivity(agentSessionId: string, content: ActivityContent): Promise<void> {
    await this.gql(
      `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) {
          success
        }
      }`,
      { input: { agentSessionId, content } },
    );
  }

  async updateSession(
    agentSessionId: string,
    input: { externalUrls?: ExternalUrl[]; addedExternalUrls?: ExternalUrl[]; plan?: string },
  ): Promise<void> {
    await this.gql(
      `mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
        agentSessionUpdate(id: $id, input: $input) {
          success
        }
      }`,
      { id: agentSessionId, input },
    );
  }

  async createReaction(commentId: string, emoji: string): Promise<boolean> {
    try {
      const data = await this.gql<{
        reactionCreate: { success: boolean };
      }>(
        `mutation ReactionCreate($input: ReactionCreateInput!) {
          reactionCreate(input: $input) {
            success
          }
        }`,
        { input: { commentId, emoji } },
      );
      return data.reactionCreate.success;
    } catch {
      return false;
    }
  }

  async createSessionOnIssue(issueId: string): Promise<{ sessionId: string | null; error?: string }> {
    try {
      const data = await this.gql<{
        agentSessionCreateOnIssue: { success: boolean; agentSession?: { id: string } };
      }>(
        `mutation AgentSessionCreateOnIssue($input: AgentSessionCreateOnIssue!) {
          agentSessionCreateOnIssue(input: $input) {
            success
            agentSession { id }
          }
        }`,
        { input: { issueId } },
      );
      const id = data.agentSessionCreateOnIssue.agentSession?.id ?? null;
      if (!id) return { sessionId: null, error: `success=${data.agentSessionCreateOnIssue.success} but no session ID` };
      return { sessionId: id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { sessionId: null, error: msg };
    }
  }

  async createComment(
    issueId: string,
    body: string,
    opts?: { createAsUser?: string; displayIconUrl?: string },
  ): Promise<string> {
    const input: Record<string, unknown> = { issueId, body };
    if (opts?.createAsUser) input.createAsUser = opts.createAsUser;
    if (opts?.displayIconUrl) input.displayIconUrl = opts.displayIconUrl;

    const data = await this.gql<{
      commentCreate: { success: boolean; comment: { id: string } };
    }>(
      `mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { id }
        }
      }`,
      { input },
    );
    return data.commentCreate.comment.id;
  }

  async getIssueDetails(issueId: string): Promise<{
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    estimate: number | null;
    state: { name: string };
    assignee: { name: string } | null;
    labels: { nodes: Array<{ id: string; name: string }> };
    team: { id: string; name: string; issueEstimationType: string };
    comments: { nodes: Array<{ body: string; user: { name: string } | null; createdAt: string }> };
    project: { id: string; name: string } | null;
    parent: { id: string; identifier: string } | null;
    relations: { nodes: Array<{ type: string; relatedIssue: { id: string; identifier: string; title: string } }> };
  }> {
    const data = await this.gql<{ issue: unknown }>(
      `query Issue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          estimate
          state { name }
          assignee { name }
          labels { nodes { id name } }
          team { id name issueEstimationType }
          comments(last: 10) {
            nodes {
              body
              user { name }
              createdAt
            }
          }
          project { id name }
          parent { id identifier }
          relations { nodes { type relatedIssue { id identifier title } } }
        }
      }`,
      { id: issueId },
    );
    return data.issue as any;
  }

  async updateIssue(issueId: string, input: {
    estimate?: number;
    labelIds?: string[];
    stateId?: string;
    priority?: number;
  }): Promise<boolean> {
    const data = await this.gql<{
      issueUpdate: { success: boolean };
    }>(
      `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
        }
      }`,
      { id: issueId, input },
    );
    return data.issueUpdate.success;
  }

  async getTeamLabels(teamId: string): Promise<Array<{ id: string; name: string }>> {
    const data = await this.gql<{ team: { labels: { nodes: Array<{ id: string; name: string }> } } }>(
      `query TeamLabels($id: String!) {
        team(id: $id) {
          labels { nodes { id name } }
        }
      }`,
      { id: teamId },
    );
    return data.team.labels.nodes;
  }

  // ---------------------------------------------------------------------------
  // Planning methods
  // ---------------------------------------------------------------------------

  async createIssue(input: {
    teamId: string;
    title: string;
    description?: string;
    projectId?: string;
    parentId?: string;
    priority?: number;
    estimate?: number;
    labelIds?: string[];
    stateId?: string;
    assigneeId?: string;
  }): Promise<{ id: string; identifier: string }> {
    // Sub-issues require the GraphQL-Features header
    const extra = input.parentId ? { "GraphQL-Features": "sub_issues" } : undefined;
    const data = await this.gql<{
      issueCreate: { success: boolean; issue: { id: string; identifier: string } };
    }>(
      `mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier }
        }
      }`,
      { input },
      extra,
    );
    return data.issueCreate.issue;
  }

  async createIssueRelation(input: {
    issueId: string;
    relatedIssueId: string;
    type: "blocks" | "blocked_by" | "related" | "duplicate";
  }): Promise<{ id: string }> {
    const data = await this.gql<{
      issueRelationCreate: { success: boolean; issueRelation: { id: string } };
    }>(
      `mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
        issueRelationCreate(input: $input) {
          success
          issueRelation { id }
        }
      }`,
      { input },
    );
    return data.issueRelationCreate.issueRelation;
  }

  async getProject(projectId: string): Promise<{
    id: string;
    name: string;
    description: string;
    state: string;
    teams: { nodes: Array<{ id: string; name: string }> };
  }> {
    const data = await this.gql<{ project: unknown }>(
      `query Project($id: String!) {
        project(id: $id) {
          id
          name
          description
          state
          teams { nodes { id name } }
        }
      }`,
      { id: projectId },
    );
    return data.project as any;
  }

  async getProjectIssues(projectId: string): Promise<Array<{
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    estimate: number | null;
    priority: number;
    state: { name: string; type: string };
    parent: { id: string; identifier: string } | null;
    labels: { nodes: Array<{ id: string; name: string }> };
    relations: { nodes: Array<{ type: string; relatedIssue: { id: string; identifier: string; title: string } }> };
  }>> {
    const data = await this.gql<{
      project: { issues: { nodes: unknown[] } };
    }>(
      `query ProjectIssues($id: String!) {
        project(id: $id) {
          issues {
            nodes {
              id
              identifier
              title
              description
              estimate
              priority
              state { name type }
              parent { id identifier }
              labels { nodes { id name } }
              relations { nodes { type relatedIssue { id identifier title } } }
            }
          }
        }
      }`,
      { id: projectId },
    );
    return data.project.issues.nodes as any;
  }

  async getTeamStates(teamId: string): Promise<Array<{
    id: string;
    name: string;
    type: string;
  }>> {
    const data = await this.gql<{
      team: { states: { nodes: Array<{ id: string; name: string; type: string }> } };
    }>(
      `query TeamStates($id: String!) {
        team(id: $id) {
          states: workflowStates { nodes { id name type } }
        }
      }`,
      { id: teamId },
    );
    return data.team.states.nodes;
  }

  async updateIssueExtended(issueId: string, input: {
    title?: string;
    description?: string;
    estimate?: number;
    labelIds?: string[];
    stateId?: string;
    priority?: number;
    projectId?: string;
    parentId?: string;
    assigneeId?: string;
    dueDate?: string;
  }): Promise<boolean> {
    const data = await this.gql<{
      issueUpdate: { success: boolean };
    }>(
      `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
        }
      }`,
      { id: issueId, input },
    );
    return data.issueUpdate.success;
  }

  async getAppNotifications(count: number = 5): Promise<Array<{
    id: string;
    type: string;
    createdAt: string;
    issue?: { id: string; identifier: string; title: string };
    comment?: { id: string; body: string; userId?: string };
  }>> {
    const data = await this.gql<{ notifications: { nodes: unknown[] } }>(
      `query Notifications($first: Int!) {
        notifications(first: $first, orderBy: createdAt) {
          nodes {
            id
            type
            createdAt
            ... on IssueNotification {
              issue { id identifier title }
              comment { id body }
            }
          }
        }
      }`,
      { first: count },
    );
    return data.notifications.nodes as any;
  }
}
