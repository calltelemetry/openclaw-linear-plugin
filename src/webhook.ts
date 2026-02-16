import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { LinearAgentApi, resolveLinearToken } from "./linear-api.js";
import { runFullPipeline, resumePipeline, type PipelineContext } from "./pipeline.js";

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

// Store active session plans so we can resume after user approval
const activeSessions = new Map<string, { plan: string; ctx: PipelineContext }>();

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


  // ── AppUserNotification — OAuth app webhook for agent mentions/assignments
  if (payload.type === "AppUserNotification") {
    res.statusCode = 200;
    res.end("ok");

    const notification = payload.notification;
    const notifType = notification?.type;
    api.logger.info(`AppUserNotification: ${notifType} appUserId=${payload.appUserId}`);

    const issue = notification?.issue;
    const comment = notification?.comment ?? notification?.parentComment;

    if (!issue?.id) {
      api.logger.error("AppUserNotification missing issue data");
      return true;
    }

    const linearApi = createLinearApi(api);
    if (!linearApi) {
      api.logger.error("No Linear access token — cannot process agent notification");
      return true;
    }

    const agentId = resolveAgentId(api);

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
      .map((c: any) => `  - **${c.user?.name ?? "Unknown"}**: ${c.body?.slice(0, 200)}`)
      .join("\n");

    const message = [
      `IMPORTANT: You are responding to a Linear issue notification. Your ENTIRE text output will be automatically posted as a comment on the issue. Do NOT attempt to post to Linear yourself — no tools, no CLI, no API calls. Just write your response as plain text/markdown.`,
      ``,
      `You were mentioned/assigned in a Linear issue. Respond naturally and helpfully.`,
      ``,
      `## Issue: ${enrichedIssue?.identifier ?? issue.id} — ${enrichedIssue?.title ?? issue.title ?? "(untitled)"}`,
      `**Status:** ${enrichedIssue?.state?.name ?? "Unknown"} | **Assignee:** ${enrichedIssue?.assignee?.name ?? "Unassigned"}`,
      ``,
      `**Description:**`,
      description,
      commentSummary ? `\n**Recent comments:**\n${commentSummary}` : "",
      comment?.body ? `\n**Triggering comment:**\n> ${comment.body}` : "",
      ``,
      `Respond concisely. If there's a task, explain what you'll do and do it.`,
    ].filter(Boolean).join("\n");

    // Dispatch agent with session lifecycle (non-blocking)
    void (async () => {
      const profiles = loadAgentProfiles();
      const defaultProfile = Object.entries(profiles).find(([, p]) => p.isDefault);
      const label = defaultProfile?.[1]?.label ?? profiles[agentId]?.label ?? agentId;
      const avatarUrl = defaultProfile?.[1]?.avatarUrl ?? profiles[agentId]?.avatarUrl;
      let agentSessionId: string | null = null;

      try {
        // 1. Create agent session (non-fatal)
        const sessionResult = await linearApi.createSessionOnIssue(issue.id);
        agentSessionId = sessionResult.sessionId;
        if (agentSessionId) {
          api.logger.info(`Created agent session ${agentSessionId} for notification`);
        } else {
          api.logger.warn(`Could not create agent session for notification: ${sessionResult.error ?? "unknown"}`);
        }

        // 2. Emit thought
        if (agentSessionId) {
          await linearApi.emitActivity(agentSessionId, {
            type: "thought",
            body: `Reviewing notification for ${enrichedIssue?.identifier ?? issue.id}...`,
          }).catch(() => {});
        }

        // 3. Emit action
        if (agentSessionId) {
          await linearApi.emitActivity(agentSessionId, {
            type: "action",
            action: "Processing notification",
            parameter: notifType ?? "unknown",
          }).catch(() => {});
        }

        // 4. Run agent
        const sessionId = `linear-notif-${notification?.type ?? "unknown"}-${Date.now()}`;
        const { runAgent } = await import("./agent.js");
        const result = await runAgent({
          api,
          agentId,
          sessionId,
          message,
          timeoutMs: 3 * 60_000,
        });

        const responseBody = result.success
          ? result.output
          : `I encountered an error processing this request. Please try again.`;

        // 5. Post branded comment (fallback to prefix)
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

        // 6. Emit response (closes session)
        if (agentSessionId) {
          const truncated = responseBody.length > 2000
            ? responseBody.slice(0, 2000) + "…"
            : responseBody;
          await linearApi.emitActivity(agentSessionId, {
            type: "response",
            body: truncated,
          }).catch(() => {});
        }

        api.logger.info(`Posted agent response to ${enrichedIssue?.identifier ?? issue.id}`);
      } catch (err) {
        api.logger.error(`AppUserNotification handler error: ${err}`);
        if (agentSessionId) {
          await linearApi.emitActivity(agentSessionId, {
            type: "error",
            body: `Failed to process notification: ${String(err).slice(0, 500)}`,
          }).catch(() => {});
        }
      }
    })();

    return true;
  }

  // ── AgentSessionEvent.created — start the pipeline ──────────────
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

    // Dedup: skip if we already handled this session (e.g. from Issue.update delegation)
    if (wasRecentlyProcessed(`session:${session.id}`)) {
      api.logger.info(`AgentSession ${session.id} already handled — skipping`);
      return true;
    }

    const linearApi = createLinearApi(api);
    if (!linearApi) {
      api.logger.error("No Linear access token configured — cannot start pipeline. Run OAuth flow or set LINEAR_ACCESS_TOKEN.");
      return true;
    }

    const agentId = resolveAgentId(api);

    const previousComments = payload.previousComments ?? [];
    const guidance = payload.guidance;

    api.logger.info(`AgentSession created: ${session.id} for issue ${issue?.identifier ?? issue?.id} (comments: ${previousComments.length}, guidance: ${guidance ? "yes" : "no"})`);

    const ctx: PipelineContext = {
      api,
      linearApi,
      agentSessionId: session.id,
      agentId,
      issue: {
        id: issue.id,
        identifier: issue.identifier ?? issue.id,
        title: issue.title ?? "(untitled)",
        description: issue.description,
      },
      promptContext: payload.promptContext ?? session.context,
    };

    // Run pipeline (non-blocking). Stage 1 emits first thought within 10s.
    void (async () => {
      const { runPlannerStage } = await import("./pipeline.js");
      const plan = await runPlannerStage(ctx).catch((err) => {
        api.logger.error(`Planner stage error: ${err}`);
        return null;
      });
      if (plan) {
        activeSessions.set(session.id, { plan, ctx });
      }
    })();

    return true;
  }

  // ── AgentSession.prompted — user replied (plan approval) ────────
  if (
    (payload.type === "AgentSessionEvent" && payload.action === "prompted") ||
    (payload.type === "AgentSession" && payload.action === "prompted")
  ) {
    res.statusCode = 200;
    res.end("ok");

    const session = payload.agentSession ?? payload.data;
    if (!session?.id) {
      api.logger.error("AgentSession.prompted missing session id");
      return true;
    }

    api.logger.info(`AgentSession prompted: ${session.id}`);

    const stored = activeSessions.get(session.id);
    if (!stored) {
      api.logger.warn(`No active session found for ${session.id} — may have been restarted`);

      // Try to reconstruct context from payload
      const linearApi = createLinearApi(api);
      const issue = session?.issue ?? payload.issue;
      if (!linearApi || !issue?.id) {
        api.logger.error("Cannot reconstruct pipeline context for prompted session");
        return true;
      }

      const agentId = resolveAgentId(api);

      // The user's reply is the prompt content — treat as approval with context
      const userReply = session.context?.prompt ?? session.context?.body ?? "";
      api.logger.info(`Prompted session ${session.id} — treating reply as new request`);

      const ctx: PipelineContext = {
        api,
        linearApi,
        agentSessionId: session.id,
        agentId,
        issue: {
          id: issue.id,
          identifier: issue.identifier ?? issue.id,
          title: issue.title ?? "(untitled)",
          description: issue.description,
        },
        promptContext: session.context,
      };

      // Start fresh pipeline since we lost the plan
      void runFullPipeline(ctx);
      return true;
    }

    // Resume with stored plan
    api.logger.info(`Resuming pipeline for session ${session.id}`);
    activeSessions.delete(session.id);

    void resumePipeline(stored.ctx, stored.plan);
    return true;
  }

  // ── Comment.create — @mention routing to agents ─────────────────
  if (payload.type === "Comment" && payload.action === "create") {
    res.statusCode = 200;
    res.end("ok");

    const comment = payload.data;
    const commentBody = comment?.body ?? "";
    const commentor = comment?.user?.name ?? "Unknown";
    const issue = comment?.issue ?? payload.issue;

    // Load agent profiles and build mention pattern dynamically.
    // Default agent (app mentions) is handled by AgentSessionEvent — never here.
    const profiles = loadAgentProfiles();
    const mentionPattern = buildMentionPattern(profiles);
    if (!mentionPattern) {
      api.logger.info("Comment webhook: no sub-agent profiles configured, ignoring");
      return true;
    }

    const matches = commentBody.match(mentionPattern);
    if (!matches || matches.length === 0) {
      api.logger.info("Comment webhook: no sub-agent mentions found, ignoring");
      return true;
    }

    const alias = matches[0].replace("@", "");
    const resolved = resolveAgentFromAlias(alias, profiles);
    if (!resolved) {
      api.logger.info(`Comment webhook: alias "${alias}" not found in profiles, ignoring`);
      return true;
    }

    const mentionedAgent = resolved.agentId;

    if (!issue?.id) {
      api.logger.error("Comment webhook: missing issue data");
      return true;
    }

    const linearApi = createLinearApi(api);
    if (!linearApi) {
      api.logger.error("No Linear access token — cannot process comment mention");
      return true;
    }

    // Dedup on comment ID — prevent processing same comment twice
    if (comment?.id && wasRecentlyProcessed(`comment:${comment.id}`)) {
      api.logger.info(`Comment ${comment.id} already processed — skipping`);
      return true;
    }

    api.logger.info(`Comment mention: @${mentionedAgent} on ${issue.identifier ?? issue.id} by ${commentor}`);

    // React with eyes to acknowledge the comment
    if (comment?.id) {
      linearApi.createReaction(comment.id, "eyes").catch(() => {});
    }

    // Fetch full issue details from Linear API for richer context
    let enrichedIssue = issue;
    let recentComments = "";
    try {
      const full = await linearApi.getIssueDetails(issue.id);
      enrichedIssue = { ...issue, ...full };
      // Include last few comments for context (excluding the triggering comment)
      const comments = full.comments?.nodes ?? [];
      const relevant = comments
        .filter((c: any) => c.body !== commentBody)
        .slice(-3)
        .map((c: any) => `  - **${c.user?.name ?? "Unknown"}**: ${c.body.slice(0, 200)}`)
        .join("\n");
      if (relevant) recentComments = `\n**Recent Comments:**\n${relevant}\n`;
    } catch (err) {
      api.logger.warn(`Could not fetch issue details: ${err}`);
    }

    const priority = ["No Priority", "Urgent (P1)", "High (P2)", "Medium (P3)", "Low (P4)"][enrichedIssue.priority] ?? "Unknown";
    const labels = enrichedIssue.labels?.nodes?.map((l: any) => l.name).join(", ") || "None";
    const state = enrichedIssue.state?.name ?? "Unknown";
    const assignee = enrichedIssue.assignee?.name ?? "Unassigned";

    const taskMessage = [
      `IMPORTANT: You are responding to a Linear issue comment. Your ENTIRE text output will be automatically posted as a comment on the issue. Do NOT attempt to post to Linear yourself — no tools, no CLI, no API calls. Just write your response as plain text/markdown.`,
      ``,
      `You were mentioned by name. Respond naturally and helpfully as a team member. Be concise, markdown-friendly. Do NOT use JSON or structured output.`,
      ``,
      `**Issue:** ${enrichedIssue.identifier ?? enrichedIssue.id} — ${enrichedIssue.title ?? "(untitled)"}`,
      `**Status:** ${state} | **Priority:** ${priority} | **Assignee:** ${assignee} | **Labels:** ${labels}`,
      `**URL:** ${enrichedIssue.url ?? "N/A"}`,
      ``,
      enrichedIssue.description ? `**Description:**\n${enrichedIssue.description}\n` : "",
      recentComments,
      `**${commentor} wrote:**`,
      `> ${commentBody}`,
      ``,
      `Respond to their message. Be concise and direct. If they're asking you to do work, explain what you'll do and do it.`,
    ].filter(Boolean).join("\n");

    // Dispatch to agent with full session lifecycle (non-blocking)
    void (async () => {
      const label = resolved.label;
      const profile = profiles[mentionedAgent];
      let agentSessionId: string | null = null;

      try {
        // 1. Create agent session (non-fatal if fails)
        const sessionResult = await linearApi.createSessionOnIssue(issue.id);
        agentSessionId = sessionResult.sessionId;
        if (agentSessionId) {
          api.logger.info(`Created agent session ${agentSessionId} for @${mentionedAgent}`);
        } else {
          api.logger.warn(`Could not create agent session for @${mentionedAgent}: ${sessionResult.error ?? "unknown"} — falling back to flat comment`);
        }

        // 2. Emit thought
        if (agentSessionId) {
          await linearApi.emitActivity(agentSessionId, {
            type: "thought",
            body: `Analyzing ${enrichedIssue.identifier ?? issue.id}...`,
          }).catch(() => {});
        }

        // 3. Emit action
        if (agentSessionId) {
          await linearApi.emitActivity(agentSessionId, {
            type: "action",
            action: "Processing mention",
            parameter: `@${alias} by ${commentor}`,
          }).catch(() => {});
        }

        // 4. Run agent subprocess
        const sessionId = `linear-comment-${comment.id ?? Date.now()}`;
        const { runAgent } = await import("./agent.js");
        const result = await runAgent({
          api,
          agentId: mentionedAgent,
          sessionId,
          message: taskMessage,
          timeoutMs: 3 * 60_000,
        });

        const responseBody = result.success
          ? result.output
          : `I encountered an error processing this request. Please try again or check the logs.`;

        // 5. Post branded comment (fall back to [Label] prefix if branding fails)
        const brandingOpts = profile?.avatarUrl
          ? { createAsUser: label, displayIconUrl: profile.avatarUrl }
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

        // 6. Emit response activity (closes the session)
        if (agentSessionId) {
          const truncated = responseBody.length > 2000
            ? responseBody.slice(0, 2000) + "\u2026"
            : responseBody;
          await linearApi.emitActivity(agentSessionId, {
            type: "response",
            body: truncated,
          }).catch(() => {});
        }

        api.logger.info(`Posted @${mentionedAgent} response to ${issue.identifier ?? issue.id}`);
      } catch (err) {
        api.logger.error(`Comment mention handler error: ${err}`);
        // 7. Emit error activity if session exists
        if (agentSessionId) {
          await linearApi.emitActivity(agentSessionId, {
            type: "error",
            body: `Failed to process mention: ${String(err).slice(0, 500)}`,
          }).catch(() => {});
        }
      }
    })();

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
    api.logger.info(`Issue ${trigger} to our app user (${viewerId}), processing`);

    // Dedup on assignment/delegation
    const dedupKey = `${trigger}:${issue.id}:${viewerId}`;
    if (wasRecentlyProcessed(dedupKey)) {
      api.logger.info(`${trigger} ${issue.id} -> ${viewerId} already processed — skipping`);
      return true;
    }

    const agentId = resolveAgentId(api);

    // Fetch full issue details + team labels for triage
    let enrichedIssue: any = issue;
    let teamLabels: Array<{ id: string; name: string }> = [];
    try {
      enrichedIssue = await linearApi.getIssueDetails(issue.id);
      if (enrichedIssue?.team?.id) {
        teamLabels = await linearApi.getTeamLabels(enrichedIssue.team.id);
      }
    } catch (err) {
      api.logger.warn(`Could not fetch issue details: ${err}`);
    }

    const description = enrichedIssue?.description ?? issue?.description ?? "(no description)";
    const comments = enrichedIssue?.comments?.nodes ?? [];
    const commentSummary = comments
      .slice(-5)
      .map((c: any) => `  - **${c.user?.name ?? "Unknown"}**: ${c.body?.slice(0, 200)}`)
      .join("\n");

    const estimationType = enrichedIssue?.team?.issueEstimationType ?? "fibonacci";
    const currentLabels = enrichedIssue?.labels?.nodes ?? [];
    const currentLabelNames = currentLabels.map((l: any) => l.name).join(", ") || "None";
    const availableLabelList = teamLabels.map((l) => `  - "${l.name}" (id: ${l.id})`).join("\n");

    const message = [
      `IMPORTANT: You are triaging a delegated Linear issue. You MUST respond with a JSON block containing your triage decisions, followed by your assessment as plain text.`,
      ``,
      `## Issue: ${enrichedIssue?.identifier ?? issue.identifier ?? issue.id} — ${enrichedIssue?.title ?? issue.title ?? "(untitled)"}`,
      `**Status:** ${enrichedIssue?.state?.name ?? "Unknown"} | **Current Estimate:** ${enrichedIssue?.estimate ?? "None"} | **Current Labels:** ${currentLabelNames}`,
      ``,
      `**Description:**`,
      description,
      commentSummary ? `\n**Recent comments:**\n${commentSummary}` : "",
      ``,
      `## Your Triage Tasks`,
      ``,
      `1. **Story Points** — Estimate complexity using ${estimationType} scale (1=trivial, 2=small, 3=medium, 5=large, 8=very large, 13=epic)`,
      `2. **Labels** — Select appropriate labels from the team's available labels`,
      `3. **Assessment** — Brief analysis of what this issue needs`,
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
      `  "assessment": "<one-line summary of your sizing rationale>"`,
      `}`,
      '```',
      ``,
      `Then write your full assessment as markdown below the JSON block.`,
    ].filter(Boolean).join("\n");

    // Dispatch agent with session lifecycle (non-blocking)
    void (async () => {
      const profiles = loadAgentProfiles();
      const defaultProfile = Object.entries(profiles).find(([, p]) => p.isDefault);
      const label = defaultProfile?.[1]?.label ?? profiles[agentId]?.label ?? agentId;
      const avatarUrl = defaultProfile?.[1]?.avatarUrl ?? profiles[agentId]?.avatarUrl;
      let agentSessionId: string | null = null;

      try {
        const sessionResult = await linearApi.createSessionOnIssue(issue.id);
        agentSessionId = sessionResult.sessionId;
        if (agentSessionId) {
          // Mark session as processed so AgentSessionEvent handler skips it
          wasRecentlyProcessed(`session:${agentSessionId}`);
          api.logger.info(`Created agent session ${agentSessionId} for ${trigger}`);
        } else {
          api.logger.warn(`Could not create agent session for assignment: ${sessionResult.error ?? "unknown"}`);
        }

        if (agentSessionId) {
          await linearApi.emitActivity(agentSessionId, {
            type: "thought",
            body: `Reviewing assigned issue ${enrichedIssue?.identifier ?? issue.id}...`,
          }).catch(() => {});
        }

        if (agentSessionId) {
          await linearApi.emitActivity(agentSessionId, {
            type: "action",
            action: "Triaging",
            parameter: `${enrichedIssue?.identifier ?? issue.id} — estimating, labeling, sizing`,
          }).catch(() => {});
        }

        const sessionId = `linear-assign-${issue.id}-${Date.now()}`;
        const { runAgent } = await import("./agent.js");
        const result = await runAgent({
          api,
          agentId,
          sessionId,
          message,
          timeoutMs: 3 * 60_000,
        });

        const responseBody = result.success
          ? result.output
          : `I encountered an error reviewing this assignment. Please try again.`;

        // Parse triage JSON from agent response and apply to issue
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
                // Merge with existing labels
                const existingIds = currentLabels.map((l: any) => l.id);
                const allIds = [...new Set([...existingIds, ...triage.labelIds])];
                updateInput.labelIds = allIds;
              }

              if (Object.keys(updateInput).length > 0) {
                await linearApi.updateIssue(issue.id, updateInput);
                api.logger.info(`Applied triage to ${enrichedIssue?.identifier ?? issue.id}: ${JSON.stringify(updateInput)}`);

                if (agentSessionId) {
                  await linearApi.emitActivity(agentSessionId, {
                    type: "action",
                    action: "Applied triage",
                    result: `estimate=${triage.estimate ?? "unchanged"}, labels=${triage.labelIds?.length ?? 0} added`,
                  }).catch(() => {});
                }
              }

              // Strip the JSON block from the comment — post only the assessment
              commentBody = responseBody.replace(/```json\s*\n?[\s\S]*?\n?```\s*\n?/, "").trim();
            } catch (parseErr) {
              api.logger.warn(`Could not parse triage JSON: ${parseErr}`);
            }
          }
        }

        // Post comment with assessment
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

        api.logger.info(`Posted assignment response to ${enrichedIssue?.identifier ?? issue.id}`);
      } catch (err) {
        api.logger.error(`Issue assignment handler error: ${err}`);
        if (agentSessionId) {
          await linearApi.emitActivity(agentSessionId, {
            type: "error",
            body: `Failed to process assignment: ${String(err).slice(0, 500)}`,
          }).catch(() => {});
        }
      }
    })();

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

    const linearApi = createLinearApi(api);
    if (!linearApi) {
      api.logger.error("No Linear access token — cannot triage new issue");
      return true;
    }

    const agentId = resolveAgentId(api);

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
        const { runAgent } = await import("./agent.js");
        const result = await runAgent({
          api,
          agentId,
          sessionId,
          message,
          timeoutMs: 3 * 60_000,
        });

        const responseBody = result.success
          ? result.output
          : `I encountered an error triaging this issue. Please triage manually.`;

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
