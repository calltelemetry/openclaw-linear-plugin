import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { getCurrentSession } from "../pipeline/active-session.js";
import { runCodex } from "./codex-tool.js";
import { runClaude } from "./claude-tool.js";
import { runGemini } from "./gemini-tool.js";
import type { CliToolParams, CliResult } from "./cli-shared.js";

export type CodingBackend = "claude" | "codex" | "gemini";

const BACKEND_LABELS: Record<CodingBackend, string> = {
  claude: "Claude Code (Anthropic)",
  codex: "Codex (OpenAI)",
  gemini: "Gemini CLI (Google)",
};

const BACKEND_RUNNERS: Record<
  CodingBackend,
  (api: OpenClawPluginApi, params: CliToolParams, pluginConfig?: Record<string, unknown>) => Promise<CliResult>
> = {
  claude: runClaude,
  codex: runCodex,
  gemini: runGemini,
};

interface BackendConfig {
  aliases?: string[];
}

export interface CodingToolsConfig {
  codingTool?: string;
  agentCodingTools?: Record<string, string>;
  backends?: Record<string, BackendConfig>;
}

/**
 * Load coding tool config from the plugin's coding-tools.json file.
 * Falls back to empty config if the file doesn't exist or is invalid.
 */
export function loadCodingConfig(): CodingToolsConfig {
  try {
    // Resolve relative to the plugin root (one level up from src/)
    const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const raw = readFileSync(join(pluginRoot, "coding-tools.json"), "utf8");
    return JSON.parse(raw) as CodingToolsConfig;
  } catch {
    return {};
  }
}

/**
 * Build a reverse lookup map: alias (lowercase) → backend ID.
 * Backend IDs themselves are always valid aliases.
 */
function buildAliasMap(config: CodingToolsConfig): Map<string, CodingBackend> {
  const map = new Map<string, CodingBackend>();

  for (const backendId of Object.keys(BACKEND_RUNNERS) as CodingBackend[]) {
    // The backend ID itself is always an alias
    map.set(backendId, backendId);

    // Add configured aliases
    const aliases = config.backends?.[backendId]?.aliases;
    if (aliases) {
      for (const alias of aliases) {
        map.set(alias.toLowerCase(), backendId);
      }
    }
  }

  return map;
}

/**
 * Resolve a user-provided alias string to a backend ID.
 * Returns undefined if no match.
 */
function resolveAlias(aliasMap: Map<string, CodingBackend>, input: string): CodingBackend | undefined {
  return aliasMap.get(input.toLowerCase());
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
  // Per-agent override
  if (agentId) {
    const override = config.agentCodingTools?.[agentId];
    if (override && override in BACKEND_RUNNERS) return override as CodingBackend;
  }

  // Global default
  const global = config.codingTool;
  if (global && global in BACKEND_RUNNERS) return global as CodingBackend;

  return "codex";
}

/**
 * Create the unified `code_run` tool.
 *
 * The tool dispatches to the backend configured in coding-tools.json
 * (codingTool / agentCodingTools). The agent always calls `code_run` —
 * it doesn't need to know which CLI is being used.
 */
export function createCodeTool(
  api: OpenClawPluginApi,
  _ctx: Record<string, unknown>,
): AnyAgentTool {
  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
  const codingConfig = loadCodingConfig();
  const aliasMap = buildAliasMap(codingConfig);

  // Resolve the default backend for the tool description (may be overridden at runtime per-agent)
  const defaultBackend = resolveCodingBackend(codingConfig);
  const defaultLabel = BACKEND_LABELS[defaultBackend];

  // Build alias description for each backend so the LLM knows what names to use
  const aliasDescParts: string[] = [];
  for (const backendId of Object.keys(BACKEND_RUNNERS) as CodingBackend[]) {
    const aliases = codingConfig.backends?.[backendId]?.aliases ?? [backendId];
    aliasDescParts.push(`${BACKEND_LABELS[backendId]}: ${aliases.map(a => `"${a}"`).join(", ")}`);
  }
  const aliasDesc = aliasDescParts.join("; ");

  api.logger.info(`code_run: default backend=${defaultBackend}, aliases=${JSON.stringify(Object.fromEntries(aliasMap))}, per-agent overrides=${JSON.stringify(codingConfig.agentCodingTools ?? {})}`);

  return {
    name: "code_run",
    label: "Run Coding Agent",
    description:
      `Run an agentic coding CLI to perform a hands-on coding task. ` +
      `Default backend: ${defaultLabel}. You can override with the 'backend' parameter ` +
      `if the user asks for a specific tool. ` +
      `Known aliases — ${aliasDesc}. ` +
      `The CLI can read/write files, run commands, search code, run tests, and more. ` +
      `Streams progress to Linear in real-time. Use this for writing code, debugging, ` +
      `refactoring, creating files, running tests, and other hands-on development work.`,
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "What the coding agent should do. Be specific: include file paths, function names, " +
            "expected behavior, and test requirements.",
        },
        backend: {
          type: "string",
          description:
            `Which coding CLI to use. Accepts any known alias: ${aliasDesc}. ` +
            "If omitted, uses the configured default.",
        },
        workingDir: {
          type: "string",
          description: "Override working directory (default: /home/claw/ai-workspace).",
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
    execute: async (toolCallId: string, params: CliToolParams & { backend?: string }, ...rest: unknown[]) => {
      // Resolve backend: explicit alias → per-agent config → global default
      const currentSession = getCurrentSession();
      const agentId = currentSession?.agentId;
      const explicitBackend = params.backend
        ? resolveAlias(aliasMap, params.backend)
        : undefined;
      const backend = explicitBackend ?? resolveCodingBackend(codingConfig, agentId);
      const runner = BACKEND_RUNNERS[backend];

      api.logger.info(`code_run: backend=${backend} agent=${agentId ?? "unknown"}`);

      const result = await runner(api, params, pluginConfig);

      return jsonResult({
        success: result.success,
        backend,
        output: result.output,
        ...(result.error ? { error: result.error } : {}),
      });
    },
  } as unknown as AnyAgentTool;
}
