import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { LinearAgentApi, resolveLinearToken } from "../api/linear-api.js";
import { spawnWorker, type HookContext } from "./pipeline.js";
import { setActiveSession, clearActiveSession, getIssueAffinity, _configureAffinityTtl, _resetAffinityForTesting } from "./active-session.js";
import { readDispatchState, getActiveDispatch, registerDispatch, updateDispatchStatus, completeDispatch, removeActiveDispatch } from "./dispatch-state.js";
import { createNotifierFromConfig, type NotifyFn } from "../infra/notify.js";
import { assessTier } from "./tier-assess.js";
import { createWorktree, createMultiWorktree, prepareWorkspace } from "../infra/codex-worktree.js";
import { resolveRepos, isMultiRepo } from "../infra/multi-repo.js";
import { ensureClawDir, writeManifest, writeDispatchMemory, resolveOrchestratorWorkspace } from "./artifacts.js";
import { readPlanningState, isInPlanningMode, getPlanningSession, endPlanningSession } from "./planning-state.js";
import { initiatePlanningSession, handlePlannerTurn, runPlanAudit } from "./planner.js";
import { startProjectDispatch } from "./dag-dispatch.js";
import { emitDiagnostic } from "../infra/observability.js";
import { classifyIntent } from "./intent-classify.js";
import { extractGuidance, formatGuidanceAppendix, cacheGuidanceForTeam, getCachedGuidanceForTeam, isGuidanceEnabled, _resetGuidanceCacheForTesting } from "./guidance.js";
import { loadAgentProfiles, buildMentionPattern, resolveAgentFromAlias, _resetProfilesCacheForTesting, type AgentProfile } from "../infra/shared-profiles.js";

// ── Prompt input sanitization ─────────────────────────────────────

/**
 * Sanitize user-controlled text before embedding in agent prompts.
 * Prevents token budget abuse (truncation) and template variable
 * injection (escaping {{ / }}).
 */
export function sanitizePromptInput(text: string, maxLength = 4000): string {
  if (!text) return "(no content)";
  // Truncate to prevent token budget abuse
  let sanitized = text.slice(0, maxLength);
  // Escape template variable patterns that could interfere with prompt processing
  sanitized = sanitized.replace(/\{\{/g, "{ {").replace(/\}\}/g, "} }");
  return sanitized;
}

// Track issues with active agent runs to prevent concurrent duplicate runs.
const activeRuns = new Set<string>();

// Dedup: track recently processed keys to avoid double-handling.
// Periodic sweep instead of O(n) scan on every call.
// TTLs are configurable via pluginConfig (dedupTtlMs, dedupSweepIntervalMs).
const recentlyProcessed = new Map<string, number>();
let _dedupTtlMs = 60_000;
let _sweepIntervalMs = 10_000;
let lastSweep = Date.now();

/** @internal — configure dedup TTLs from pluginConfig. Called once at module init or from tests. */
export function _configureDedupTtls(pluginConfig?: Record<string, unknown>): void {
  _dedupTtlMs = (pluginConfig?.dedupTtlMs as number) ?? 60_000;
  _sweepIntervalMs = (pluginConfig?.dedupSweepIntervalMs as number) ?? 10_000;
}

/** @internal — read current dedup TTL (for testing). */
export function _getDedupTtlMs(): number {
  return _dedupTtlMs;
}

function wasRecentlyProcessed(key: string): boolean {
  const now = Date.now();
  if (now - lastSweep > _sweepIntervalMs) {
    for (const [k, ts] of recentlyProcessed) {
      if (now - ts > _dedupTtlMs) recentlyProcessed.delete(k);
    }
    lastSweep = now;
  }
  if (recentlyProcessed.has(key)) return true;
  recentlyProcessed.set(key, now);
  return false;
}

/** @internal — test-only; clears all in-memory dedup state. */
export function _resetForTesting(): void {
  activeRuns.clear();
  recentlyProcessed.clear();
  _resetProfilesCacheForTesting();
  linearApiCache = null;
  lastSweep = Date.now();
  _dedupTtlMs = 60_000;
  _sweepIntervalMs = 10_000;
  _resetGuidanceCacheForTesting();
  _resetAffinityForTesting();
}

/** @internal — test-only; add an issue ID to the activeRuns set. */
export function _addActiveRunForTesting(issueId: string): void {
  activeRuns.add(issueId);
}

/** @internal — test-only; pre-registers a key as recently processed. */
export function _markAsProcessedForTesting(key: string): void {
  wasRecentlyProcessed(key);
}

/** @internal — exported for testing */
export async function readJsonBody(req: IncomingMessage, maxBytes: number, timeoutMs = 5000) {
  const chunks: Buffer[] = [];
  let total = 0;
  let settled = false;
  return await new Promise<{ ok: boolean; value?: any; error?: string }>((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({ ok: false, error: "Request body timeout" });
    }, timeoutMs);

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        clearTimeout(timer);
        req.destroy();
        resolve({ ok: false, error: "payload too large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ ok: true, value: JSON.parse(raw) });
      } catch {
        resolve({ ok: false, error: "invalid json" });
      }
    });
    req.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: "request error" });
    });
  });
}

// ── Cached LinearApi instance (30s TTL) ────────────────────────────
let linearApiCache: { instance: LinearAgentApi; createdAt: number } | null = null;
const LINEAR_API_CACHE_TTL_MS = 30_000;

function createLinearApi(api: OpenClawPluginApi): LinearAgentApi | null {
  const now = Date.now();
  if (linearApiCache && now - linearApiCache.createdAt < LINEAR_API_CACHE_TTL_MS) {
    return linearApiCache.instance;
  }

  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
  const resolved = resolveLinearToken(pluginConfig);

  if (!resolved.accessToken) return null;

  const clientId = (pluginConfig?.clientId as string) ?? process.env.LINEAR_CLIENT_ID;
  const clientSecret = (pluginConfig?.clientSecret as string) ?? process.env.LINEAR_CLIENT_SECRET;

  const instance = new LinearAgentApi(resolved.accessToken, {
    refreshToken: resolved.refreshToken,
    expiresAt: resolved.expiresAt,
    clientId: clientId ?? undefined,
    clientSecret: clientSecret ?? undefined,
  });
  linearApiCache = { instance, createdAt: now };
  return instance;
}

// ── Comment wrapper that pre-registers comment ID for dedup ────────
// When we create a comment, Linear fires Comment.create webhook back to us.
// Register the comment ID immediately so the webhook handler skips it.
// The `opts` parameter posts as a named OpenClaw agent identity (e.g.
// createAsUser: "Mal" with avatar) — requires OAuth actor=app scope.
async function createCommentWithDedup(
  linearApi: LinearAgentApi,
  issueId: string,
  body: string,
  opts?: { createAsUser?: string; displayIconUrl?: string },
): Promise<string> {
  const commentId = await linearApi.createComment(issueId, body, opts);
  wasRecentlyProcessed(`comment:${commentId}`);
  return commentId;
}

/**
 * Post a comment as agent identity with prefix fallback.
 * With gql() partial-success fix, the catch only fires for real failures.
 */
async function postAgentComment(
  api: OpenClawPluginApi,
  linearApi: LinearAgentApi,
  issueId: string,
  body: string,
  label: string,
  agentOpts?: { createAsUser: string; displayIconUrl: string },
): Promise<void> {
  if (!agentOpts) {
    await createCommentWithDedup(linearApi, issueId, `**[${label}]** ${body}`);
    return;
  }
  try {
    await createCommentWithDedup(linearApi, issueId, body, agentOpts);
  } catch (identityErr) {
    api.logger.warn(`Agent identity comment failed: ${identityErr}`);
    await createCommentWithDedup(linearApi, issueId, `**[${label}]** ${body}`);
  }
}

function resolveAgentId(api: OpenClawPluginApi): string {
  const fromConfig = (api as any).pluginConfig?.defaultAgentId;
  if (typeof fromConfig === "string" && fromConfig) return fromConfig;
  // Fall back to whatever is marked isDefault in agent profiles
  const profiles = loadAgentProfiles();
  const defaultAgent = Object.entries(profiles).find(([, p]) => p.isDefault);
  if (!defaultAgent) {
    throw new Error("No defaultAgentId in plugin config and no agent profile marked isDefault. Configure one in agent-profiles.json or set defaultAgentId in plugin config.");
  }
  return defaultAgent[0];
}

