import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { getCurrentSession, getActiveSessionByAgentId } from "../pipeline/active-session.js";
import { runCodex } from "./codex-tool.js";
import { runClaude } from "./claude-tool.js";
import { runGemini } from "./gemini-tool.js";
import { DEFAULT_BASE_REPO } from "./cli-shared.js";
const BACKENDS = {
    codex: {
        label: "Codex CLI (OpenAI)",
        toolName: "cli_codex",
        runner: runCodex,
        description: "Run OpenAI Codex CLI to perform a coding task. " +
            "Can read/write files, run commands, search code, run tests. " +
            "Streams progress to Linear in real-time.",
        configKeyTimeout: "codexTimeoutMs",
        configKeyBaseRepo: "codexBaseRepo",
    },
    claude: {
        label: "Claude Code (Anthropic)",
        toolName: "cli_claude",
        runner: runClaude,
        description: "Run Anthropic Claude Code CLI to perform a coding task. " +
            "Can read/write files, run commands, search code, run tests. " +
            "Streams progress to Linear in real-time.",
        configKeyTimeout: "claudeTimeoutMs",
        configKeyBaseRepo: "claudeBaseRepo",
    },
    gemini: {
        label: "Gemini CLI (Google)",
        toolName: "cli_gemini",
        runner: runGemini,
        description: "Run Google Gemini CLI to perform a coding task. " +
            "Can read/write files, run commands, search code, run tests. " +
            "Streams progress to Linear in real-time.",
        configKeyTimeout: "geminiTimeoutMs",
        configKeyBaseRepo: "geminiBaseRepo",
    },
};
/**
 * Load coding tool config from the plugin's coding-tools.json file.
 * Falls back to empty config if the file doesn't exist or is invalid.
 */
export function loadCodingConfig() {
    try {
        const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
        const raw = readFileSync(join(pluginRoot, "coding-tools.json"), "utf8");
        return JSON.parse(raw);
    }
    catch {
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
export function resolveCodingBackend(config, agentId) {
    if (agentId) {
        const override = config.agentCodingTools?.[agentId];
        if (override && override in BACKENDS)
            return override;
    }
    const global = config.codingTool;
    if (global && global in BACKENDS)
        return global;
    return "codex";
}
/**
 * Resolve the tool name (cli_codex, cli_claude, cli_gemini) for a given agent.
 */
export function resolveToolName(config, agentId) {
    return BACKENDS[resolveCodingBackend(config, agentId)].toolName;
}
/**
 * Parse a session key to extract channel routing info for progress messages.
 */
function parseChannelTarget(sessionKey) {
    if (!sessionKey)
        return null;
    const parts = sessionKey.split(":");
    if (parts.length < 5 || parts[0] !== "agent")
        return null;
    const provider = parts[2];
    const kind = parts[3];
    if (!provider || !kind)
        return null;
    const peerId = parts[4];
    if (!peerId)
        return null;
    return { provider, peerId };
}
/**
 * Create a channel sender that can send messages to the session's channel.
 */
function createChannelSender(api, sessionKey) {
    const target = parseChannelTarget(sessionKey);
    if (!target)
        return null;
    const { provider, peerId } = target;
    // 2026.4 dropped runtime.channel.<discord|telegram>.sendMessage* in favor of
    // a capability-grouped channel runtime. Fall back to the gateway CLI for
    // out-of-band progress messages — this path is low-frequency (one call per
    // CLI tool run) so the subprocess cost is acceptable.
    if (provider === "discord" || provider === "telegram") {
        return async (text) => {
            await new Promise((resolve) => {
                execFile("openclaw", ["message", "send", "--channel", provider, "--target", peerId, "--message", text, "--json"], { timeout: 30_000 }, (err) => {
                    if (err)
                        api.logger.warn(`cli channel send (${provider}) failed: ${err.message}`);
                    resolve();
                });
            });
        };
    }
    return null;
}
/**
 * Inject Linear session info into tool params so backend runners can emit
 * activities to the correct Linear agent session.
 */
function injectSessionInfo(params, ctx) {
    const ctxAgentId = ctx.agentId;
    const activeSession = getCurrentSession()
        ?? (ctxAgentId ? getActiveSessionByAgentId(ctxAgentId) : null);
    if (activeSession) {
        if (!params.agentSessionId)
            params.agentSessionId = activeSession.agentSessionId;
        if (!params.issueId)
            params.issueId = activeSession.issueId;
        if (!params.issueIdentifier)
            params.issueIdentifier = activeSession.issueIdentifier;
    }
}
/**
 * Create the three coding CLI tools: cli_codex, cli_claude, cli_gemini.
 *
 * Each tool directly invokes its backend CLI. The tool name shown in Linear
 * reflects which CLI is running (e.g. "Running cli_codex").
 */
export function createCodeTools(api, rawCtx) {
    const ctx = rawCtx;
    const pluginConfig = api.pluginConfig;
    const codingConfig = loadCodingConfig();
    const tools = [];
    for (const [backendId, backend] of Object.entries(BACKENDS)) {
        const tool = {
            name: backend.toolName,
            label: backend.label,
            description: backend.description,
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description: "What the coding agent should do. Be specific: include file paths, function names, " +
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
            execute: async (toolCallId, params, ...rest) => {
                const originalOnUpdate = typeof rest[1] === "function"
                    ? rest[1]
                    : undefined;
                // Inject Linear session context
                injectSessionInfo(params, ctx);
                const workingDir = params.workingDir
                    ?? pluginConfig?.[backend.configKeyBaseRepo]
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
                    channelSend(initMsg).catch(() => { });
                }
                // Throttled progress forwarding
                let lastForwardMs = 0;
                let lastChannelMs = 0;
                const FORWARD_THROTTLE_MS = 30_000;
                const CHANNEL_THROTTLE_MS = 20_000;
                const wrappedOnUpdate = (update) => {
                    const now = Date.now();
                    if (originalOnUpdate && now - lastForwardMs >= FORWARD_THROTTLE_MS) {
                        lastForwardMs = now;
                        try {
                            originalOnUpdate(update);
                        }
                        catch { }
                    }
                    if (channelSend && now - lastChannelMs >= CHANNEL_THROTTLE_MS) {
                        lastChannelMs = now;
                        const summary = String(update.summary ?? "");
                        if (summary) {
                            const logIdx = summary.indexOf("\n---\n");
                            const logPart = logIdx >= 0 ? summary.slice(logIdx + 5) : "";
                            if (logPart.trim()) {
                                const tail = logPart.length > 1200 ? "..." + logPart.slice(-1200) : logPart;
                                channelSend(`\`\`\`\n${tail}\n\`\`\``).catch(() => { });
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
        };
        tools.push(tool);
    }
    const defaultBackend = resolveCodingBackend(codingConfig, ctx.agentId);
    api.logger.info(`cli tools registered: ${tools.map(t => t.name).join(", ")} (agent default: ${BACKENDS[defaultBackend].toolName})`);
    return tools;
}
// Keep backward-compat export for tests that reference the old name
export const createCodeTool = createCodeTools;
