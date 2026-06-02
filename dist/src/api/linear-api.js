import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { refreshLinearToken } from "./auth.js";
import { withResilience } from "../infra/resilience.js";
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
export const AUTH_PROFILES_PATH = join(homedir(), ".openclaw", "auth-profiles.json");
/**
 * Resolve a Linear access token from multiple sources in priority order:
 * 1. pluginConfig.accessToken (static config)
 * 2. LINEAR_ACCESS_TOKEN env var
 * 3. Auth profile store (~/.openclaw/auth-profiles.json) — from OAuth flow
 */
export function resolveLinearToken(pluginConfig) {
    // 1. Static config
    const fromConfig = pluginConfig?.accessToken;
    if (typeof fromConfig === "string" && fromConfig) {
        return { accessToken: fromConfig, source: "config" };
    }
    // 2. Auth profile store (from OAuth flow) — OAuth tokens carry
    //    app:assignable/app:mentionable scopes needed for Agent Sessions.
    //    Token refresh is handled by the 6-hour proactive timer; if it's
    //    expired here, fail loudly so we know the refresh is broken.
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
    }
    catch {
        // Profile store doesn't exist or is unreadable
    }
    // 3. Env var fallback
    const fromEnv = process.env.LINEAR_ACCESS_TOKEN ?? process.env.LINEAR_API_KEY;
    if (fromEnv) {
        return { accessToken: fromEnv, source: "env" };
    }
    return { accessToken: null, source: "none" };
}
export class LinearAgentApi {
    accessToken;
    refreshToken;
    expiresAt;
    clientId;
    clientSecret;
    viewerId;
    constructor(accessToken, opts) {
        this.accessToken = accessToken;
        this.refreshToken = opts?.refreshToken;
        this.expiresAt = opts?.expiresAt;
        this.clientId = opts?.clientId;
        this.clientSecret = opts?.clientSecret;
    }
    async getViewerId() {
        if (this.viewerId)
            return this.viewerId;
        try {
            const data = await this.gql(`query { viewer { id } }`);
            this.viewerId = data.viewer.id;
            return this.viewerId;
        }
        catch {
            return null;
        }
    }
    /** Refresh the token if it's expired (or about to expire in 60s) */
    async ensureValidToken() {
        if (!this.refreshToken || !this.clientId || !this.clientSecret)
            return;
        if (!this.expiresAt)
            return;
        const bufferMs = 60_000; // refresh 60s before expiry
        if (Date.now() < this.expiresAt - bufferMs)
            return;
        const result = await refreshLinearToken(this.clientId, this.clientSecret, this.refreshToken);
        this.accessToken = result.access_token;
        if (result.refresh_token)
            this.refreshToken = result.refresh_token;
        this.expiresAt = Date.now() + result.expires_in * 1000;
        // Persist refreshed token back to auth profile store
        this.persistToken();
    }
    persistToken() {
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
        }
        catch {
            // Best-effort persistence
        }
    }
    authHeader() {
        // OAuth tokens (which have a refreshToken) require Bearer prefix;
        // personal API keys do not.
        return this.refreshToken ? `Bearer ${this.accessToken}` : this.accessToken;
    }
    async gql(query, variables, extraHeaders) {
        await this.ensureValidToken();
        const headers = {
            "Content-Type": "application/json",
            Authorization: this.authHeader(),
            ...extraHeaders,
        };
        const res = await withResilience(() => fetch(LINEAR_GRAPHQL_URL, {
            method: "POST",
            headers,
            body: JSON.stringify({ query, variables }),
        }));
        // If 401, try refreshing token once (outside resilience — own retry semantics)
        if (res.status === 401 && this.refreshToken && this.clientId && this.clientSecret) {
            this.expiresAt = 0; // force refresh
            await this.ensureValidToken();
            const retryHeaders = {
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
            if (payload.errors?.length && !payload.data) {
                throw new Error(`Linear GraphQL: ${JSON.stringify(payload.errors)}`);
            }
            return payload.data;
        }
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Linear API ${res.status}: ${text}`);
        }
        const payload = await res.json();
        if (payload.errors?.length && !payload.data) {
            throw new Error(`Linear GraphQL: ${JSON.stringify(payload.errors)}`);
        }
        return payload.data;
    }
    async emitActivity(agentSessionId, content) {
        await this.gql(`mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) {
          success
        }
      }`, { input: { agentSessionId, content } });
    }
    async updateSession(agentSessionId, input) {
        await this.gql(`mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
        agentSessionUpdate(id: $id, input: $input) {
          success
        }
      }`, { id: agentSessionId, input });
    }
    async createReaction(commentId, emoji) {
        try {
            const data = await this.gql(`mutation ReactionCreate($input: ReactionCreateInput!) {
          reactionCreate(input: $input) {
            success
          }
        }`, { input: { commentId, emoji } });
            return data.reactionCreate.success;
        }
        catch {
            return false;
        }
    }
    async createSessionOnIssue(issueId) {
        try {
            const data = await this.gql(`mutation AgentSessionCreateOnIssue($input: AgentSessionCreateOnIssue!) {
          agentSessionCreateOnIssue(input: $input) {
            success
            agentSession { id }
          }
        }`, { input: { issueId } });
            const id = data.agentSessionCreateOnIssue.agentSession?.id ?? null;
            if (!id)
                return { sessionId: null, error: `success=${data.agentSessionCreateOnIssue.success} but no session ID` };
            return { sessionId: id };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { sessionId: null, error: msg };
        }
    }
    async createComment(issueId, body, opts) {
        const input = { issueId, body };
        if (opts?.createAsUser)
            input.createAsUser = opts.createAsUser;
        if (opts?.displayIconUrl)
            input.displayIconUrl = opts.displayIconUrl;
        const data = await this.gql(`mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { id }
        }
      }`, { input });
        return data.commentCreate.comment.id;
    }
    async getIssueDetails(issueId) {
        const data = await this.gql(`query Issue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          estimate
          state { name type }
          creator { name email }
          assignee { name }
          labels { nodes { id name } }
          team { id key name issueEstimationType }
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
      }`, { id: issueId });
        return data.issue;
    }
    async updateIssue(issueId, input) {
        const data = await this.gql(`mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
        }
      }`, { id: issueId, input });
        return data.issueUpdate.success;
    }
    async getTeamLabels(teamId) {
        const data = await this.gql(`query TeamLabels($id: String!) {
        team(id: $id) {
          labels { nodes { id name } }
        }
      }`, { id: teamId });
        return data.team.labels.nodes;
    }
    async getTeams() {
        const data = await this.gql(`query { teams { nodes { id name key } } }`);
        return data.teams.nodes;
    }
    async createLabel(teamId, name, opts) {
        const input = { teamId, name };
        if (opts?.color)
            input.color = opts.color;
        if (opts?.description)
            input.description = opts.description;
        const data = await this.gql(`mutation CreateLabel($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id name }
        }
      }`, { input });
        if (!data.issueLabelCreate.success) {
            throw new Error(`Failed to create label "${name}"`);
        }
        return data.issueLabelCreate.issueLabel;
    }
    // ---------------------------------------------------------------------------
    // Planning methods
    // ---------------------------------------------------------------------------
    async createIssue(input) {
        // Sub-issues require the GraphQL-Features header
        const extra = input.parentId ? { "GraphQL-Features": "sub_issues" } : undefined;
        const data = await this.gql(`mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier }
        }
      }`, { input }, extra);
        return data.issueCreate.issue;
    }
    async createIssueRelation(input) {
        const data = await this.gql(`mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
        issueRelationCreate(input: $input) {
          success
          issueRelation { id }
        }
      }`, { input });
        return data.issueRelationCreate.issueRelation;
    }
    async getProject(projectId) {
        const data = await this.gql(`query Project($id: String!) {
        project(id: $id) {
          id
          name
          description
          state
          teams { nodes { id name } }
        }
      }`, { id: projectId });
        return data.project;
    }
    async getProjectIssues(projectId) {
        const data = await this.gql(`query ProjectIssues($id: String!) {
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
      }`, { id: projectId });
        return data.project.issues.nodes;
    }
    async getTeamStates(teamId) {
        const data = await this.gql(`query TeamStates($id: String!) {
        team(id: $id) {
          states { nodes { id name type } }
        }
      }`, { id: teamId });
        return data.team.states.nodes;
    }
    async updateIssueExtended(issueId, input) {
        const data = await this.gql(`mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
        }
      }`, { id: issueId, input });
        return data.issueUpdate.success;
    }
    async getAppNotifications(count = 5) {
        const data = await this.gql(`query Notifications($first: Int!) {
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
      }`, { first: count });
        return data.notifications.nodes;
    }
    // ---------------------------------------------------------------------------
    // Webhook management
    // ---------------------------------------------------------------------------
    async listWebhooks() {
        const data = await this.gql(`query Webhooks {
        webhooks {
          nodes {
            id
            label
            url
            enabled
            resourceTypes
            allPublicTeams
            team { id name }
            createdAt
          }
        }
      }`);
        return data.webhooks.nodes;
    }
    async createWebhook(input) {
        const data = await this.gql(`mutation WebhookCreate($input: WebhookCreateInput!) {
        webhookCreate(input: $input) {
          success
          webhook { id enabled }
        }
      }`, { input });
        return data.webhookCreate.webhook;
    }
    async updateWebhook(webhookId, input) {
        const data = await this.gql(`mutation WebhookUpdate($id: String!, $input: WebhookUpdateInput!) {
        webhookUpdate(id: $id, input: $input) {
          success
        }
      }`, { id: webhookId, input });
        return data.webhookUpdate.success;
    }
    async deleteWebhook(webhookId) {
        const data = await this.gql(`mutation WebhookDelete($id: String!) {
        webhookDelete(id: $id) {
          success
        }
      }`, { id: webhookId });
        return data.webhookDelete.success;
    }
    /**
     * Get repository suggestions from Linear for an issue.
     * Uses Linear's ML to rank candidate repos by relevance to the issue.
     */
    async getRepositorySuggestions(issueId, agentSessionId, candidates) {
        if (candidates.length === 0)
            return [];
        try {
            const data = await this.gql(`query RepoSuggestions($issueId: String!, $agentSessionId: String!, $candidateRepositories: [CandidateRepository!]!) {
          issueRepositorySuggestions(issueId: $issueId, agentSessionId: $agentSessionId, candidateRepositories: $candidateRepositories) {
            suggestions {
              repositoryFullName
              hostname
              confidence
            }
          }
        }`, { issueId, agentSessionId, candidateRepositories: candidates });
            return data.issueRepositorySuggestions?.suggestions ?? [];
        }
        catch {
            // Best-effort — if the API doesn't support this or fails, return empty
            return [];
        }
    }
}
// ---------------------------------------------------------------------------
// Proactive token refresh (standalone, no API call required)
// ---------------------------------------------------------------------------
const PROACTIVE_BUFFER_MS = 3_600_000; // 1 hour before expiry
/**
 * Proactively refresh the Linear OAuth token if it's expired or about to expire.
 * Returns true if refreshed, false if skipped (not needed or can't refresh).
 *
 * This is a standalone function that can be called from a timer without making
 * a Linear API request. It reads/writes auth-profiles.json directly.
 */
export async function refreshTokenProactively(pluginConfig) {
    // 1. Read auth-profiles.json, get linear:default profile
    let store;
    try {
        const raw = readFileSync(AUTH_PROFILES_PATH, "utf8");
        store = JSON.parse(raw);
    }
    catch {
        return { refreshed: false, reason: "auth-profiles.json not readable" };
    }
    const profile = store?.profiles?.["linear:default"];
    if (!profile) {
        return { refreshed: false, reason: "no linear:default profile found" };
    }
    // 2. Check if token is expired or will expire within 1 hour
    const expiresAt = profile.expiresAt ?? profile.expires;
    if (typeof expiresAt === "number" && Date.now() < expiresAt - PROACTIVE_BUFFER_MS) {
        return { refreshed: false, reason: "token still valid" };
    }
    // 3. Resolve credentials
    const clientId = pluginConfig?.clientId ?? process.env.LINEAR_CLIENT_ID;
    const clientSecret = pluginConfig?.clientSecret ?? process.env.LINEAR_CLIENT_SECRET;
    const refreshToken = profile.refreshToken ?? profile.refresh;
    if (!clientId || !clientSecret || !refreshToken) {
        return { refreshed: false, reason: "missing credentials (clientId, clientSecret, or refreshToken)" };
    }
    // 4. Refresh the token
    const result = await refreshLinearToken(clientId, clientSecret, refreshToken);
    // 5. Persist updated tokens back to auth-profiles.json (same pattern as persistToken())
    const newAccessToken = result.access_token;
    const newRefreshToken = result.refresh_token ?? refreshToken;
    const newExpiresAt = Date.now() + result.expires_in * 1000;
    try {
        // Re-read to avoid clobbering concurrent writes
        const freshRaw = readFileSync(AUTH_PROFILES_PATH, "utf8");
        const freshStore = JSON.parse(freshRaw);
        if (freshStore.profiles?.["linear:default"]) {
            freshStore.profiles["linear:default"].accessToken = newAccessToken;
            freshStore.profiles["linear:default"].access = newAccessToken;
            freshStore.profiles["linear:default"].refreshToken = newRefreshToken;
            freshStore.profiles["linear:default"].refresh = newRefreshToken;
            freshStore.profiles["linear:default"].expiresAt = newExpiresAt;
            freshStore.profiles["linear:default"].expires = newExpiresAt;
            writeFileSync(AUTH_PROFILES_PATH, JSON.stringify(freshStore, null, 2), "utf8");
        }
    }
    catch {
        // Best-effort persistence — token was refreshed even if write fails
    }
    return { refreshed: true, reason: "token refreshed successfully" };
}