export async function handleLinearWebhook(
  api: OpenClawPluginApi,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return true;
  }

  const body = await readJsonBody(req, 1024 * 1024);
  if (!body.ok) {
    res.statusCode = 400;
    res.end(body.error);
    return true;
  }

  const payload = body.value;

  // Structural validation — reject obviously invalid payloads early
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    api.logger.warn("Linear webhook: invalid payload (not an object)");
    res.statusCode = 400;
    res.end("Invalid payload");
    return true;
  }
  if (typeof payload.type !== "string") {
    api.logger.warn(`Linear webhook: missing or non-string type field`);
    res.statusCode = 400;
    res.end("Missing type");
    return true;
  }

  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;

  // Apply configurable dedup TTLs on each webhook (idempotent)
  _configureDedupTtls(pluginConfig);

  // Debug: log full payload structure for diagnosing webhook types
  const payloadKeys = Object.keys(payload).join(", ");
  api.logger.info(`Linear webhook received: type=${payload.type} action=${payload.action} keys=[${payloadKeys}]`);
  emitDiagnostic(api, {
    event: "webhook_received",
    webhookType: payload.type,
    webhookAction: payload.action,
    identifier: payload.data?.identifier ?? payload.agentSession?.issue?.identifier,
    issueId: payload.data?.id ?? payload.agentSession?.issue?.id,
  });


  // ── AppUserNotification — IGNORED ─────────────────────────────────
  // AppUserNotification duplicates events already handled by the workspace
  // webhook (Comment.create for mentions, Issue.update for assignments).
  // Processing both causes double agent runs. Ack and discard.
  if (payload.type === "AppUserNotification") {
    api.logger.info(`AppUserNotification ignored (duplicate of workspace webhook): ${payload.notification?.type} appUserId=${payload.appUserId}`);
    res.statusCode = 200;
    res.end("ok");
    return true;
  }

  // ── AgentSessionEvent.created — direct agent run ─────────────────
  // User chatted with @ctclaw in Linear's agent session. Run the agent
  // DIRECTLY with the user's message. The plan→implement→audit pipeline
  // is only triggered from Issue.update delegation, not from chat.
  if (
    (payload.type === "AgentSessionEvent" && payload.action === "created") ||
    (payload.type === "AgentSession" && payload.action === "create")
  ) {
    // Respond within 5 seconds (Linear requirement)
    res.statusCode = 200;
    res.end("ok");

    const session = payload.agentSession ?? payload.data;
    const issue = session?.issue ?? payload.issue;

    if (!session?.id || !issue?.id) {
      api.logger.error("AgentSession.created missing session or issue data");
      return true;
    }

    // Guard: check activeRuns FIRST (O(1), no side effects).
    // This catches sessions created by our own handlers (Comment dispatch,
    // Issue triage, handleDispatch) which all set activeRuns BEFORE calling
    // createSessionOnIssue(). Checking this first prevents the race condition
    // where the webhook arrives before wasRecentlyProcessed is registered.
    if (activeRuns.has(issue.id)) {
      api.logger.info(`Agent already running for ${issue?.identifier ?? issue?.id} — skipping session ${session.id}`);
      return true;
    }

    // Secondary dedup: skip if we already handled this exact session ID
    if (wasRecentlyProcessed(`session:${session.id}`)) {
      api.logger.info(`AgentSession ${session.id} already handled — skipping`);
      return true;
    }

    const linearApi = createLinearApi(api);
    if (!linearApi) {
      api.logger.error("No Linear access token configured");
      return true;
    }

    const previousComments = payload.previousComments ?? [];
    const guidanceCtx = extractGuidance(payload);

    // Extract the user's latest message from previousComments (NOT from guidance)
    const lastComment = previousComments.length > 0
      ? previousComments[previousComments.length - 1]
      : null;
    const userMessage = lastComment?.body ?? "";

    // Route to the mentioned agent if the user's message contains an @mention.
    // AgentSessionEvent doesn't carry mention routing — we must check manually.
    const profiles = loadAgentProfiles();
    const mentionPattern = buildMentionPattern(profiles);
    let agentId = resolveAgentId(api);
    if (mentionPattern && userMessage) {
      const mentionMatch = userMessage.match(mentionPattern);
      if (mentionMatch) {
        const alias = mentionMatch[1];
        const resolved = resolveAgentFromAlias(alias, profiles);
        if (resolved) {
          api.logger.info(`AgentSession routed to ${resolved.agentId} via @${alias} mention`);
          agentId = resolved.agentId;
        }
      }
    }
    // Session affinity: if no @mention override, prefer the agent that last handled this issue
    if (agentId === resolveAgentId(api) && issue?.id) {
      const affinityAgent = getIssueAffinity(issue.id);
      if (affinityAgent) {
        api.logger.info(`AgentSession routed to ${affinityAgent} via session affinity for ${issue.identifier ?? issue.id}`);
        agentId = affinityAgent;
      }
    }

    api.logger.info(`AgentSession created: ${session.id} for issue ${issue?.identifier ?? issue?.id} agent=${agentId} (comments: ${previousComments.length}, guidance: ${guidanceCtx.guidance ? "yes" : "no"})`);

    // Fetch full issue details
    let enrichedIssue: any = issue;
    try {
      enrichedIssue = await linearApi.getIssueDetails(issue.id);
    } catch (err) {
      api.logger.warn(`Could not fetch issue details: ${err}`);
    }

    const description = enrichedIssue?.description ?? issue?.description ?? "(no description)";

    // Cache guidance for this team (enables Comment webhook paths)
    const teamId = enrichedIssue?.team?.id;
    if (guidanceCtx.guidance && teamId) cacheGuidanceForTeam(teamId, guidanceCtx.guidance);
    const guidanceAppendix = isGuidanceEnabled(pluginConfig as Record<string, unknown> | undefined, teamId)
      ? formatGuidanceAppendix(guidanceCtx.guidance)
      : "";

    // Build conversation context from previous comments
    const commentContext = previousComments
      .slice(-5)
      .map((c: any) => `**${c.user?.name ?? c.actorName ?? "User"}**: ${(c.body ?? "").slice(0, 300)}`)
      .join("\n\n");

    const issueRef = enrichedIssue?.identifier ?? issue.identifier ?? issue.id;
    const stateType = enrichedIssue?.state?.type ?? "";
    const isTriaged = stateType === "started" || stateType === "completed" || stateType === "canceled";

    const toolAccessLines = isTriaged
      ? [
        `**Tool access:**`,
        `- \`linear_issues\` tool: Full access. Use action="read" with issueId="${issueRef}" to get details, action="create" to create issues (with parentIssueId to create sub-issues for granular work breakdown), action="update" with status/priority/labels/estimate to modify issues, action="comment" to post comments, action="list_states" to see available workflow states.`,
        `- \`code_run\`: Dispatch coding work to a worker. Workers return text — they cannot access linear_issues.`,
        `- \`spawn_agent\`/\`ask_agent\`: Delegate to other crew agents.`,
        `- Standard tools: exec, read, edit, write, web_search, etc.`,
        ``,
        `**Sub-issue guidance:** When a task is too large or has multiple distinct parts, break it into sub-issues using action="create" with parentIssueId="${issueRef}". Each sub-issue should be an atomic, independently testable unit of work with its own acceptance criteria. This enables parallel dispatch and clearer progress tracking.`,
      ]
      : [
        `**Tool access:**`,
        `- \`linear_issues\` tool: READ ONLY. Use action="read" with issueId="${issueRef}" to get details, action="list_states"/"list_labels" for metadata. Do NOT use action="update", action="create", or action="comment".`,
        `- \`code_run\`: Dispatch coding work to a worker. Workers return text — they cannot access linear_issues.`,
        `- \`spawn_agent\`/\`ask_agent\`: Delegate to other crew agents.`,
        `- Standard tools: exec, read, edit, write, web_search, etc.`,
      ];

    const roleLines = isTriaged
      ? [`**Your role:** Orchestrator with full Linear access. You can update issue fields, change status, and dispatch work via \`code_run\`. Do NOT post comments yourself — the handler posts your text output.`]
      : [`**Your role:** You are the dispatcher. For any coding or implementation work, use \`code_run\` to dispatch it. Workers return text output. You summarize results. You do NOT update issue status or post comments via linear_issues — the audit system handles lifecycle transitions.`];

    const message = [
      `You are an orchestrator responding in a Linear issue session. Your text output will be posted as activities visible to the user.`,
      ``,
      ...toolAccessLines,
      ``,
      ...roleLines,
      ``,
      `## Issue: ${issueRef} — ${enrichedIssue?.title ?? issue.title ?? "(untitled)"}`,
      `**Status:** ${enrichedIssue?.state?.name ?? "Unknown"} | **Assignee:** ${enrichedIssue?.assignee?.name ?? "Unassigned"}`,
      ``,
      `**Description:**`,
      description,
      commentContext ? `\n**Conversation:**\n${commentContext}` : "",
      userMessage ? `\n**Latest message:**\n> ${userMessage}` : "",
      ``,
      `Respond to the user's request. For work requests, dispatch via \`code_run\` and summarize the result. Be concise and action-oriented.`,
      guidanceAppendix,
    ].filter(Boolean).join("\n");

    // Run agent directly (non-blocking)
    activeRuns.add(issue.id);
    void (async () => {
      const profiles = loadAgentProfiles();
      const defaultProfile = Object.entries(profiles).find(([, p]) => p.isDefault);
      const label = defaultProfile?.[1]?.label ?? profiles[agentId]?.label ?? agentId;

      // Register active session for tool resolution (code_run, etc.)
      setActiveSession({
        agentSessionId: session.id,
        issueIdentifier: enrichedIssue?.identifier ?? issue.identifier ?? issue.id,
        issueId: issue.id,
        agentId,
        startedAt: Date.now(),
      });

      try {
        // Emit initial thought
        await linearApi.emitActivity(session.id, {
          type: "thought",
          body: `${label} is processing request for ${enrichedIssue?.identifier ?? issue.id}...`,
        }).catch(() => {});

        // Run agent with streaming to Linear
        const sessionId = `linear-session-${session.id}`;
        const { runAgent } = await import("../agent/agent.js");
        const result = await runAgent({
          api,
          agentId,
          sessionId,
          message,
          timeoutMs: 5 * 60_000,
          streaming: {
            linearApi,
            agentSessionId: session.id,
          },
        });

        const responseBody = result.success
          ? result.output
          : `Something went wrong while processing this. The system will retry automatically if possible. If this keeps happening, run \`openclaw openclaw-linear doctor\` to check for issues.`;

        // Emit response via session (preferred — avoids duplicate comment).
        // Fall back to a regular comment only if emitActivity fails.
        const labeledResponse = `**[${label}]** ${responseBody}`;
        const emitted = await linearApi.emitActivity(session.id, {
          type: "response",
          body: labeledResponse,
        }).then(() => true).catch(() => false);

        if (!emitted) {
          const avatarUrl = defaultProfile?.[1]?.avatarUrl ?? profiles[agentId]?.avatarUrl;
          const agentOpts = avatarUrl
            ? { createAsUser: label, displayIconUrl: avatarUrl }
            : undefined;
          await postAgentComment(api, linearApi, issue.id, responseBody, label, agentOpts);
        }

        api.logger.info(`Posted agent response to ${enrichedIssue?.identifier ?? issue.id} (session ${session.id})`);
      } catch (err) {
        api.logger.error(`AgentSession handler error: ${err}`);
        await linearApi.emitActivity(session.id, {
          type: "error",
          body: `Failed: ${String(err).slice(0, 500)}`,
        }).catch(() => {});
      } finally {
        clearActiveSession(issue.id);
        activeRuns.delete(issue.id);
      }
    })();

    return true;
  }

  // ── AgentSession.prompted — follow-up user messages in existing sessions
  // Also fires when we emit activities (feedback loop). Use activeRuns guard
  // and webhookId dedup to distinguish user follow-ups from our own emissions.
  if (
    (payload.type === "AgentSessionEvent" && payload.action === "prompted") ||
    (payload.type === "AgentSession" && payload.action === "prompted")
  ) {
    res.statusCode = 200;
    res.end("ok");

    const session = payload.agentSession ?? payload.data;
    const issue = session?.issue ?? payload.issue;
    const activity = payload.agentActivity;

    if (!session?.id || !issue?.id) {
      api.logger.info(`AgentSession prompted: missing session or issue — ignoring`);
      return true;
    }

    // If an agent run is already active for this issue, this is feedback from
    // our own activity emissions — ignore to prevent loops.
    if (activeRuns.has(issue.id)) {
      api.logger.info(`AgentSession prompted: ${session.id} issue=${issue?.identifier ?? issue?.id} — agent active, ignoring (feedback)`);
      return true;
    }

    // Dedup by webhookId
    const webhookId = payload.webhookId;
    if (webhookId && wasRecentlyProcessed(`webhook:${webhookId}`)) {
      api.logger.info(`AgentSession prompted: webhook ${webhookId} already processed — skipping`);
      return true;
    }

    // Extract user message from the activity (not from promptContext which contains issue data + guidance)
    const guidanceCtxPrompted = extractGuidance(payload);
    const userMessage =
      activity?.content?.body ??
      activity?.body ??
      "";

    if (!userMessage || typeof userMessage !== "string" || userMessage.trim().length === 0) {
      api.logger.info(`AgentSession prompted: ${session.id} — no user message found, ignoring`);
      return true;
    }

    const linearApi = createLinearApi(api);
    if (!linearApi) {
      api.logger.error("No Linear access token configured");
      return true;
    }

    // Route to mentioned agent if user's message contains an @mention (one-time detour)
    const promptedProfiles = loadAgentProfiles();
    const promptedMentionPattern = buildMentionPattern(promptedProfiles);
    let agentId = resolveAgentId(api);
    if (promptedMentionPattern && userMessage) {
      const mentionMatch = userMessage.match(promptedMentionPattern);
      if (mentionMatch) {
        const alias = mentionMatch[1];
        const resolved = resolveAgentFromAlias(alias, promptedProfiles);
        if (resolved) {
          api.logger.info(`AgentSession prompted: routed to ${resolved.agentId} via @${alias} mention`);
          agentId = resolved.agentId;
        }
      }
    }
    // Session affinity: if no @mention override, prefer the agent that last handled this issue
    if (agentId === resolveAgentId(api) && issue?.id) {
      const affinityAgent = getIssueAffinity(issue.id);
      if (affinityAgent) {
        api.logger.info(`AgentSession prompted: routed to ${affinityAgent} via session affinity for ${issue.identifier ?? issue.id}`);
        agentId = affinityAgent;
      }
    }

    api.logger.info(`AgentSession prompted (follow-up): ${session.id} issue=${issue?.identifier ?? issue?.id} agent=${agentId} message="${userMessage.slice(0, 80)}..."`);

    // Run agent for follow-up (non-blocking)
    activeRuns.add(issue.id);
    void (async () => {
      const profiles = loadAgentProfiles();
      const defaultProfile = Object.entries(profiles).find(([, p]) => p.isDefault);
      const label = defaultProfile?.[1]?.label ?? profiles[agentId]?.label ?? agentId;

      // Fetch full issue details for context
      let enrichedIssue: any = issue;
      try {
        enrichedIssue = await linearApi.getIssueDetails(issue.id);
      } catch (err) {
        api.logger.warn(`Could not fetch issue details: ${err}`);
      }

      const description = enrichedIssue?.description ?? issue?.description ?? "(no description)";

      // Resolve guidance for follow-up
      const followUpTeamId = enrichedIssue?.team?.id;
      if (guidanceCtxPrompted.guidance && followUpTeamId) cacheGuidanceForTeam(followUpTeamId, guidanceCtxPrompted.guidance);
      const followUpGuidanceAppendix = isGuidanceEnabled(pluginConfig as Record<string, unknown> | undefined, followUpTeamId)
        ? formatGuidanceAppendix(guidanceCtxPrompted.guidance ?? (followUpTeamId ? getCachedGuidanceForTeam(followUpTeamId) : null))
        : "";

      // Build context from recent comments
      const recentComments = enrichedIssue?.comments?.nodes ?? [];
      const commentContext = recentComments
        .slice(-5)
        .map((c: any) => `**${c.user?.name ?? "User"}**: ${(c.body ?? "").slice(0, 300)}`)
        .join("\n\n");

      const followUpIssueRef = enrichedIssue?.identifier ?? issue.identifier ?? issue.id;
      const followUpStateType = enrichedIssue?.state?.type ?? "";
      const followUpIsTriaged = followUpStateType === "started" || followUpStateType === "completed" || followUpStateType === "canceled";

      const followUpToolAccessLines = followUpIsTriaged
        ? [
          `**Tool access:**`,
          `- \`linear_issues\` tool: Full access. Use action="read" with issueId="${followUpIssueRef}" to get details, action="create" to create issues (with parentIssueId to create sub-issues for granular work breakdown), action="update" with status/priority/labels/estimate to modify issues, action="comment" to post comments, action="list_states" to see available workflow states.`,
          `- \`code_run\`: Dispatch coding work to a worker. Workers return text — they cannot access linear_issues.`,
          `- \`spawn_agent\`/\`ask_agent\`: Delegate to other crew agents.`,
          `- Standard tools: exec, read, edit, write, web_search, etc.`,
          ``,
          `**Sub-issue guidance:** When a task is too large or has multiple distinct parts, break it into sub-issues using action="create" with parentIssueId="${followUpIssueRef}". Each sub-issue should be an atomic, independently testable unit of work with its own acceptance criteria. This enables parallel dispatch and clearer progress tracking.`,
        ]
        : [
          `**Tool access:**`,
          `- \`linear_issues\` tool: READ ONLY. Use action="read" with issueId="${followUpIssueRef}" to get details, action="list_states"/"list_labels" for metadata. Do NOT use action="update", action="create", or action="comment".`,
          `- \`code_run\`: Dispatch coding work to a worker. Workers return text — they cannot access linear_issues.`,
          `- \`spawn_agent\`/\`ask_agent\`: Delegate to other crew agents.`,
          `- Standard tools: exec, read, edit, write, web_search, etc.`,
        ];

      const followUpRoleLines = followUpIsTriaged
        ? [`**Your role:** Orchestrator with full Linear access. You can update issue fields, change status, and dispatch work via \`code_run\`. Do NOT post comments yourself — the handler posts your text output.`]
        : [`**Your role:** Dispatcher. For work requests, use \`code_run\`. You do NOT update issue status — the audit system handles lifecycle.`];

      const message = [
        `You are an orchestrator responding in a Linear issue session. Your text output will be posted as activities visible to the user.`,
        ``,
        ...followUpToolAccessLines,
        ``,
        ...followUpRoleLines,
        ``,
        `## Issue: ${followUpIssueRef} — ${enrichedIssue?.title ?? issue.title ?? "(untitled)"}`,
        `**Status:** ${enrichedIssue?.state?.name ?? "Unknown"} | **Assignee:** ${enrichedIssue?.assignee?.name ?? "Unassigned"}`,
        ``,
        `**Description:**`,
        description,
        commentContext ? `\n**Recent conversation:**\n${commentContext}` : "",
        `\n**User's follow-up message:**\n> ${userMessage}`,
        ``,
        `Respond to the user's follow-up. For work requests, dispatch via \`code_run\`. Be concise and action-oriented.`,
        followUpGuidanceAppendix,
      ].filter(Boolean).join("\n");

      setActiveSession({
        agentSessionId: session.id,
        issueIdentifier: enrichedIssue?.identifier ?? issue.identifier ?? issue.id,
        issueId: issue.id,
        agentId,
        startedAt: Date.now(),
      });

      try {
        await linearApi.emitActivity(session.id, {
          type: "thought",
          body: `${label} is processing follow-up for ${enrichedIssue?.identifier ?? issue.id}...`,
        }).catch(() => {});

        const sessionId = `linear-session-${session.id}`;
        const { runAgent } = await import("../agent/agent.js");
        const result = await runAgent({
          api,
          agentId,
          sessionId,
          message,
          timeoutMs: 5 * 60_000,
          streaming: {
            linearApi,
            agentSessionId: session.id,
          },
        });

        const responseBody = result.success
          ? result.output
          : `Something went wrong while processing this. The system will retry automatically if possible. If this keeps happening, run \`openclaw openclaw-linear doctor\` to check for issues.`;

        // Emit response via session (preferred). Fall back to comment if it fails.
        const labeledResponse = `**[${label}]** ${responseBody}`;
        const emitted = await linearApi.emitActivity(session.id, {
          type: "response",
          body: labeledResponse,
        }).then(() => true).catch(() => false);

        if (!emitted) {
          const avatarUrl = defaultProfile?.[1]?.avatarUrl ?? profiles[agentId]?.avatarUrl;
          const agentOpts = avatarUrl
            ? { createAsUser: label, displayIconUrl: avatarUrl }
            : undefined;
          await postAgentComment(api, linearApi, issue.id, responseBody, label, agentOpts);
        }

        api.logger.info(`Posted follow-up response to ${enrichedIssue?.identifier ?? issue.id} (session ${session.id})`);
      } catch (err) {
        api.logger.error(`AgentSession prompted handler error: ${err}`);
        await linearApi.emitActivity(session.id, {
          type: "error",
          body: `Failed: ${String(err).slice(0, 500)}`,
        }).catch(() => {});
      } finally {
        clearActiveSession(issue.id);
        activeRuns.delete(issue.id);
      }
    })();

    return true;
  }

  // ── Comment.create — intent-based routing ────────────────────────
  if (payload.type === "Comment" && payload.action === "create") {
    res.statusCode = 200;
    res.end("ok");

    const comment = payload.data;
    const commentBody = comment?.body ?? "";
    const commentor = comment?.user?.name ?? "Unknown";
    const issue = comment?.issue ?? payload.issue;

    if (!issue?.id) {
      api.logger.error("Comment webhook: missing issue data");
      return true;
    }

    // Dedup on comment ID
    if (comment?.id && wasRecentlyProcessed(`comment:${comment.id}`)) {
      api.logger.info(`Comment ${comment.id} already processed — skipping`);
      return true;
    }

    const linearApi = createLinearApi(api);
    if (!linearApi) {
      api.logger.error("No Linear access token — cannot process comment");
      return true;
    }

    // Skip bot's own comments
    try {
      const viewerId = await linearApi.getViewerId();
      if (viewerId && comment?.user?.id === viewerId) {
        api.logger.info(`Comment webhook: skipping our own comment on ${issue.identifier ?? issue.id}`);
        return true;
      }
    } catch { /* proceed if viewerId check fails */ }

    // Early guard: skip if an agent run is already active for this issue.
    // Avoids wasted LLM intent classification (~2-5s) when result would
    // be discarded anyway by activeRuns check in dispatchCommentToAgent().
    if (activeRuns.has(issue.id)) {
      api.logger.info(`Comment on ${issue.identifier ?? issue.id}: active run — skipping`);
      return true;
    }

    // Load agent profiles
    const profiles = loadAgentProfiles();
    const agentNames = Object.keys(profiles);

    // ── @mention fast path — skip classifier ────────────────────
    const mentionPattern = buildMentionPattern(profiles);
    const mentionMatches = mentionPattern ? commentBody.match(mentionPattern) : null;
    if (mentionMatches && mentionMatches.length > 0) {
      const alias = mentionMatches[0].replace("@", "");
      const resolved = resolveAgentFromAlias(alias, profiles);
      if (resolved) {
        api.logger.info(`Comment @mention fast path: @${resolved.agentId} on ${issue.identifier ?? issue.id}`);
        void dispatchCommentToAgent(api, linearApi, profiles, resolved.agentId, issue, comment, commentBody, commentor, pluginConfig)
          .catch((err) => api.logger.error(`Comment dispatch error: ${err}`));
        return true;
      }
    }

    // ── Intent classification ─────────────────────────────────────
    // Fetch issue details for context
    let enrichedIssue: any = issue;
    try {
      enrichedIssue = await linearApi.getIssueDetails(issue.id);
    } catch (err) {
      api.logger.warn(`Could not fetch issue details: ${err}`);
    }

    const projectId = enrichedIssue?.project?.id;
    const planStatePath = pluginConfig?.planningStatePath as string | undefined;

    // Determine planning state
    let isPlanning = false;
    let planSession: any = null;
    if (projectId) {
      try {
        const planState = await readPlanningState(planStatePath);
        isPlanning = isInPlanningMode(planState, projectId);
        if (isPlanning) {
          planSession = getPlanningSession(planState, projectId);
        }
      } catch { /* proceed without planning context */ }
    }

    const intentResult = await classifyIntent(api, {
      commentBody,
      issueTitle: enrichedIssue?.title ?? "(untitled)",
      issueStatus: enrichedIssue?.state?.name,
      isPlanning,
      agentNames,
      hasProject: !!projectId,
    }, pluginConfig);

    api.logger.info(`Comment intent: ${intentResult.intent}${intentResult.agentId ? ` (agent: ${intentResult.agentId})` : ""} — ${intentResult.reasoning} (fallback: ${intentResult.fromFallback})`);

    // ── Route by intent ────────────────────────────────────────────

    switch (intentResult.intent) {
      case "plan_start": {
        if (!projectId) {
          api.logger.info("Comment intent plan_start but no project — ignoring");
          break;
        }
        if (isPlanning) {
          api.logger.info("Comment intent plan_start but already planning — treating as plan_continue");
          // Fall through to plan_continue
          if (planSession) {
            void handlePlannerTurn(
              { api, linearApi, pluginConfig },
              planSession,
              { issueId: issue.id, commentBody, commentorName: commentor },
            ).catch((err) => api.logger.error(`Planner turn error: ${err}`));
          }
          break;
        }
        api.logger.info(`Planning: initiation requested on ${issue.identifier ?? issue.id}`);
        void initiatePlanningSession(
          { api, linearApi, pluginConfig },
          projectId,
          { id: issue.id, identifier: enrichedIssue.identifier, title: enrichedIssue.title, team: enrichedIssue.team },
        ).catch((err) => api.logger.error(`Planning initiation error: ${err}`));
        break;
      }

      case "plan_finalize": {
        if (!isPlanning || !planSession) {
          api.logger.info("Comment intent plan_finalize but not in planning mode — ignoring");
          break;
        }
        if (planSession.status === "plan_review") {
          // Already passed audit + cross-model review — approve directly
          api.logger.info(`Planning: approving plan for ${planSession.projectName} (from plan_review)`);
          void (async () => {
            try {
              await endPlanningSession(planSession.projectId, "approved", planStatePath);
              await createCommentWithDedup(linearApi,
                planSession.rootIssueId,
                `## Plan Approved\n\nPlan for **${planSession.projectName}** has been approved. Dispatching to workers.`,
              );
              // Trigger DAG dispatch
              const notify = createNotifierFromConfig(pluginConfig, api.runtime, api);
              const hookCtx: HookContext = {
                api, linearApi, notify, pluginConfig,
                configPath: pluginConfig?.dispatchStatePath as string | undefined,
              };
              await startProjectDispatch(hookCtx, planSession.projectId);
            } catch (err) {
              api.logger.error(`Plan approval error: ${err}`);
            }
          })();
        } else {
          // Still interviewing — run audit (which transitions to plan_review)
          void runPlanAudit(
            { api, linearApi, pluginConfig },
            planSession,
          ).catch((err) => api.logger.error(`Plan audit error: ${err}`));
        }
        break;
      }

      case "plan_abandon": {
        if (!isPlanning || !planSession) {
          api.logger.info("Comment intent plan_abandon but not in planning mode — ignoring");
          break;
        }
        void (async () => {
          try {
            await endPlanningSession(planSession.projectId, "abandoned", planStatePath);
            await createCommentWithDedup(linearApi,
              planSession.rootIssueId,
              `Planning mode ended for **${planSession.projectName}**. Session abandoned.`,
            );
            api.logger.info(`Planning: session abandoned for ${planSession.projectName}`);
          } catch (err) {
            api.logger.error(`Plan abandon error: ${err}`);
          }
        })();
        break;
      }

      case "plan_continue": {
        if (!isPlanning || !planSession) {
          // Not in planning mode — treat as general
          const planContinueAgent = getIssueAffinity(issue.id) ?? resolveAgentId(api);
          api.logger.info(`Comment intent plan_continue but not in planning mode — dispatching to ${planContinueAgent}`);
          void dispatchCommentToAgent(api, linearApi, profiles, planContinueAgent, issue, comment, commentBody, commentor, pluginConfig)
            .catch((err) => api.logger.error(`Comment dispatch error: ${err}`));
          break;
        }
        void handlePlannerTurn(
          { api, linearApi, pluginConfig },
          planSession,
          { issueId: issue.id, commentBody, commentorName: commentor },
        ).catch((err) => api.logger.error(`Planner turn error: ${err}`));
        break;
      }

      case "ask_agent": {
        const targetAgent = intentResult.agentId ?? resolveAgentId(api);
        api.logger.info(`Comment intent ask_agent: routing to ${targetAgent}`);
        void dispatchCommentToAgent(api, linearApi, profiles, targetAgent, issue, comment, commentBody, commentor, pluginConfig)
          .catch((err) => api.logger.error(`Comment dispatch error: ${err}`));
        break;
      }

      case "request_work":
      case "question": {
        const defaultAgent = getIssueAffinity(issue.id) ?? resolveAgentId(api);
        api.logger.info(`Comment intent ${intentResult.intent}: routing to ${defaultAgent}`);
        void dispatchCommentToAgent(api, linearApi, profiles, defaultAgent, issue, comment, commentBody, commentor, pluginConfig)
          .catch((err) => api.logger.error(`Comment dispatch error: ${err}`));
        break;
      }

      case "close_issue": {
        const closeAgent = getIssueAffinity(issue.id) ?? resolveAgentId(api);
        api.logger.info(`Comment intent close_issue: closing ${issue.identifier ?? issue.id} via ${closeAgent}`);
        void handleCloseIssue(api, linearApi, profiles, closeAgent, issue, comment, commentBody, commentor, pluginConfig)
          .catch((err) => api.logger.error(`Close issue error: ${err}`));
        break;
      }

      case "general":
      default:
        api.logger.info(`Comment intent general: no action taken for ${issue.identifier ?? issue.id}`);
        break;
    }

    return true;
  }

  // ── Issue.update — handle assignment/delegation to app user ──────
  if (payload.type === "Issue" && payload.action === "update") {
    res.statusCode = 200;
    res.end("ok");

    const issue = payload.data;

    // Guard: check activeRuns FIRST (synchronous, O(1)) before any async work.
    // Linear can send duplicate Issue.update webhooks <20ms apart for the same
    // assignment change. Without this sync guard, both pass through the async
    // getViewerId() call before either registers with wasRecentlyProcessed().
    if (activeRuns.has(issue?.id)) {
      api.logger.info(`Issue.update ${issue?.identifier ?? issue?.id}: active run — skipping`);
      return true;
    }

    const updatedFrom = payload.updatedFrom ?? {};

    // Check both assigneeId and delegateId — Linear uses delegateId for agent delegation
    const assigneeId = issue?.assigneeId;
    const prevAssigneeId = updatedFrom.assigneeId;
    const delegateId = issue?.delegateId;
    const prevDelegateId = updatedFrom.delegateId;

    api.logger.info(`Issue.update ${issue?.identifier ?? issue?.id}: assigneeId=${assigneeId} prev=${prevAssigneeId} delegateId=${delegateId} prevDelegate=${prevDelegateId}`);

    // Check if either assignee or delegate changed to our app user
    const assigneeChanged = assigneeId && assigneeId !== prevAssigneeId;
    const delegateChanged = delegateId && delegateId !== prevDelegateId;

    if (!assigneeChanged && !delegateChanged) {
      api.logger.info("Issue.update: no assignment/delegation change, ignoring");
      return true;
    }

    const linearApi = createLinearApi(api);
    if (!linearApi) {
      api.logger.error("No Linear access token — cannot process issue update");
      return true;
    }

    const viewerId = await linearApi.getViewerId();
    const isAssignedToUs = assigneeChanged && assigneeId === viewerId;
    const isDelegatedToUs = delegateChanged && delegateId === viewerId;

    if (!isAssignedToUs && !isDelegatedToUs) {
      api.logger.info(`Issue.update: assignee=${assigneeId} delegate=${delegateId}, not us (${viewerId}), ignoring`);
      return true;
    }

    const trigger = isDelegatedToUs ? "delegated" : "assigned";
    api.logger.info(`Issue ${trigger} to our app user (${viewerId}), executing pipeline`);

    // Secondary dedup: catch duplicate webhooks that both passed the activeRuns
    // check before either could register (belt-and-suspenders with the sync guard).
    const dedupKey = `${trigger}:${issue.id}:${viewerId}`;
    if (wasRecentlyProcessed(dedupKey)) {
      api.logger.info(`${trigger} ${issue.id} -> ${viewerId} already processed — skipping`);
      return true;
    }

    // Assignment triggers the full dispatch pipeline:
    // tier assessment → worktree → plan → implement → audit
    void handleDispatch(api, linearApi, issue).catch((err) => {
      api.logger.error(`Dispatch pipeline error for ${issue.identifier ?? issue.id}: ${err}`);
    });

    return true;
  }

  // ── Issue.create — auto-triage new issues ───────────────────────
  if (payload.type === "Issue" && payload.action === "create") {
    res.statusCode = 200;
    res.end("ok");

    const issue = payload.data;
    if (!issue?.id) {
      api.logger.error("Issue.create missing issue data");
      return true;
    }

    // Dedup
    if (wasRecentlyProcessed(`issue-create:${issue.id}`)) {
      api.logger.info(`Issue.create ${issue.id} already processed — skipping`);
      return true;
    }

    api.logger.info(`Issue.create: ${issue.identifier ?? issue.id} — ${issue.title ?? "(untitled)"}`);

    const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
    const linearApi = createLinearApi(api);
    if (!linearApi) {
      api.logger.error("No Linear access token — cannot triage new issue");
      return true;
    }

    const agentId = resolveAgentId(api);

    // Guard: prevent duplicate runs on same issue (also blocks AgentSessionEvent
    // webhooks that arrive from sessions we create during triage)
    if (activeRuns.has(issue.id)) {
      api.logger.info(`Issue.create: ${issue.identifier ?? issue.id} already has active run — skipping triage`);
      return true;
    }
    activeRuns.add(issue.id);

    // Dispatch triage (non-blocking)
    void (async () => {
      const profiles = loadAgentProfiles();
      const defaultProfile = Object.entries(profiles).find(([, p]) => p.isDefault);
      const label = defaultProfile?.[1]?.label ?? profiles[agentId]?.label ?? agentId;
      const avatarUrl = defaultProfile?.[1]?.avatarUrl ?? profiles[agentId]?.avatarUrl;
      let agentSessionId: string | null = null;

      try {
        // Fetch enriched issue + team labels
        let enrichedIssue: any = issue;
        let teamLabels: Array<{ id: string; name: string }> = [];
        try {
          enrichedIssue = await linearApi.getIssueDetails(issue.id);
          if (enrichedIssue?.team?.id) {
            teamLabels = await linearApi.getTeamLabels(enrichedIssue.team.id);
          }
        } catch (err) {
          api.logger.warn(`Could not fetch issue details for triage: ${err}`);
        }

        // Skip triage for issues in projects that are actively being planned —
        // the planner creates issues and triage would overwrite its estimates/labels.
        const triageProjectId = enrichedIssue?.project?.id;
        if (triageProjectId) {
          const planStatePath = pluginConfig?.planningStatePath as string | undefined;
          try {
            const planState = await readPlanningState(planStatePath);
            if (isInPlanningMode(planState, triageProjectId)) {
              api.logger.info(`Issue.create: ${issue.identifier ?? issue.id} belongs to project in planning mode — skipping triage`);
              return;
            }
          } catch { /* proceed with triage if planning state check fails */ }
        }

        // Skip triage for issues created by our own bot user
        const viewerId = await linearApi.getViewerId();
        if (viewerId && issue.creatorId === viewerId) {
          api.logger.info(`Issue.create: ${issue.identifier ?? issue.id} created by our bot — skipping triage`);
          return;
        }

        const description = enrichedIssue?.description ?? issue?.description ?? "(no description)";
        const estimationType = enrichedIssue?.team?.issueEstimationType ?? "fibonacci";
        const currentLabels = enrichedIssue?.labels?.nodes ?? [];
        const currentLabelNames = currentLabels.map((l: any) => l.name).join(", ") || "None";
        const availableLabelList = teamLabels.map((l) => `  - "${l.name}" (id: ${l.id})`).join("\n");

        // Create agent session
        const sessionResult = await linearApi.createSessionOnIssue(issue.id);
        agentSessionId = sessionResult.sessionId;
        if (agentSessionId) {
          wasRecentlyProcessed(`session:${agentSessionId}`);
          api.logger.info(`Created agent session ${agentSessionId} for Issue.create triage`);
          setActiveSession({
            agentSessionId,
            issueIdentifier: enrichedIssue?.identifier ?? issue.identifier ?? issue.id,
            issueId: issue.id,
            agentId,
            startedAt: Date.now(),
          });
        }

        if (agentSessionId) {
          await linearApi.emitActivity(agentSessionId, {
            type: "thought",
            body: `${label} is triaging new issue ${enrichedIssue?.identifier ?? issue.id}...`,
          }).catch(() => {});
        }

        if (agentSessionId) {
          await linearApi.emitActivity(agentSessionId, {
            type: "action",
            action: "Triaging",
            parameter: `${enrichedIssue?.identifier ?? issue.id} — estimating, labeling`,
          }).catch(() => {});
        }

        const creatorName = enrichedIssue?.creator?.name ?? "Unknown";
        const creatorEmail = enrichedIssue?.creator?.email ?? null;
        const creatorLine = creatorEmail
          ? `**Created by:** ${creatorName} (${creatorEmail})`
          : `**Created by:** ${creatorName}`;

        // Look up cached guidance for triage
        const triageTeamId = enrichedIssue?.team?.id ?? issue?.team?.id;
        const triageGuidance = triageTeamId ? getCachedGuidanceForTeam(triageTeamId) : null;
        const triageGuidanceAppendix = isGuidanceEnabled(pluginConfig as Record<string, unknown> | undefined, triageTeamId)
          ? formatGuidanceAppendix(triageGuidance)
          : "";

        const message = [
          `IMPORTANT: You are triaging a new Linear issue. You MUST respond with a JSON block containing your triage decisions, followed by your assessment as plain text.`,
          ``,
          `## Issue: ${enrichedIssue?.identifier ?? issue.identifier ?? issue.id} — ${enrichedIssue?.title ?? issue.title ?? "(untitled)"}`,
          `**Status:** ${enrichedIssue?.state?.name ?? "Unknown"} | **Current Estimate:** ${enrichedIssue?.estimate ?? "None"} | **Current Labels:** ${currentLabelNames}`,
          creatorLine,
          ``,
          `**Description:**`,
          description,
          ``,
          `## Your Triage Tasks`,
          ``,
          `1. **Story Points** — Estimate complexity using ${estimationType} scale (1=trivial, 2=small, 3=medium, 5=large, 8=very large, 13=epic)`,
          `2. **Labels** — Select appropriate labels from the team's available labels`,
          `3. **Priority** — Set priority (1=Urgent, 2=High, 3=Medium, 4=Low) if not already set`,
          `4. **Assessment** — Brief analysis of what this issue needs`,
          ``,
          `## Available Labels`,
          availableLabelList || "  (no labels configured)",
          ``,
          `## Response Format`,
          ``,
          `You MUST start your response with a JSON block, then follow with your assessment:`,
          ``,
          '```json',
          `{`,
          `  "estimate": <number>,`,
          `  "labelIds": ["<id1>", "<id2>"],`,
          `  "priority": <number or null>,`,
          `  "assessment": "<one-line summary of your sizing rationale>"`,
          `}`,
          '```',
          ``,
          `IMPORTANT: Only reference real users from the issue data above. Do NOT fabricate or guess user names, emails, or identities. The issue creator is shown in the "Created by" field.`,
          ``,
          `Then write your full assessment as markdown below the JSON block.`,
          triageGuidanceAppendix,
        ].filter(Boolean).join("\n");

        const sessionId = `linear-triage-${issue.id}-${Date.now()}`;
        const { runAgent } = await import("../agent/agent.js");
        const result = await runAgent({
          api,
          agentId,
          sessionId,
          message,
          timeoutMs: 3 * 60_000,
          streaming: agentSessionId ? { linearApi, agentSessionId } : undefined,
          // Triage is strictly read-only: the agent can read/search the
          // codebase but all write-capable tools are denied via config
          // policy.  The only artifacts are a Linear comment + issue updates.
          readOnly: true,
        });

        const responseBody = result.success
          ? result.output
          : `Something went wrong while triaging this issue. You may need to set the estimate and labels manually.`;

        // Parse triage JSON and apply to issue
        let commentBody = responseBody;
        if (result.success) {
          const jsonMatch = responseBody.match(/```json\s*\n?([\s\S]*?)\n?```/);
          if (jsonMatch) {
            try {
              const triage = JSON.parse(jsonMatch[1]);
              const updateInput: Record<string, unknown> = {};

              if (typeof triage.estimate === "number") {
                updateInput.estimate = triage.estimate;
              }
              if (Array.isArray(triage.labelIds) && triage.labelIds.length > 0) {
                const existingIds = currentLabels.map((l: any) => l.id);
                const allIds = [...new Set([...existingIds, ...triage.labelIds])];
                updateInput.labelIds = allIds;
              }
              if (typeof triage.priority === "number" && triage.priority >= 1 && triage.priority <= 4) {
                updateInput.priority = triage.priority;
              }

              if (Object.keys(updateInput).length > 0) {
                await linearApi.updateIssue(issue.id, updateInput);
                api.logger.info(`Applied triage to ${enrichedIssue?.identifier ?? issue.id}: ${JSON.stringify(updateInput)}`);

                if (agentSessionId) {
                  await linearApi.emitActivity(agentSessionId, {
                    type: "action",
                    action: "Applied triage",
                    result: `estimate=${triage.estimate ?? "unchanged"}, labels=${triage.labelIds?.length ?? 0}, priority=${triage.priority ?? "unchanged"}`,
                  }).catch(() => {});
                }
              }

              // Strip JSON block from comment
              commentBody = responseBody.replace(/```json\s*\n?[\s\S]*?\n?```\s*\n?/, "").trim();
            } catch (parseErr) {
              api.logger.warn(`Could not parse triage JSON: ${parseErr}`);
            }
          }
        }

        // When a session exists, prefer emitActivity (avoids duplicate comment).
        // Otherwise, post as a regular comment.
        if (agentSessionId) {
          const labeledComment = `**[${label}]** ${commentBody}`;
          const emitted = await linearApi.emitActivity(agentSessionId, {
            type: "response",
            body: labeledComment,
          }).then(() => true).catch(() => false);

          if (!emitted) {
            const agentOpts = avatarUrl
              ? { createAsUser: label, displayIconUrl: avatarUrl }
              : undefined;
            await postAgentComment(api, linearApi, issue.id, commentBody, label, agentOpts);
          }
        } else {
          const agentOpts = avatarUrl
            ? { createAsUser: label, displayIconUrl: avatarUrl }
            : undefined;
          await postAgentComment(api, linearApi, issue.id, commentBody, label, agentOpts);
        }

        api.logger.info(`Triage complete for ${enrichedIssue?.identifier ?? issue.id}`);
      } catch (err) {
        api.logger.error(`Issue.create triage error: ${err}`);
        if (agentSessionId) {
          await linearApi.emitActivity(agentSessionId, {
            type: "error",
            body: `Failed to triage: ${String(err).slice(0, 500)}`,
          }).catch(() => {});
        }
      } finally {
        clearActiveSession(issue.id);
        activeRuns.delete(issue.id);
      }
    })();

    return true;
  }

  // ── Default: log unhandled webhook types for debugging ──────────
  api.logger.warn(`Unhandled webhook type=${payload.type} action=${payload.action} — payload: ${JSON.stringify(payload).slice(0, 500)}`);
  res.statusCode = 200;
  res.end("ok");
  return true;
}

