import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { getCurrentSession, getActiveSessionByAgentId } from "../pipeline/active-session.js";
import { runCodex } from "./codex-tool.js";
import { runClaude } from "./claude-tool.js";
import { runGemini } from "./gemini-tool.js";
import type { CliToolParams, CliResult, OnProgressUpdate } from "./cli-shared.js";
import { DEFAULT_BASE_REPO } from "./cli-shared.js";

export type CodingBackend = "claude" | "codex" | "gemini";

const BACKENDS: Record<CodingBackend, {
  label: string;
  toolName: string;
  runner: (api: OpenClawPluginApi, params: CliToolParams, pluginConfig?: Record<string, unknown>, onUpdate?: OnProgressUpdate) => Promise<CliResult>;
  description: string;
  configKeyTimeout: string;
  configKeyBaseRepo: string;
}> = {
  codex: {
    label: "Codex CLI (OpenAI)",
    toolName: "cli_codex",
    runner: runCodex,
    description:
      "Run OpenAI Codex CLI to perform a coding task. " +
      "Can read/write files, run commands, search code, run tests. " +
      "Streams progress to Linear in real-time.",
    configKeyTimeout: "codexTimeoutMs",
    configKeyBaseRepo: "codexBaseRepo",
  },
  claude: {
    label: "Claude Code (Anthropic)",
    toolName: "cli_claude",
    runner: runClaude,
    description:
      "Run Anthropic Claude Code CLI to perform a coding task. " +
      "Can read/write files, run commands, search code, run tests. " +
      "Streams progress to Linear in real-time.",
    configKeyTimeout: "claudeTimeoutMs",
    configKeyBaseRepo: "claudeBaseRepo",
  },
  gemini: {
    label: "Gemini CLI (Google)",
    toolName: "cli_gemini",
    runner: runGemini,
    description:
      "Run Google Gemini CLI to perform a coding task. " +
      "Can read/write files, run commands, search code, run tests. " +
      "Streams progress to Linear in real-time.",
    configKeyTimeout: "geminiTimeoutMs",
    configKeyBaseRepo: "geminiBaseRepo",
  },
};

export interface CodingToolsConfig {
  codingTool?: string;
  agentCodingTools?: Record<string, string>;
  backends?: Record<string, { aliases?: string[] }>;
}

/**
 * Load coding tool config from the plugin's coding-tools.json file.
 * Falls back to empty config if the file doesn't exist or is invalid.
 */
export function loadCodingConfig(): CodingToolsConfig {
  try {
    const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const raw = readFileSync(join(pluginRoot, "coding-tools.json"), "utf8");
    return JSON.parse(raw) as CodingToolsConfig;
  } catch {
    return {};
  }
}

/**
 * Resolve which coding backend to use for a given agent.
 *
 * Priority:
 *   1. Per-agent override: config.agentCodingTools[agentId]
 *   2. Global default: config.codingTool
 *   3. Hardcoded fallback: "codex"
 */
export function resolveCodingBackend(
  config: CodingToolsConfig,
  agentId?: string,
): CodingBackend {
  if (agentId) {
    const override = config.agentCodingTools?.[agentId];
    if (override && override in BACKENDS) return override as CodingBackend;
  }
  const global = config.codingTool;
  if (global && global in BACKENDS) return global as CodingBackend;
  return "codex";
}

/**
 * Resolve the tool name (cli_codex, cli_claude, cli_gemini) for a given agent.
 */
export function resolveToolName(config: CodingToolsConfig, agentId?: string): string {
  return BACKENDS[resolveCodingBackend(config, agentId)].toolName;
}

/**
 * Parse a session key to extract channel routing info for progress messages.
 */
function parseChannelTarget(sessionKey?: string): {
  provider: string;
  peerId: string;
} | null {
  if (!sessionKey) return null;
  const parts = sessionKey.split(":");
  if (parts.length < 5 || parts[0] !== "agent") return null;
  const provider = parts[2];
  const kind = parts[3];
  if (!provider || !kind) return null;
  const peerId = parts[4];
  if (!peerId) return null;
  return { provider, peerId };
}

/**
 * Create a channel sender that can send messages to the session's channel.
 */
function createChannelSender(
  api: OpenClawPluginApi,
  sessionKey?: string,
): ((text: string) => Promise<void>) | null {
  const target = parseChannelTarget(sessionKey);
  if (!target) return null;
  const { provider, peerId } = target;

  // 2026.4 dropped runtime.channel.<discord|telegram>.sendMessage* in favor of
  // a capability-grouped channel runtime. Fall back to the gateway CLI for
  // out-of-band progress messages — this path is low-frequency (one call per
  // CLI tool run) so the subprocess cost is acceptable.
  if (provider === "discord" || provider === "telegram") {
    return async (text: string) => {
      await new Promise<void>((resolve) => {
        execFile(
          "openclaw",
          ["message", "send", "--channel", provider, "--target", peerId, "--message", text, "--json"],
          { timeout: 30_000 },
          (err) => {
            if (err) api.logger.warn(`cli channel send (${provider}) failed: ${err.message}`);
            resolve();
          },
        );
      });
    };
  }
  return null;
}

