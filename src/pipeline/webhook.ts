import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { LinearAgentApi, resolveLinearToken } from "../api/linear-api.js";
import { spawnWorker, type HookContext } from "./pipeline.js";
import { setActiveSession, clearActiveSession } from "./active-session.js";
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

// ── Agent profiles (loaded from config, no hardcoded names) ───────
interface AgentProfile {
  label: string;
  mission: string;
  mentionAliases: string[];
  appAliases?: string[];
  isDefault?: boolean;
  avatarUrl?: string;
}

const PROFILES_PATH = join(process.env.HOME ?? "/home/claw", ".openclaw", "agent-profiles.json");

function loadAgentProfiles(): Record<string, AgentProfile> {
  try {
    const raw = readFileSync(PROFILES_PATH, "utf8");
    return JSON.parse(raw).agents ?? {};
  } catch {
    return {};
  }
}

function buildMentionPattern(profiles: Record<string, AgentProfile>): RegExp | null {
  // Collect mentionAliases from ALL agents (including default).
  // appAliases are excluded — those trigger AgentSessionEvent instead.
  const aliases: string[] = [];
  for (const [, profile] of Object.entries(profiles)) {
    aliases.push(...profile.mentionAliases);
  }
  if (aliases.length === 0) return null;
  // Escape regex special chars in aliases, join with |
  const escaped = aliases.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`@(${escaped.join("|")})`, "gi");
}

function resolveAgentFromAlias(alias: string, profiles: Record<string, AgentProfile>): { agentId: string; label: string } | null {
  const lower = alias.toLowerCase();
  for (const [agentId, profile] of Object.entries(profiles)) {
    if (profile.mentionAliases.some(a => a.toLowerCase() === lower)) {
      return { agentId, label: profile.label };
    }
  }
  return null;
}

// Track issues with active agent runs to prevent concurrent duplicate runs.
const activeRuns = new Set<string>();

// Dedup: track recently processed keys to avoid double-handling
const recentlyProcessed = new Map<string, number>();
function wasRecentlyProcessed(key: string): boolean {
  const now = Date.now();
  // Clean old entries
  for (const [k, ts] of recentlyProcessed) {
    if (now - ts > 60_000) recentlyProcessed.delete(k);
  }
  if (recentlyProcessed.has(key)) return true;
  recentlyProcessed.set(key, now);
  return false;
}

async function readJsonBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: any; error?: string }>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        resolve({ ok: false, error: "payload too large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ ok: true, value: JSON.parse(raw) });
      } catch {
        resolve({ ok: false, error: "invalid json" });
      }
    });
  });
}