// ── Comment dispatch helper ───────────────────────────────────────
//
// Dispatches a comment to a specific agent. Used by intent-based routing
// and @mention fast path.

async function dispatchCommentToAgent(
  api: OpenClawPluginApi,
  linearApi: LinearAgentApi,
  profiles: Record<string, AgentProfile>,
  agentId: string,
  issue: any,
  comment: any,
  commentBody: string,
  commentor: string,
  pluginConfig?: Record<string, unknown>,
): Promise<void> {
  const profile = profiles[agentId];
  const label = profile?.label ?? agentId;
  const avatarUrl = profile?.avatarUrl;

  // Guard: prevent concurrent runs on same issue
  if (activeRuns.has(issue.id)) {
    api.logger.info(`dispatchCommentToAgent: ${issue.identifier ?? issue.id} has active run — skipping`);
    return;
  }

  // Fetch full issue details
  let enrichedIssue: any = issue;
  try {
    enrichedIssue = await linearApi.getIssueDetails(issue.id);
  } catch (err) {
    api.logger.warn(`Could not fetch issue details: ${err}`);
  }

  const description = enrichedIssue?.description ?? issue?.description ?? "(no description)";
  const comments = enrichedIssue?.comments?.nodes ?? [];
  const commentSummary = comments
    .slice(-5)
    .map((c: any) => `**${c.user?.name ?? "Unknown"}**: ${(c.body ?? "").slice(0, 200)}`)
    .join("\n");

  // Look up cached guidance for this team (Comment webhooks don't carry guidance)
  const commentTeamId = enrichedIssue?.team?.id;
  const cachedGuidance = commentTeamId ? getCachedGuidanceForTeam(commentTeamId) : null;
  const commentGuidanceAppendix = isGuidanceEnabled(pluginConfig, commentTeamId)
    ? formatGuidanceAppendix(cachedGuidance)
    : "";

  const issueRef = enrichedIssue?.identifier ?? issue.identifier ?? issue.id;
  const stateType = enrichedIssue?.state?.type ?? "";
  const isTriaged = stateType === "started" || stateType === "completed" || stateType === "canceled";

  const toolAccessLines = isTriaged
    ? [
      `**Tool access:**`,
      `- \`linear_issues\` tool: Full access. Use action="read" with issueId="${issueRef}" to get details, action="create" to create issues (with parentIssueId to create sub-issues for granular work breakdown), action="update" with status/priority/labels/estimate to modify issues, action="comment" to post comments, action="list_states" to see available workflow states.`,
      `- \`code_run\`: Dispatch coding work to a worker. Workers return text — they cannot access linear_issues.`,
      `- Standard tools: exec, read, edit, write, web_search, etc.`,
      ``,
      `**Sub-issue guidance:** When a task is too large or has multiple distinct parts, break it into sub-issues using action="create" with parentIssueId="${issueRef}". Each sub-issue should be an atomic, independently testable unit of work with its own acceptance criteria. This enables parallel dispatch and clearer progress tracking.`,
    ]
    : [
      `**Tool access:**`,
      `- \`linear_issues\` tool: READ ONLY. Use action="read" with issueId="${issueRef}" to get details, action="list_states"/"list_labels" for metadata. Do NOT use action="update", action="create", or action="comment".`,
      `- \`code_run\`: Dispatch coding work to a worker. Workers return text — they cannot access linear_issues.`,
      `- Standard tools: exec, read, edit, write, web_search, etc.`,
    ];

  const roleLines = isTriaged
    ? [`**Your role:** Orchestrator with full Linear access. You can update issue fields, change status, and dispatch work via \`code_run\`. Do NOT post comments yourself — the handler posts your text output.`]
    : [`**Your role:** Dispatcher. For work requests, use \`code_run\`. You do NOT update issue status — the audit system handles lifecycle.`];

  const message = [
    `You are an orchestrator responding to a Linear comment. Your text output will be automatically posted as a comment on the issue (do NOT post a comment yourself — the handler does it).`,
    ``,
    ...toolAccessLines,
    ``,
    ...roleLines,
    ``,
    `## Issue: ${issueRef} — ${enrichedIssue?.title ?? issue.title ?? "(untitled)"}`,
    `**Status:** ${enrichedIssue?.state?.name ?? "Unknown"} | **Assignee:** ${enrichedIssue?.assignee?.name ?? "Unassigned"}`,
    enrichedIssue?.creator ? `**Created by:** ${enrichedIssue.creator.name}${enrichedIssue.creator.email ? ` (${enrichedIssue.creator.email})` : ""}` : "",
    ``,
    `**Description:**`,
    description,
    commentSummary ? `\n**Recent comments:**\n${commentSummary}` : "",
    `\n**${commentor} says:**\n> ${commentBody}`,
    ``,
    `IMPORTANT: Only reference real users from the issue data above. Do NOT fabricate or guess user names, emails, or identities.`,
    ``,
    `Respond concisely. For work requests, dispatch via \`code_run\` and summarize the result.`,
    commentGuidanceAppendix,
  ].filter(Boolean).join("\n");

  // Dispatch with session lifecycle
  activeRuns.add(issue.id);
  let agentSessionId: string | null = null;

  try {
    // Create agent session (non-fatal)
    const sessionResult = await linearApi.createSessionOnIssue(issue.id);
    agentSessionId = sessionResult.sessionId;
    if (agentSessionId) {
      wasRecentlyProcessed(`session:${agentSessionId}`);
      setActiveSession({
        agentSessionId,
        issueIdentifier: enrichedIssue?.identifier ?? issue.identifier ?? issue.id,
        issueId: issue.id,
        agentId,
        startedAt: Date.now(),
      });
    }

    // Emit thought
    if (agentSessionId) {
      await linearApi.emitActivity(agentSessionId, {
        type: "thought",
        body: `${label} is processing comment on ${issueRef}...`,
      }).catch(() => {});
    }

    // Run agent
    const sessionId = `linear-comment-${agentId}-${Date.now()}`;
    const { runAgent } = await import("../agent/agent.js");
    const result = await runAgent({
      api,
      agentId,
      sessionId,
      message,
      timeoutMs: 3 * 60_000,
      streaming: agentSessionId ? { linearApi, agentSessionId } : undefined,
    });

    const responseBody = result.success
      ? result.output
      : `Something went wrong while processing this. The system will retry automatically if possible.`;

    // When a session exists, prefer emitActivity (avoids duplicate comment).
    // Otherwise, post as a regular comment.
    if (agentSessionId) {
      const labeledResponse = `**[${label}]** ${responseBody}`;
      const emitted = await linearApi.emitActivity(agentSessionId, {
        type: "response",
        body: labeledResponse,
      }).then(() => true).catch(() => false);

      if (!emitted) {
        const agentOpts = avatarUrl
          ? { createAsUser: label, displayIconUrl: avatarUrl }
          : undefined;
        await postAgentComment(api, linearApi, issue.id, responseBody, label, agentOpts);
      }
    } else {
      const agentOpts = avatarUrl
        ? { createAsUser: label, displayIconUrl: avatarUrl }
        : undefined;
      await postAgentComment(api, linearApi, issue.id, responseBody, label, agentOpts);
    }

    api.logger.info(`Posted ${agentId} response to ${issueRef}`);
  } catch (err) {
    api.logger.error(`dispatchCommentToAgent error: ${err}`);
    if (agentSessionId) {
      await linearApi.emitActivity(agentSessionId, {
        type: "error",
        body: `Failed to process comment: ${String(err).slice(0, 500)}`,
      }).catch(() => {});
    }
  } finally {
    clearActiveSession(issue.id);
    activeRuns.delete(issue.id);
  }
}

