import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerLinearProvider } from "./src/api/auth.js";
import { registerCli } from "./src/infra/cli.js";
import { createLinearTools } from "./src/tools/tools.js";
import { handleLinearWebhook } from "./src/pipeline/webhook.js";
import { handleOAuthCallback } from "./src/api/oauth-callback.js";
import { LinearAgentApi, resolveLinearToken } from "./src/api/linear-api.js";
import { createDispatchService } from "./src/pipeline/dispatch-service.js";
import { registerDispatchMethods } from "./src/gateway/dispatch-methods.js";
import { readDispatchState, lookupSessionMapping, getActiveDispatch, transitionDispatch, type DispatchStatus } from "./src/pipeline/dispatch-state.js";
import { triggerAudit, processVerdict, type HookContext } from "./src/pipeline/pipeline.js";
import { createNotifierFromConfig, type NotifyFn } from "./src/infra/notify.js";
import { readPlanningState, setPlanningCache } from "./src/pipeline/planning-state.js";
import { createPlannerTools } from "./src/tools/planner-tools.js";
import { registerDispatchCommands } from "./src/infra/commands.js";
import { createDispatchHistoryTool } from "./src/tools/dispatch-history-tool.js";
import { readDispatchState as readStateForHook, listActiveDispatches as listActiveForHook } from "./src/pipeline/dispatch-state.js";

