import { execFileSync } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerLinearProvider } from "./src/auth.js";
import { registerCli } from "./src/cli.js";
import { createLinearTools } from "./src/tools.js";
import { handleLinearWebhook } from "./src/webhook.js";
import { handleOAuthCallback } from "./src/oauth-callback.js";
import { LinearAgentApi, resolveLinearToken } from "./src/linear-api.js";
import { createDispatchService } from "./src/dispatch-service.js";
import { readDispatchState, lookupSessionMapping, getActiveDispatch } from "./src/dispatch-state.js";
import { triggerAudit, processVerdict, type HookContext } from "./src/pipeline.js";
import { createDiscordNotifier, createNoopNotifier, type NotifyFn } from "./src/notify.js";

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

  // ---------------------------------------------------------------------------
  // Dispatch pipeline v2: notifier + agent_end lifecycle hook
  // ---------------------------------------------------------------------------

  // Instantiate notifier (Discord if configured, otherwise noop)
  const discordBotToken = (() => {
    try {
      const config = JSON.parse(
        require("node:fs").readFileSync(
          require("node:path").join(process.env.HOME ?? "/home/claw", ".openclaw", "openclaw.json"),
          "utf8",
        ),
      );
      return config?.channels?.discord?.token as string | undefined;
    } catch { return undefined; }
  })();
  const flowDiscordChannel = pluginConfig?.flowDiscordChannel as string | undefined;

  const notify: NotifyFn = (discordBotToken && flowDiscordChannel)
    ? createDiscordNotifier(discordBotToken, flowDiscordChannel)
    : createNoopNotifier();

  if (flowDiscordChannel && discordBotToken) {
    api.logger.info(`Linear dispatch: Discord notifications enabled (channel: ${flowDiscordChannel})`);
  }

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
  const cliBins: [string, string, string][] = [
    ["codex", "/home/claw/.npm-global/bin/codex", "npm install -g @openai/codex"],
    ["claude", "/home/claw/.npm-global/bin/claude", "npm install -g @anthropic-ai/claude-code"],
    ["gemini", "/home/claw/.npm-global/bin/gemini", "npm install -g @anthropic-ai/gemini-cli"],
  ];
  for (const [name, bin, installCmd] of cliBins) {
    try {
      const raw = execFileSync(bin, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, CLAUDECODE: undefined } as any,
      }).trim();
      cliChecks[name] = raw || "unknown";
    } catch {
      cliChecks[name] = "not found";
      api.logger.warn(
        `${name} CLI not found at ${bin}. The ${name}_run tool will fail. Install with: ${installCmd}`,
      );
    }
  }

  const agentId = (pluginConfig?.defaultAgentId as string) ?? "default";
  const orchestration = pluginConfig?.enableOrchestration !== false ? "enabled" : "disabled";
  const cliSummary = Object.entries(cliChecks).map(([k, v]) => `${k}: ${v}`).join(", ");
  api.logger.info(
    `Linear agent extension registered (agent: ${agentId}, token: ${tokenInfo.source !== "none" ? `${tokenInfo.source}` : "missing"}, ${cliSummary}, orchestration: ${orchestration})`,
  );
}