// ── Close issue handler ──────────────────────────────────────────
//
// Triggered by close_issue intent. Generates a closure report via agent,
// transitions issue to completed state, and posts the report.

async function handleCloseIssue(
  api: OpenClawPluginApi,
  linearApi: LinearAgentApi,
  profiles: Record<string, AgentProfile>,
  agentId: string,
  issue: any,
  comment: any,
  commentBody: string,
  commentor: string,
  pluginConfig?: Record<string, unknown>,
): Promise<void> {
  const profile = profiles[agentId];
  const label = profile?.label ?? agentId;
  const avatarUrl = profile?.avatarUrl;

  if (activeRuns.has(issue.id)) {
    api.logger.info(`handleCloseIssue: ${issue.identifier ?? issue.id} has active run — skipping`);
    return;
  }

  // Fetch full issue details
  let enrichedIssue: any = issue;
  try {
    enrichedIssue = await linearApi.getIssueDetails(issue.id);
  } catch (err) {
    api.logger.warn(`Could not fetch issue details for close: ${err}`);
  }

  const issueRef = enrichedIssue?.identifier ?? issue.identifier ?? issue.id;
  const teamId = enrichedIssue?.team?.id ?? issue.team?.id;

  // Find completed state
  let completedStateId: string | null = null;
  if (teamId) {
    try {
      const states = await linearApi.getTeamStates(teamId);
      const completedState = states.find((s: any) => s.type === "completed");
      if (completedState) completedStateId = completedState.id;
    } catch (err) {
      api.logger.warn(`Could not fetch team states for close: ${err}`);
    }
  }

  // Build closure report prompt
  const description = enrichedIssue?.description ?? issue?.description ?? "(no description)";
  const comments = enrichedIssue?.comments?.nodes ?? [];
  const commentSummary = comments
    .slice(-10)
    .map((c: any) => `**${c.user?.name ?? "Unknown"}**: ${(c.body ?? "").slice(0, 300)}`)
    .join("\n");

  // Look up cached guidance
  const closeGuidance = teamId ? getCachedGuidanceForTeam(teamId) : null;
  const closeGuidanceAppendix = isGuidanceEnabled(pluginConfig, teamId)
    ? formatGuidanceAppendix(closeGuidance)
    : "";

  const message = [
    `You are writing a closure report for a Linear issue that is being marked as done.`,
    `Your text output will be posted as the closing comment on the issue.`,
    ``,
    `## Issue: ${issueRef} — ${enrichedIssue?.title ?? issue.title ?? "(untitled)"}`,
    `**Status:** ${enrichedIssue?.state?.name ?? "Unknown"} | **Assignee:** ${enrichedIssue?.assignee?.name ?? "Unassigned"}`,
    enrichedIssue?.creator ? `**Created by:** ${enrichedIssue.creator.name}${enrichedIssue.creator.email ? ` (${enrichedIssue.creator.email})` : ""}` : "",
    ``,
    `**Description:**`,
    description,
    commentSummary ? `\n**Comment history:**\n${commentSummary}` : "",
    `\n**${commentor} says (closure request):**\n> ${commentBody}`,
    ``,
    `IMPORTANT: Only reference real users from the issue data above. Do NOT fabricate or guess user names, emails, or identities.`,
    ``,
    `Write a concise closure report with:`,
    `- **Summary**: What was done (1-2 sentences)`,
    `- **Resolution**: How it was resolved`,
    `- **Notes**: Any follow-up items or caveats (if applicable)`,
    ``,
    `Keep it brief and factual. Use markdown formatting.`,
    closeGuidanceAppendix,
  ].filter(Boolean).join("\n");

  // Execute with session lifecycle
  activeRuns.add(issue.id);
  let agentSessionId: string | null = null;

  try {
    const sessionResult = await linearApi.createSessionOnIssue(issue.id);
    agentSessionId = sessionResult.sessionId;
    if (agentSessionId) {
      wasRecentlyProcessed(`session:${agentSessionId}`);
      setActiveSession({
        agentSessionId,
        issueIdentifier: issueRef,
        issueId: issue.id,
        agentId,
        startedAt: Date.now(),
      });
    }

    if (agentSessionId) {
      await linearApi.emitActivity(agentSessionId, {
        type: "thought",
        body: `${label} is preparing closure report for ${issueRef}...`,
      }).catch(() => {});
    }

    // Run agent for closure report
    const { runAgent } = await import("../agent/agent.js");
    const result = await runAgent({
      api,
      agentId,
      sessionId: `linear-close-${agentId}-${Date.now()}`,
      message,
      timeoutMs: 2 * 60_000,
      readOnly: true,
    });

    if (!result.success) {
      api.logger.error(`Closure report agent failed for ${issueRef}: ${(result.output ?? "no output").slice(0, 500)}`);
    }

    const closureReport = result.success
      ? result.output
      : `Issue closed by ${commentor}.\n\n> ${commentBody}\n\n*Closure report generation failed — agent returned: ${(result.output ?? "no output").slice(0, 200)}*`;

    const fullReport = `## Closure Report\n\n${closureReport}`;

    // Transition issue to completed state
    if (completedStateId) {
      try {
        await linearApi.updateIssue(issue.id, { stateId: completedStateId });
        api.logger.info(`Closed issue ${issueRef} (state → completed)`);
      } catch (err) {
        api.logger.error(`Failed to transition issue ${issueRef} to completed: ${err}`);
      }
    } else {
      api.logger.warn(`No completed state found for ${issueRef} — posting report without state change`);
    }

    // Post closure report via emitActivity-first pattern
    if (agentSessionId) {
      const labeledReport = `**[${label}]** ${fullReport}`;
      const emitted = await linearApi.emitActivity(agentSessionId, {
        type: "response",
        body: labeledReport,
      }).then(() => true).catch(() => false);

      if (!emitted) {
        const agentOpts = avatarUrl
          ? { createAsUser: label, displayIconUrl: avatarUrl }
          : undefined;
        await postAgentComment(api, linearApi, issue.id, fullReport, label, agentOpts);
      }
    } else {
      const agentOpts = avatarUrl
        ? { createAsUser: label, displayIconUrl: avatarUrl }
        : undefined;
      await postAgentComment(api, linearApi, issue.id, fullReport, label, agentOpts);
    }

    api.logger.info(`Posted closure report for ${issueRef}`);
  } catch (err) {
    api.logger.error(`handleCloseIssue error: ${err}`);
    if (agentSessionId) {
      await linearApi.emitActivity(agentSessionId, {
        type: "error",
        body: `Failed to close issue: ${String(err).slice(0, 500)}`,
      }).catch(() => {});
    }
  } finally {
    clearActiveSession(issue.id);
    activeRuns.delete(issue.id);
  }
}