/**
 * Inject Linear session info into tool params so backend runners can emit
 * activities to the correct Linear agent session.
 */
function injectSessionInfo(
  params: CliToolParams,
  ctx: OpenClawPluginToolContext,
): void {
  const ctxAgentId = ctx.agentId;
  const activeSession = getCurrentSession()
    ?? (ctxAgentId ? getActiveSessionByAgentId(ctxAgentId) : null);

  if (activeSession) {
    if (!params.agentSessionId) (params as any).agentSessionId = activeSession.agentSessionId;
    if (!params.issueId) (params as any).issueId = activeSession.issueId;
    if (!params.issueIdentifier) (params as any).issueIdentifier = activeSession.issueIdentifier;
  }
}

/**
 * Create the three coding CLI tools: cli_codex, cli_claude, cli_gemini.
 *
 * Each tool directly invokes its backend CLI. The tool name shown in Linear
 * reflects which CLI is running (e.g. "Running cli_codex").
 */
export function createCodeTools(
  api: OpenClawPluginApi,
  rawCtx: Record<string, unknown>,
): AnyAgentTool[] {
  const ctx = rawCtx as OpenClawPluginToolContext;
  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
  const codingConfig = loadCodingConfig();

  const tools: AnyAgentTool[] = [];

  for (const [backendId, backend] of Object.entries(BACKENDS) as [CodingBackend, typeof BACKENDS[CodingBackend]][]) {
    const tool: AnyAgentTool = {
      name: backend.toolName,
      label: backend.label,
      description: backend.description,
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "What the coding agent should do. Be specific: include file paths, function names, " +
              "expected behavior, and test requirements.",
          },
          workingDir: {
            type: "string",
            description: "Override working directory (default: ~/ai-workspace).",
          },
          model: {
            type: "string",
            description: "Model override for the coding backend.",
          },
          timeoutMs: {
            type: "number",
            description: "Max runtime in milliseconds (default: 600000 = 10 min).",
          },
        },
        required: ["prompt"],
      },
      execute: async (toolCallId: string, params: CliToolParams, ...rest: unknown[]) => {
        const originalOnUpdate = typeof rest[1] === "function"
          ? rest[1] as (update: Record<string, unknown>) => void
          : undefined;

        // Inject Linear session context
        injectSessionInfo(params, ctx);

        const workingDir = params.workingDir
          ?? (pluginConfig?.[backend.configKeyBaseRepo] as string)
          ?? DEFAULT_BASE_REPO;
        const prompt = params.prompt ?? "";

        api.logger.info(`${backend.toolName}: agent=${ctx.agentId ?? "unknown"} dir=${workingDir}`);
        api.logger.info(`${backend.toolName} prompt: ${prompt.slice(0, 200)}`);

        // Channel progress messaging
        const channelSend = createChannelSender(api, ctx.sessionKey);
        if (channelSend) {
          const initMsg = [
            `**${backend.toolName}** — ${backend.label}`,
            `\`${workingDir}\``,
            `> ${prompt.slice(0, 800)}${prompt.length > 800 ? "..." : ""}`,
          ].join("\n");
          channelSend(initMsg).catch(() => {});
        }

        // Throttled progress forwarding
        let lastForwardMs = 0;
        let lastChannelMs = 0;
        const FORWARD_THROTTLE_MS = 30_000;
        const CHANNEL_THROTTLE_MS = 20_000;

        const wrappedOnUpdate: OnProgressUpdate = (update) => {
          const now = Date.now();
          if (originalOnUpdate && now - lastForwardMs >= FORWARD_THROTTLE_MS) {
            lastForwardMs = now;
            try { originalOnUpdate(update); } catch {}
          }
          if (channelSend && now - lastChannelMs >= CHANNEL_THROTTLE_MS) {
            lastChannelMs = now;
            const summary = String(update.summary ?? "");
            if (summary) {
              const logIdx = summary.indexOf("\n---\n");
              const logPart = logIdx >= 0 ? summary.slice(logIdx + 5) : "";
              if (logPart.trim()) {
                const tail = logPart.length > 1200 ? "..." + logPart.slice(-1200) : logPart;
                channelSend(`\`\`\`\n${tail}\n\`\`\``).catch(() => {});
              }
            }
          }
        };

        const result = await backend.runner(api, params, pluginConfig, wrappedOnUpdate);

        return jsonResult({
          success: result.success,
          backend: backendId,
          output: result.output,
          ...(result.error ? { error: result.error } : {}),
        });
      },
    } as unknown as AnyAgentTool;

    tools.push(tool);
  }

  const defaultBackend = resolveCodingBackend(codingConfig, ctx.agentId);
  api.logger.info(`cli tools registered: ${tools.map(t => (t as any).name).join(", ")} (agent default: ${BACKENDS[defaultBackend].toolName})`);

  return tools;
}

// Keep backward-compat export for tests that reference the old name
export const createCodeTool = createCodeTools;