function createLinearApi(api: OpenClawPluginApi): LinearAgentApi | null {
  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
  const resolved = resolveLinearToken(pluginConfig);

  if (!resolved.accessToken) return null;

  const clientId = (pluginConfig?.clientId as string) ?? process.env.LINEAR_CLIENT_ID;
  const clientSecret = (pluginConfig?.clientSecret as string) ?? process.env.LINEAR_CLIENT_SECRET;

  return new LinearAgentApi(resolved.accessToken, {
    refreshToken: resolved.refreshToken,
    expiresAt: resolved.expiresAt,
    clientId: clientId ?? undefined,
    clientSecret: clientSecret ?? undefined,
  });
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
  // Debug: log full payload structure for diagnosing webhook types
  const payloadKeys = Object.keys(payload).join(", ");
  api.logger.info(`Linear webhook received: type=${payload.type} action=${payload.action} keys=[${payloadKeys}]`);
  emitDiagnostic(api, { event: "webhook_received", webhookType: payload.type, webhookAction: payload.action });


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

    // Dedup: skip if we already handled this session
    if (wasRecentlyProcessed(`session:${session.id}`)) {
      api.logger.info(`AgentSession ${session.id} already handled — skipping`);
      return true;
    }

    const linearApi = createLinearApi(api);
    if (!linearApi) {
      api.logger.error("No Linear access token configured");
      return true;
    }

    const agentId = resolveAgentId(api);
    const previousComments = payload.previousComments ?? [];
    const guidance = payload.guidance;

    api.logger.info(`AgentSession created: ${session.id} for issue ${issue?.identifier ?? issue?.id} (comments: ${previousComments.length}, guidance: ${guidance ? "yes" : "no"})`);

    // Guard: skip if an agent run is already active for this issue
    if (activeRuns.has(issue.id)) {
      api.logger.info(`Agent already running for ${issue?.identifier ?? issue?.id} — skipping session ${session.id}`);
      return true;
    }

    // Extract the user's latest message from previousComments
    // The last comment is the most recent user message
    const lastComment = previousComments.length > 0
      ? previousComments[previousComments.length - 1]
      : null;
    const userMessage = lastComment?.body ?? guidance ?? "";

    // Fetch full issue details
    let enrichedIssue: any = issue;
    try {
      enrichedIssue = await linearApi.getIssueDetails(issue.id);
    } catch (err) {
      api.logger.warn(`Could not fetch issue details: ${err}`);
    }

    const description = enrichedIssue?.description ?? issue?.description ?? "(no description)";

    // Build conversation context from previous comments
    const commentContext = previousComments
      .slice(-5)
      .map((c: any) => `**${c.user?.name ?? c.actorName ?? "User"}**: ${(c.body ?? "").slice(0, 300)}`)
      .join("\n\n");

    const issueRef = enrichedIssue?.identifier ?? issue.identifier ?? issue.id;
    const message = [
      `You are an orchestrator responding in a Linear issue session. Your text output will be posted as activities visible to the user.`,
      ``,
      `**Tool access:**`,
      `- \`linearis\` CLI: READ ONLY. You can read issues (\`linearis issues read ${issueRef}\`), list issues (\`linearis issues list\`), and search (\`linearis issues search "..."\`). Do NOT use linearis to update, close, comment, or modify issues.`,
      `- \`code_run\`: Dispatch coding work to a worker. Workers return text — they cannot access linearis.`,
      `- \`spawn_agent\`/\`ask_agent\`: Delegate to other crew agents.`,
      `- Standard tools: exec, read, edit, write, web_search, etc.`,
      ``,
      `**Your role:** You are the dispatcher. For any coding or implementation work, use \`code_run\` to dispatch it. Workers return text output. You summarize results. You do NOT update issue status or post linearis comments — the audit system handles lifecycle transitions.`,
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
          body: `Processing request for ${enrichedIssue?.identifier ?? issue.id}...`,
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

        // Post as comment
        const avatarUrl = defaultProfile?.[1]?.avatarUrl ?? profiles[agentId]?.avatarUrl;
        const brandingOpts = avatarUrl
          ? { createAsUser: label, displayIconUrl: avatarUrl }
          : undefined;

        try {
          if (brandingOpts) {
            await linearApi.createComment(issue.id, responseBody, brandingOpts);
          } else {
            await linearApi.createComment(issue.id, `**[${label}]** ${responseBody}`);
          }
        } catch (brandErr) {
          api.logger.warn(`Branded comment failed: ${brandErr}`);
          await linearApi.createComment(issue.id, `**[${label}]** ${responseBody}`);
        }

        // Emit response (closes session)
        const truncated = responseBody.length > 2000
          ? responseBody.slice(0, 2000) + "\u2026"
          : responseBody;
        await linearApi.emitActivity(session.id, {
          type: "response",
          body: truncated,
        }).catch(() => {});

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

    // Extract user message from the activity or prompt context
    const promptContext = payload.promptContext;
    const userMessage =
      activity?.content?.body ??
      activity?.body ??
      promptContext?.message ??
      promptContext ??
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

    api.logger.info(`AgentSession prompted (follow-up): ${session.id} issue=${issue?.identifier ?? issue?.id} message="${userMessage.slice(0, 80)}..."`);

    const agentId = resolveAgentId(api);

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

      // Build context from recent comments
      const recentComments = enrichedIssue?.comments?.nodes ?? [];
      const commentContext = recentComments
        .slice(-5)
        .map((c: any) => `**${c.user?.name ?? "User"}**: ${(c.body ?? "").slice(0, 300)}`)
        .join("\n\n");

      const followUpIssueRef = enrichedIssue?.identifier ?? issue.identifier ?? issue.id;
      const message = [
        `You are an orchestrator responding in a Linear issue session. Your text output will be posted as activities visible to the user.`,
        ``,
        `**Tool access:**`,
        `- \`linearis\` CLI: READ ONLY. You can read issues (\`linearis issues read ${followUpIssueRef}\`), list, and search. Do NOT use linearis to update, close, comment, or modify issues.`,
        `- \`code_run\`: Dispatch coding work to a worker. Workers return text — they cannot access linearis.`,
        `- \`spawn_agent\`/\`ask_agent\`: Delegate to other crew agents.`,
        `- Standard tools: exec, read, edit, write, web_search, etc.`,
        ``,
        `**Your role:** Dispatcher. For work requests, use \`code_run\`. You do NOT update issue status — the audit system handles lifecycle.`,
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
          body: `Processing follow-up for ${enrichedIssue?.identifier ?? issue.id}...`,
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

        const avatarUrl = defaultProfile?.[1]?.avatarUrl ?? profiles[agentId]?.avatarUrl;
        const brandingOpts = avatarUrl
          ? { createAsUser: label, displayIconUrl: avatarUrl }
          : undefined;

        try {
          if (brandingOpts) {
            await linearApi.createComment(issue.id, responseBody, brandingOpts);
          } else {
            await linearApi.createComment(issue.id, `**[${label}]** ${responseBody}`);
          }
        } catch (brandErr) {
          api.logger.warn(`Branded comment failed: ${brandErr}`);
          await linearApi.createComment(issue.id, `**[${label}]** ${responseBody}`);
        }

        const truncated = responseBody.length > 2000
          ? responseBody.slice(0, 2000) + "\u2026"
          : responseBody;
        await linearApi.emitActivity(session.id, {
          type: "response",
          body: truncated,
        }).catch(() => {});

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
    const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;

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
              await linearApi.createComment(
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
            await linearApi.createComment(
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
          api.logger.info("Comment intent plan_continue but not in planning mode — dispatching to default agent");
          void dispatchCommentToAgent(api, linearApi, profiles, resolveAgentId(api), issue, comment, commentBody, commentor, pluginConfig)
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
        const defaultAgent = resolveAgentId(api);
        api.logger.info(`Comment intent ${intentResult.intent}: routing to default agent ${defaultAgent}`);
        void dispatchCommentToAgent(api, linearApi, profiles, defaultAgent, issue, comment, commentBody, commentor, pluginConfig)
          .catch((err) => api.logger.error(`Comment dispatch error: ${err}`));
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

    // Dedup on assignment/delegation
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
            body: `Triaging new issue ${enrichedIssue?.identifier ?? issue.id}...`,
          }).catch(() => {});
        }

        if (agentSessionId) {
          await linearApi.emitActivity(agentSessionId, {
            type: "action",
            action: "Triaging",
            parameter: `${enrichedIssue?.identifier ?? issue.id} — estimating, labeling`,
          }).catch(() => {});
        }

        const message = [
          `IMPORTANT: You are triaging a new Linear issue. You MUST respond with a JSON block containing your triage decisions, followed by your assessment as plain text.`,
          ``,
          `## Issue: ${enrichedIssue?.identifier ?? issue.identifier ?? issue.id} — ${enrichedIssue?.title ?? issue.title ?? "(untitled)"}`,
          `**Status:** ${enrichedIssue?.state?.name ?? "Unknown"} | **Current Estimate:** ${enrichedIssue?.estimate ?? "None"} | **Current Labels:** ${currentLabelNames}`,
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
          `Then write your full assessment as markdown below the JSON block.`,
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

        // Post branded triage comment
        const brandingOpts = avatarUrl
          ? { createAsUser: label, displayIconUrl: avatarUrl }
          : undefined;

        try {
          if (brandingOpts) {
            await linearApi.createComment(issue.id, commentBody, brandingOpts);
          } else {
            await linearApi.createComment(issue.id, `**[${label}]** ${commentBody}`);
          }
        } catch (brandErr) {
          api.logger.warn(`Branded comment failed, falling back to prefix: ${brandErr}`);
          await linearApi.createComment(issue.id, `**[${label}]** ${commentBody}`);
        }

        if (agentSessionId) {
          const truncated = commentBody.length > 2000
            ? commentBody.slice(0, 2000) + "…"
            : commentBody;
          await linearApi.emitActivity(agentSessionId, {
            type: "response",
            body: truncated,
          }).catch(() => {});
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

  const issueRef = enrichedIssue?.identifier ?? issue.identifier ?? issue.id;
  const message = [
    `You are an orchestrator responding to a Linear comment. Your text output will be automatically posted as a comment on the issue (do NOT post a comment yourself — the handler does it).`,
    ``,
    `**Tool access:**`,
    `- \`linearis\` CLI: READ ONLY. You can read issues (\`linearis issues read ${issueRef}\`), list, and search. Do NOT use linearis to update, close, comment, or modify issues.`,
    `- \`code_run\`: Dispatch coding work to a worker. Workers return text — they cannot access linearis.`,
    `- Standard tools: exec, read, edit, write, web_search, etc.`,
    ``,
    `**Your role:** Dispatcher. For work requests, use \`code_run\`. You do NOT update issue status — the audit system handles lifecycle.`,
    ``,
    `## Issue: ${issueRef} — ${enrichedIssue?.title ?? issue.title ?? "(untitled)"}`,
    `**Status:** ${enrichedIssue?.state?.name ?? "Unknown"} | **Assignee:** ${enrichedIssue?.assignee?.name ?? "Unassigned"}`,
    ``,
    `**Description:**`,
    description,
    commentSummary ? `\n**Recent comments:**\n${commentSummary}` : "",
    `\n**${commentor} says:**\n> ${commentBody}`,
    ``,
    `Respond concisely. For work requests, dispatch via \`code_run\` and summarize the result.`,
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
        body: `Processing comment on ${issueRef}...`,
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

    // Post branded comment
    const brandingOpts = avatarUrl
      ? { createAsUser: label, displayIconUrl: avatarUrl }
      : undefined;

    try {
      if (brandingOpts) {
        await linearApi.createComment(issue.id, responseBody, brandingOpts);
      } else {
        await linearApi.createComment(issue.id, `**[${label}]** ${responseBody}`);
      }
    } catch (brandErr) {
      api.logger.warn(`Branded comment failed, falling back to prefix: ${brandErr}`);
      await linearApi.createComment(issue.id, `**[${label}]** ${responseBody}`);
    }

    // Emit response (closes session)
    if (agentSessionId) {
      const truncated = responseBody.length > 2000
        ? responseBody.slice(0, 2000) + "…"
        : responseBody;
      await linearApi.emitActivity(agentSessionId, {
        type: "response",
        body: truncated,
      }).catch(() => {});
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
  const baseRepo = (pluginConfig?.codexBaseRepo as string) ?? "/home/claw/ai-workspace";
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
        await linearApi.createComment(
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
      await linearApi.createComment(
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
  emitDiagnostic(api, { event: "dispatch_started", identifier, tier: assessment.tier, issueId: issue.id });

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
    await linearApi.createComment(
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

  await linearApi.createComment(issue.id, statusComment);

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