// ── @dispatch handler ─────────────────────────────────────────────
//
// Triggered by `@dispatch` in a Linear comment. Assesses issue complexity,
// creates a persistent worktree, registers the dispatch in state, and
// launches the pipeline (plan → implement → audit).

async function handleDispatch(
  api: OpenClawPluginApi,
  linearApi: LinearAgentApi,
  issue: any,
): Promise<void> {
  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
  const statePath = pluginConfig?.dispatchStatePath as string | undefined;
  const worktreeBaseDir = pluginConfig?.worktreeBaseDir as string | undefined;
  const baseRepo = (pluginConfig?.codexBaseRepo as string) ?? join(process.env.HOME ?? homedir(), "ai-workspace");
  const identifier = issue.identifier ?? issue.id;

  api.logger.info(`@dispatch: processing ${identifier}`);

  // 0. Check planning mode — prevent dispatch for issues in planning-mode projects
  try {
    const enrichedForPlan = await linearApi.getIssueDetails(issue.id ?? issue);
    const planProjectId = enrichedForPlan?.project?.id;
    if (planProjectId) {
      const planStatePath = pluginConfig?.planningStatePath as string | undefined;
      const planState = await readPlanningState(planStatePath);
      if (isInPlanningMode(planState, planProjectId)) {
        api.logger.info(`dispatch: ${identifier} is in planning-mode project — skipping`);
        await createCommentWithDedup(linearApi,
          issue.id,
          `**Can't dispatch yet** — this project is in planning mode.\n\n**To continue:** Comment on the planning issue with your requirements, then say **"finalize plan"** when ready.\n\n**To cancel planning:** Comment **"abandon"** on the planning issue.`,
        );
        return;
      }
    }
  } catch (err) {
    api.logger.warn(`dispatch: planning mode check failed for ${identifier}: ${err}`);
  }

  // 1. Check for existing active dispatch — reclaim if stale
  const STALE_DISPATCH_MS = 30 * 60_000; // 30 min without a gateway holding it = stale
  const state = await readDispatchState(statePath);
  const existing = getActiveDispatch(state, identifier);
  if (existing) {
    const ageMs = Date.now() - new Date(existing.dispatchedAt).getTime();
    const isStale = ageMs > STALE_DISPATCH_MS;
    const inMemory = activeRuns.has(issue.id);

    if (!isStale && inMemory) {
      // Truly still running in this gateway process
      api.logger.info(`dispatch: ${identifier} actively running (status: ${existing.status}, age: ${Math.round(ageMs / 1000)}s) — skipping`);
      await createCommentWithDedup(linearApi,
        issue.id,
        `**Already running** as **${existing.tier}** — status: **${existing.status}**, started ${Math.round(ageMs / 60_000)}m ago.\n\nWorktree: \`${existing.worktreePath}\`\n\n**Options:**\n- Check progress: \`/dispatch status ${identifier}\`\n- Force restart: \`/dispatch retry ${identifier}\` (only works when stuck)\n- Escalate: \`/dispatch escalate ${identifier} "reason"\``,
      );
      return;
    }

    // Stale or not in memory (gateway restarted) — reclaim
    api.logger.info(
      `dispatch: ${identifier} reclaiming stale dispatch (status: ${existing.status}, ` +
      `age: ${Math.round(ageMs / 1000)}s, inMemory: ${inMemory}, stale: ${isStale})`,
    );
    await removeActiveDispatch(identifier, statePath);
    activeRuns.delete(issue.id);
  }

  // 2. Prevent concurrent runs on same issue
  if (activeRuns.has(issue.id)) {
    api.logger.info(`@dispatch: ${identifier} has active agent run — skipping`);
    return;
  }

  // 3. Fetch full issue details for tier assessment
  let enrichedIssue: any;
  try {
    enrichedIssue = await linearApi.getIssueDetails(issue.id);
  } catch (err) {
    api.logger.error(`@dispatch: failed to fetch issue details: ${err}`);
    enrichedIssue = issue;
  }

  const labels = enrichedIssue.labels?.nodes?.map((l: any) => l.name) ?? [];
  const commentCount = enrichedIssue.comments?.nodes?.length ?? 0;

  // Resolve repos for this dispatch (issue body markers, labels, or config default)
  const repoResolution = resolveRepos(enrichedIssue.description, labels, pluginConfig);

  // 4. Assess complexity tier
  const assessment = await assessTier(api, {
    identifier,
    title: enrichedIssue.title ?? "(untitled)",
    description: enrichedIssue.description,
    labels,
    commentCount,
  });

  api.logger.info(`@dispatch: ${identifier} assessed as ${assessment.tier} (${assessment.model}) — ${assessment.reasoning}`);
  emitDiagnostic(api, {
    event: "dispatch_started",
    identifier,
    tier: assessment.tier,
    issueId: issue.id,
    agentId: resolveAgentId(api),
  });

  // 5. Create persistent worktree(s)
  let worktreePath: string;
  let worktreeBranch: string;
  let worktreeResumed: boolean;
  let worktrees: Array<{ repoName: string; path: string; branch: string }> | undefined;

  try {
    if (isMultiRepo(repoResolution)) {
      const multi = createMultiWorktree(identifier, repoResolution.repos, { baseDir: worktreeBaseDir });
      worktreePath = multi.parentPath;
      worktreeBranch = `codex/${identifier}`;
      worktreeResumed = multi.worktrees.some(w => w.resumed);
      worktrees = multi.worktrees.map(w => ({ repoName: w.repoName, path: w.path, branch: w.branch }));
      api.logger.info(`@dispatch: multi-repo worktrees ${worktreeResumed ? "resumed" : "created"} at ${worktreePath} (${repoResolution.repos.map(r => r.name).join(", ")})`);
    } else {
      const single = createWorktree(identifier, { baseRepo, baseDir: worktreeBaseDir });
      worktreePath = single.path;
      worktreeBranch = single.branch;
      worktreeResumed = single.resumed;
      api.logger.info(`@dispatch: worktree ${worktreeResumed ? "resumed" : "created"} at ${worktreePath}`);
    }
  } catch (err) {
    api.logger.error(`@dispatch: worktree creation failed: ${err}`);
    await createCommentWithDedup(linearApi,
      issue.id,
      `**Dispatch failed** — couldn't create the worktree.\n\n> ${String(err).slice(0, 200)}\n\n**What to try:**\n- Check that the base repo exists\n- Re-assign this issue to try again\n- Check logs: \`journalctl --user -u openclaw-gateway --since "5 min ago"\``,
    );
    return;
  }

  // 5b. Prepare workspace(s)
  if (worktrees) {
    for (const wt of worktrees) {
      const prep = prepareWorkspace(wt.path, wt.branch);
      if (prep.errors.length > 0) {
        api.logger.warn(`@dispatch: workspace prep for ${wt.repoName} had errors: ${prep.errors.join("; ")}`);
      }
    }
  } else {
    const prep = prepareWorkspace(worktreePath, worktreeBranch);
    if (prep.errors.length > 0) {
      api.logger.warn(`@dispatch: workspace prep had errors: ${prep.errors.join("; ")}`);
    } else {
      api.logger.info(`@dispatch: workspace prepared — pulled=${prep.pulled}, submodules=${prep.submodulesInitialized}`);
    }
  }

  // 6. Create agent session on Linear
  // Mark active BEFORE session creation so that any AgentSessionEvent.created
  // webhook arriving from this call is blocked by the activeRuns guard.
  activeRuns.add(issue.id);
  let agentSessionId: string | undefined;
  try {
    const sessionResult = await linearApi.createSessionOnIssue(issue.id);
    agentSessionId = sessionResult.sessionId ?? undefined;
  } catch (err) {
    api.logger.warn(`@dispatch: could not create agent session: ${err}`);
  }

  // 6b. Initialize .claw/ artifact directory
  try {
    ensureClawDir(worktreePath);
    writeManifest(worktreePath, {
      issueIdentifier: identifier,
      issueTitle: enrichedIssue.title ?? "(untitled)",
      issueId: issue.id,
      tier: assessment.tier,
      model: assessment.model,
      dispatchedAt: new Date().toISOString(),
      worktreePath,
      branch: worktreeBranch,
      attempts: 0,
      status: "dispatched",
      plugin: "openclaw-linear",
    });
  } catch (err) {
    api.logger.warn(`@dispatch: .claw/ init failed: ${err}`);
  }

  // 7. Register dispatch in persistent state
  const now = new Date().toISOString();
  await registerDispatch(identifier, {
    issueId: issue.id,
    issueIdentifier: identifier,
    issueTitle: enrichedIssue.title ?? "(untitled)",
    worktreePath,
    branch: worktreeBranch,
    tier: assessment.tier,
    model: assessment.model,
    status: "dispatched",
    dispatchedAt: now,
    agentSessionId,
    attempt: 0,
    project: enrichedIssue?.project?.id,
    worktrees,
  }, statePath);

  // 8. Register active session for tool resolution
  setActiveSession({
    agentSessionId: agentSessionId ?? "",
    issueIdentifier: identifier,
    issueId: issue.id,
    agentId: resolveAgentId(api),
    startedAt: Date.now(),
  });

  // 9. Post dispatch confirmation comment
  const worktreeDesc = worktrees
    ? worktrees.map(wt => `\`${wt.repoName}\`: \`${wt.path}\``).join("\n")
    : `\`${worktreePath}\``;
  const statusComment = [
    `**Dispatched** as **${assessment.tier}** (${assessment.model})`,
    `> ${assessment.reasoning}`,
    ``,
    worktrees
      ? `Worktrees ${worktreeResumed ? "(resumed)" : "(fresh)"}:\n${worktreeDesc}`
      : `Worktree: ${worktreeDesc} ${worktreeResumed ? "(resumed)" : "(fresh)"}`,
    `Branch: \`${worktreeBranch}\``,
    ``,
    `**Status:** Worker is starting now. An independent audit runs automatically after implementation.`,
    ``,
    `**While you wait:**`,
    `- Check progress: \`/dispatch status ${identifier}\``,
    `- Cancel: \`/dispatch escalate ${identifier} "reason"\``,
    `- All dispatches: \`/dispatch list\``,
  ].join("\n");

  await createCommentWithDedup(linearApi, issue.id, statusComment);

  if (agentSessionId) {
    await linearApi.emitActivity(agentSessionId, {
      type: "thought",
      body: `Dispatching ${identifier} as ${assessment.tier}...`,
    }).catch(() => {});
  }

  // 10. Apply tier label (best effort)
  try {
    if (enrichedIssue.team?.id) {
      const teamLabels = await linearApi.getTeamLabels(enrichedIssue.team.id);
      const tierLabel = teamLabels.find((l: any) => l.name === `developer:${assessment.tier}`);
      if (tierLabel) {
        const currentLabelIds = enrichedIssue.labels?.nodes?.map((l: any) => l.id) ?? [];
        await linearApi.updateIssue(issue.id, {
          labelIds: [...currentLabelIds, tierLabel.id],
        });
      }
    }
  } catch (err) {
    api.logger.warn(`@dispatch: could not apply tier label: ${err}`);
  }

  // 11. Run v2 pipeline: worker → audit → verdict (non-blocking)
  // (activeRuns already set in step 6 above)

  // Instantiate notifier (Discord, Slack, or both — config-driven)
  const notify: NotifyFn = createNotifierFromConfig(pluginConfig, api.runtime, api);

  const hookCtx: HookContext = {
    api,
    linearApi,
    notify,
    pluginConfig,
    configPath: statePath,
  };

  // Re-read dispatch to get fresh state after registration
  const freshState = await readDispatchState(statePath);
  const dispatch = getActiveDispatch(freshState, identifier)!;

  await notify("dispatch", {
    identifier,
    title: enrichedIssue.title ?? "(untitled)",
    status: "dispatched",
  });

  // spawnWorker handles: dispatched→working→auditing→done/rework/stuck
  spawnWorker(hookCtx, dispatch)
    .catch(async (err) => {
      api.logger.error(`@dispatch: pipeline v2 failed for ${identifier}: ${err}`);
      await updateDispatchStatus(identifier, "failed", statePath);
      // Write memory for failed dispatches so they're searchable in dispatch history
      try {
        const wsDir = resolveOrchestratorWorkspace(api, pluginConfig);
        writeDispatchMemory(identifier, `Pipeline failed: ${String(err).slice(0, 500)}`, wsDir, {
          title: enrichedIssue.title ?? identifier,
          tier: assessment.tier,
          status: "failed",
          project: enrichedIssue?.project?.id,
          attempts: 1,
          model: assessment.model,
        });
      } catch { /* best effort */ }
    })
    .finally(() => {
      activeRuns.delete(issue.id);
      clearActiveSession(issue.id);
    });
}