export default function register(api: OpenClawPluginApi) {
  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;

  // Check token availability (config → env → auth profile store)
  const tokenInfo = resolveLinearToken(pluginConfig);
  if (!tokenInfo.accessToken) {
    api.logger.warn(
      "Linear: no access token found. Options: (1) run OAuth flow, (2) set LINEAR_ACCESS_TOKEN env var, " +
      "(3) add accessToken to plugin config. Agent pipeline will not function without it.",
    );
  }

  // Register Linear as an auth provider (OAuth flow with agent scopes)
  registerLinearProvider(api);

  // Register CLI commands: openclaw openclaw-linear auth|status
  api.registerCli(({ program }) => registerCli(program as any, api), {
    commands: ["openclaw-linear"],
  });

  // Register Linear tools for the agent
  api.registerTool((ctx) => {
    return createLinearTools(api, ctx);
  });

  // Register planner tools (context injected at runtime via setActivePlannerContext)
  api.registerTool(() => createPlannerTools());

  // Register dispatch_history tool for agent context
  api.registerTool(() => createDispatchHistoryTool(api, pluginConfig));

  // Register zero-LLM slash commands for dispatch ops
  registerDispatchCommands(api);

  // Register Linear webhook handler on a dedicated route
  api.registerHttpRoute({
    path: "/linear/webhook",
    handler: async (req, res) => {
      await handleLinearWebhook(api, req, res);
    },
  });

  // Back-compat route so existing production webhook URLs keep working.
  api.registerHttpRoute({
    path: "/hooks/linear",
    handler: async (req, res) => {
      await handleLinearWebhook(api, req, res);
    },
  });

  // Register OAuth callback route
  api.registerHttpRoute({
    path: "/linear/oauth/callback",
    handler: async (req, res) => {
      await handleOAuthCallback(api, req, res);
    },
  });

  // Register dispatch monitor service (stale detection, session hydration, cleanup)
  api.registerService(createDispatchService(api));

  // Register dispatch gateway RPC methods (list, get, retry, escalate, cancel, stats)
  registerDispatchMethods(api);

  // Hydrate planning state on startup
  readPlanningState(pluginConfig?.planningStatePath as string | undefined).then((state) => {
    for (const session of Object.values(state.sessions)) {
      if (session.status === "interviewing" || session.status === "plan_review") {
        setPlanningCache(session);
        api.logger.info(`Planning: restored session for ${session.projectName} (${session.rootIdentifier})`);
      }
    }
  }).catch((err) => api.logger.warn(`Planning state hydration failed: ${err}`));

  // ---------------------------------------------------------------------------
  // Dispatch pipeline v2: notifier + agent_end lifecycle hook
  // ---------------------------------------------------------------------------

  // Instantiate notifier (Discord, Slack, or both — config-driven)
  const notify: NotifyFn = createNotifierFromConfig(pluginConfig, api.runtime, api);

  // Register agent_end hook — safety net for sessions_spawn sub-agents.
  // In the current implementation, the worker→audit→verdict flow runs inline
  // via spawnWorker() in pipeline.ts. This hook catches sessions_spawn agents
  // (future upgrade path) and serves as a recovery mechanism.
  api.on("agent_end", async (event: any, ctx: any) => {
    try {
      const sessionKey = ctx?.sessionKey ?? "";
      if (!sessionKey) return;

      const statePath = pluginConfig?.dispatchStatePath as string | undefined;
      const state = await readDispatchState(statePath);
      const mapping = lookupSessionMapping(state, sessionKey);
      if (!mapping) return; // Not a dispatch sub-agent

      const dispatch = getActiveDispatch(state, mapping.dispatchId);
      if (!dispatch) {
        api.logger.info(`agent_end: dispatch ${mapping.dispatchId} no longer active`);
        return;
      }

      // Stale event rejection — only process if attempt matches
      if (dispatch.attempt !== mapping.attempt) {
        api.logger.info(
          `agent_end: stale event for ${mapping.dispatchId} ` +
          `(event attempt=${mapping.attempt}, current=${dispatch.attempt})`
        );
        return;
      }

      // Create Linear API for hook context
      const tokenInfo = resolveLinearToken(pluginConfig);
      if (!tokenInfo.accessToken) {
        api.logger.error("agent_end: no Linear access token — cannot process dispatch event");
        return;
      }
      const linearApi = new LinearAgentApi(tokenInfo.accessToken, {
        refreshToken: tokenInfo.refreshToken,
        expiresAt: tokenInfo.expiresAt,
      });

      const hookCtx: HookContext = {
        api,
        linearApi,
        notify,
        pluginConfig,
        configPath: statePath,
      };

      // Extract output from event
      const output = typeof event?.output === "string"
        ? event.output
        : (event?.messages ?? [])
            .filter((m: any) => m?.role === "assistant")
            .map((m: any) => typeof m?.content === "string" ? m.content : "")
            .join("\n") || "";

      if (mapping.phase === "worker") {
        api.logger.info(`agent_end: worker completed for ${mapping.dispatchId} — triggering audit`);
        await triggerAudit(hookCtx, dispatch, {
          success: event?.success ?? true,
          output,
        }, sessionKey);
      } else if (mapping.phase === "audit") {
        api.logger.info(`agent_end: audit completed for ${mapping.dispatchId} — processing verdict`);
        await processVerdict(hookCtx, dispatch, {
          success: event?.success ?? true,
          output,
        }, sessionKey);
      }
    } catch (err) {
      api.logger.error(`agent_end hook error: ${err}`);
      // Escalate: mark dispatch as stuck so it's visible
      try {
        const statePath = pluginConfig?.dispatchStatePath as string | undefined;
        const state = await readDispatchState(statePath);
        const sessionKey = ctx?.sessionKey ?? "";
        const mapping = sessionKey ? lookupSessionMapping(state, sessionKey) : null;
        if (mapping) {
          const dispatch = getActiveDispatch(state, mapping.dispatchId);
          if (dispatch && dispatch.status !== "done" && dispatch.status !== "stuck" && dispatch.status !== "failed") {
            const stuckReason = `Hook error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
            await transitionDispatch(
              mapping.dispatchId,
              dispatch.status as DispatchStatus,
              "stuck",
              { stuckReason },
              statePath,
            );
            // Notify if possible
            await notify("escalation", {
              identifier: dispatch.issueIdentifier,
              title: dispatch.issueTitle ?? "Unknown",
              status: "stuck",
              reason: `Dispatch failed in ${mapping.phase} phase: ${stuckReason}`,
            }).catch(() => {}); // Don't fail on notification failure
          }
        }
      } catch (escalateErr) {
        api.logger.error(`agent_end escalation also failed: ${escalateErr}`);
      }
    }
  });

  // Inject recent dispatch history as context for worker/audit agents
  api.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      const sessionKey = ctx?.sessionKey ?? "";
      if (!sessionKey.startsWith("linear-worker-") && !sessionKey.startsWith("linear-audit-")) return;

      const statePath = pluginConfig?.dispatchStatePath as string | undefined;
      const state = await readStateForHook(statePath);
      const active = listActiveForHook(state);

      // Include up to 3 recent active dispatches as context
      const recent = active.slice(0, 3);
      if (recent.length === 0) return;

      const lines = recent.map(d =>
        `- **${d.issueIdentifier}** (${d.tier}): ${d.status}, attempt ${d.attempt}`
      );

      return {
        prependContext: `<dispatch-history>\nActive dispatches:\n${lines.join("\n")}\n</dispatch-history>\n\n`,
      };
    } catch {
      // Never block agent start for telemetry
    }
  });

  // Hard gate: prepend planning-only constraints to code_run when issue is not "started".
  // Even if the orchestrator LLM ignores scope rules, the coding agent receives hard constraints.
  api.on("before_tool_call", async (event: any, _ctx: any) => {
    if (event.toolName !== "code_run") return;

    const { getCurrentSession } = await import("./src/pipeline/active-session.js");
    const session = getCurrentSession();
    if (!session?.issueId) return; // Non-Linear context, allow

    // Check issue state
    const hookTokenInfo = resolveLinearToken(pluginConfig);
    if (!hookTokenInfo.accessToken) return;
    const hookLinearApi = new LinearAgentApi(hookTokenInfo.accessToken, {
      refreshToken: hookTokenInfo.refreshToken,
      expiresAt: hookTokenInfo.expiresAt,
    });

    try {
      const issue = await hookLinearApi.getIssueDetails(session.issueId);
      const stateType = issue?.state?.type ?? "";
      const isStarted = stateType === "started";

      if (!isStarted) {
        const constraint = [
          "CRITICAL CONSTRAINT — PLANNING MODE ONLY:",
          `This issue (${session.issueIdentifier}) is in "${issue?.state?.name ?? stateType}" state — NOT In Progress.`,
          "You may ONLY:",
          "- Read and explore files to understand the codebase",
          "- Write plan files (PLAN.md, notes, design outlines)",
          "- Search code to inform planning",
          "You MUST NOT:",
          "- Create, modify, or delete source code, config, or infrastructure files",
          "- Run system commands that change state (deploys, installs, migrations)",
          "- Make external API requests that modify data",
          "- Build, implement, or scaffold any application code",
          "Plan and explore ONLY. Do not implement anything.",
          "---",
        ].join("\n");

        const originalPrompt = event.params?.prompt ?? "";
        return {
          params: { ...event.params, prompt: `${constraint}\n${originalPrompt}` },
        };
      }
    } catch (err) {
      api.logger.warn(`before_tool_call: issue state check failed: ${err}`);
      // Don't block on failure — fall through to allow
    }
  });

  // Narration Guard: catch short "Let me explore..." responses that narrate intent
  // without actually calling tools, and append a warning for the user.
  const NARRATION_PATTERNS = [
    /let me (explore|look|investigate|check|dig|analyze|search|find|review|examine)/i,
    /i('ll| will) (explore|look into|investigate|check|dig into|analyze|search|find|review)/i,
    /let me (take a look|dive into|pull up|go through)/i,
  ];
  const MAX_SHORT_RESPONSE = 250;

  api.on("message_sending", (event: { content?: string }) => {
    const text = event?.content ?? "";
    if (!text || text.length > MAX_SHORT_RESPONSE) return {};
    const isNarration = NARRATION_PATTERNS.some((p) => p.test(text));
    if (!isNarration) return {};
    api.logger.warn(`Narration guard triggered: "${text.slice(0, 80)}..."`);
    return {
      content:
        text +
        "\n\n⚠️ _Agent acknowledged but may not have completed the task. Try asking again or rephrase your request._",
    };
  });

  // Check CLI availability (Codex, Claude, Gemini)
  const cliChecks: Record<string, string> = {};
  const defaultBinDir = join(process.env.HOME ?? homedir(), ".npm-global", "bin");
  const cliBins: [string, string, string][] = [
    ["codex", pluginConfig?.codexBin as string ?? join(defaultBinDir, "codex"), "npm install -g @openai/codex"],
    ["claude", pluginConfig?.claudeBin as string ?? join(defaultBinDir, "claude"), "npm install -g @anthropic-ai/claude-code"],
    ["gemini", pluginConfig?.geminiBin as string ?? join(defaultBinDir, "gemini"), "npm install -g @anthropic-ai/gemini-cli"],
  ];
  for (const [name, bin, installCmd] of cliBins) {
    try {
      const raw = execFileSync(bin, ["--version"], {
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, CLAUDECODE: undefined } as any,
      }).trim();
      cliChecks[name] = raw || "unknown";
    } catch {
      // Fallback: check if the file exists (execFileSync can fail in worker contexts)
      try {
        require("node:fs").accessSync(bin, require("node:fs").constants.X_OK);
        cliChecks[name] = "installed (version check skipped)";
      } catch {
        cliChecks[name] = "not found";
        api.logger.warn(
          `${name} CLI not found at ${bin}. The ${name}_run tool will fail. Install with: ${installCmd}`,
        );
      }
    }
  }

  const agentId = (pluginConfig?.defaultAgentId as string) ?? "default";
  const orchestration = pluginConfig?.enableOrchestration !== false ? "enabled" : "disabled";
  const cliSummary = Object.entries(cliChecks).map(([k, v]) => `${k}: ${v}`).join(", ");
  api.logger.info(
    `Linear agent extension registered (agent: ${agentId}, token: ${tokenInfo.source !== "none" ? `${tokenInfo.source}` : "missing"}, ${cliSummary}, orchestration: ${orchestration})`,
  );
}
