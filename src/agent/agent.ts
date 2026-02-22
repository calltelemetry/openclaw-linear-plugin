import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { LinearAgentApi, ActivityContent } from "../api/linear-api.js";
import { InactivityWatchdog, resolveWatchdogConfig } from "./watchdog.js";

// ---------------------------------------------------------------------------
// Agent directory resolution (config-based, not ext API which ignores agentId)
// ---------------------------------------------------------------------------

interface AgentDirs {
  workspaceDir: string;
  agentDir: string;
}

function resolveAgentDirs(agentId: string, config: Record<string, any>): AgentDirs {
  const home = homedir();
  const agentList = config?.agents?.list as Array<Record<string, any>> | undefined;
  const agentEntry = agentList?.find((a) => a.id === agentId);

  // Workspace: agent-specific override → agents.defaults.workspace → fallback
  const workspaceDir = agentEntry?.workspace
    ?? config?.agents?.defaults?.workspace
    ?? join(home, ".openclaw", "workspace");

  // Agent runtime dir: always ~/.openclaw/agents/{agentId}/agent
  // (matches OpenClaw's internal structure)
  const agentDir = join(home, ".openclaw", "agents", agentId, "agent");
  mkdirSync(agentDir, { recursive: true });

  return { workspaceDir, agentDir };
}

// Import extensionAPI for embedded agent runner (internal, not in public SDK)
let _extensionAPI: any | null = null;
async function getExtensionAPI() {
  if (!_extensionAPI) {
    // Resolve the openclaw package location dynamically, then import extensionAPI
    const _require = createRequire(import.meta.url);
    const openclawDir = dirname(_require.resolve("openclaw/package.json"));
    _extensionAPI = await import(join(openclawDir, "dist", "extensionAPI.js"));
  }
  return _extensionAPI;
}

export interface AgentRunResult {
  success: boolean;
  output: string;
  watchdogKilled?: boolean;
}

export interface AgentStreamCallbacks {
  linearApi: LinearAgentApi;
  agentSessionId: string;
}

/**
 * Run an agent with automatic retry on watchdog kill.
 *
 * Tries embedded runner first (if streaming callbacks provided), falls back
 * to subprocess. If the inactivity watchdog kills the run, retries once.
 */
export async function runAgent(params: {
  api: OpenClawPluginApi;
  agentId: string;
  sessionId: string;
  message: string;
  timeoutMs?: number;
  streaming?: AgentStreamCallbacks;
  /**
   * Read-only mode: agent keeps read tools (read, glob, grep, web_search,
   * web_fetch) but all write-capable tools are denied via config policy.
   * Subprocess fallback is blocked — only the embedded runner is safe.
   */
  readOnly?: boolean;
}): Promise<AgentRunResult> {
  const maxAttempts = 2;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await runAgentOnce(params);

    if (result.success || !result.watchdogKilled || attempt === maxAttempts - 1) {
      return result;
    }

    params.api.logger.warn(
      `Agent ${params.agentId} killed by watchdog, retrying (attempt ${attempt + 1}/${maxAttempts})`,
    );

    // Emit Linear activity about the retry if streaming
    if (params.streaming) {
      params.streaming.linearApi.emitActivity(params.streaming.agentSessionId, {
        type: "error",
        body: `Agent killed by inactivity watchdog — no I/O for the configured threshold. Retrying...`,
      }).catch(() => {});
    }
  }

  // Unreachable, but TypeScript needs it
  return { success: false, output: "Watchdog retry exhausted" };
}

// ---------------------------------------------------------------------------
// Date/time injection — every LLM request gets the current timestamp so models
// don't hallucinate the year (Kimi K2.5 thinks it's 2025).
// ---------------------------------------------------------------------------

function buildDateContext(): string {
  const now = new Date();
  const iso = now.toISOString();
  // Human-readable: "Tuesday, February 18, 2026, 11:42 PM CST"
  const human = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `[Current date/time: ${human} (${iso})]`;
}

/**
 * Single attempt to run an agent (no retry logic).
 */
async function runAgentOnce(params: {
  api: OpenClawPluginApi;
  agentId: string;
  sessionId: string;
  message: string;
  timeoutMs?: number;
  streaming?: AgentStreamCallbacks;
  readOnly?: boolean;
}): Promise<AgentRunResult> {
  const { api, agentId, sessionId, streaming, readOnly } = params;

  // Inject current timestamp into every LLM request
  const message = `${buildDateContext()}\n\n${params.message}`;

  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
  const wdConfig = resolveWatchdogConfig(agentId, pluginConfig);
  const timeoutMs = params.timeoutMs ?? wdConfig.maxTotalMs;

  api.logger.info(`Dispatching agent ${agentId} for session ${sessionId} (timeout=${Math.round(timeoutMs / 1000)}s, inactivity=${Math.round(wdConfig.inactivityMs / 1000)}s${readOnly ? ", mode=READ_ONLY" : ""})`);

  // Try embedded runner first (has streaming callbacks)
  if (streaming) {
    try {
      return await runEmbedded(api, agentId, sessionId, message, timeoutMs, streaming, wdConfig.inactivityMs, readOnly);
    } catch (err) {
      // Read-only mode MUST NOT fall back to subprocess — subprocess runs a
      // full agent with no way to enforce the tool deny policy.
      if (readOnly) {
        api.logger.error(`Embedded runner failed in read-only mode, refusing subprocess fallback: ${err}`);
        return { success: false, output: "Read-only agent run failed (embedded runner unavailable)." };
      }
      api.logger.warn(`Embedded runner failed, falling back to subprocess: ${err}`);
    }
  }

  // Fallback: subprocess (no streaming)
  if (readOnly) {
    api.logger.error("Cannot run read-only agent via subprocess — no tool policy enforcement");
    return { success: false, output: "Read-only agent run requires the embedded runner." };
  }
  return runSubprocess(api, agentId, sessionId, message, timeoutMs);
}

/**
 * Embedded agent runner with real-time streaming to Linear and inactivity watchdog.
 */
// Tools denied in read-only mode.  Uses OpenClaw group:* shorthands where
// possible (see https://docs.openclaw.ai/tools).  Covers every built-in
// tool that can mutate the filesystem, execute commands, or produce
// side-effects beyond the Linear API calls the plugin makes after the run.
//
// NOT denied (read-only tools the triage agent keeps):
//   read, glob, grep/search          — codebase inspection
//   group:web (web_search, web_fetch) — external context
//   group:memory (memory_search/get)  — knowledge retrieval
//   sessions_list, sessions_history   — read-only introspection
const READ_ONLY_DENY: string[] = [
  // group:fs = read + write + edit + apply_patch — but we need read,
  // so deny the write-capable members individually.
  "write", "edit", "apply_patch",
  // Full groups that are entirely write/side-effect oriented:
  "group:runtime",                          // exec, bash, process
  "group:messaging",                        // message
  "group:ui",                               // browser, canvas
  "group:automation",                       // cron, gateway
  "group:nodes",                            // nodes
  // Individual tools not covered by a group:
  "sessions_spawn", "sessions_send",        // agent orchestration
  "tts",                                    // audio file generation
  "image",                                  // image file generation
];

async function runEmbedded(
  api: OpenClawPluginApi,
  agentId: string,
  sessionId: string,
  message: string,
  timeoutMs: number,
  streaming: AgentStreamCallbacks,
  inactivityMs: number,
  readOnly?: boolean,
): Promise<AgentRunResult> {
  const ext = await getExtensionAPI();

  // Load config so we can resolve agent dirs and providers correctly.
  let config = await api.runtime.config.loadConfig();
  let configAny = config as Record<string, any>;

  // ── Read-only enforcement ──────────────────────────────────────────
  // Clone the config and inject a tools.deny policy that strips every
  // write-capable tool.  The deny list is merged with any existing deny
  // entries so we don't clobber operator-level restrictions.
  if (readOnly) {
    configAny = JSON.parse(JSON.stringify(configAny));
    config = configAny as typeof config;
    if (!configAny.tools) configAny.tools = {};
    const existing: string[] = Array.isArray(configAny.tools.deny) ? configAny.tools.deny : [];
    configAny.tools.deny = [...new Set([...existing, ...READ_ONLY_DENY])];
    api.logger.info(`Read-only mode: tools.deny = [${configAny.tools.deny.join(", ")}]`);
  }

  // Resolve workspace and agent dirs from config (ext API ignores agentId).
  const dirs = resolveAgentDirs(agentId, configAny);
  const { workspaceDir, agentDir } = dirs;
  const runId = randomUUID();

  // Build session file path under the correct agent's sessions directory.
  const sessionsDir = join(agentDir, "sessions");
  try { mkdirSync(sessionsDir, { recursive: true }); } catch {}
  const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);

  // Resolve model/provider from config — default is anthropic which requires
  // a separate API key. Our agents use openrouter.
  const agentList = configAny?.agents?.list as Array<Record<string, any>> | undefined;
  const agentEntry = agentList?.find((a) => a.id === agentId);
  const modelRef: string =
    agentEntry?.model?.primary ??
    configAny?.agents?.defaults?.model?.primary ??
    `${ext.DEFAULT_PROVIDER}/${ext.DEFAULT_MODEL}`;

  // Parse "provider/model-id" format (e.g. "openrouter/moonshotai/kimi-k2.5")
  const slashIdx = modelRef.indexOf("/");
  const provider = slashIdx > 0 ? modelRef.slice(0, slashIdx) : ext.DEFAULT_PROVIDER;
  const model = slashIdx > 0 ? modelRef.slice(slashIdx + 1) : modelRef;

  api.logger.info(`Embedded agent run: agent=${agentId} session=${sessionId} runId=${runId} provider=${provider} model=${model} workspaceDir=${workspaceDir} agentDir=${agentDir}`);

  const emit = (content: ActivityContent) => {
    streaming.linearApi.emitActivity(streaming.agentSessionId, content).catch((err) => {
      api.logger.warn(`Activity emit failed: ${err}`);
    });
  };

  // --- Inactivity watchdog ---
  const controller = new AbortController();
  const watchdog = new InactivityWatchdog({
    inactivityMs,
    label: `embedded:${agentId}:${sessionId}`,
    logger: api.logger,
    onKill: () => {
      controller.abort();
      try { ext.abortEmbeddedPiRun(sessionId); } catch {}
    },
  });

  // Track last emitted tool to avoid duplicates
  let lastToolAction = "";

  watchdog.start();

  const result = await ext.runEmbeddedPiAgent({
    sessionId,
    sessionFile,
    workspaceDir,
    agentDir,
    prompt: message,
    agentId,
    runId,
    timeoutMs,
    config,
    provider,
    model,
    abortSignal: controller.signal,
    shouldEmitToolResult: () => true,
    shouldEmitToolOutput: () => true,
    ...(readOnly ? {
      extraSystemPrompt: [
        "READ-ONLY MODE: You may read and search files but you MUST NOT",
        "write, edit, create, or delete any files. Do not run shell commands.",
        "Your only output is your text response.",
      ].join(" "),
    } : {}),

    // Stream reasoning/thinking to Linear
    onReasoningStream: (payload) => {
      watchdog.tick();
      const text = payload.text?.trim();
      if (text && text.length > 10) {
        emit({ type: "thought", body: text.slice(0, 500) });
      }
    },

    // Stream tool results to Linear
    onToolResult: (payload) => {
      watchdog.tick();
      const text = payload.text?.trim();
      if (text) {
        // Truncate tool results for activity display
        const truncated = text.length > 300 ? text.slice(0, 300) + "..." : text;
        emit({ type: "action", action: lastToolAction || "Tool result", parameter: truncated });
      }
    },

    // Raw agent events — capture tool starts/ends
    onAgentEvent: (evt) => {
      watchdog.tick();
      const { stream, data } = evt;

      if (stream !== "tool") return;

      const phase = String(data.phase ?? "");
      const toolName = String(data.name ?? "tool");
      const meta = typeof data.meta === "string" ? data.meta : "";

      // Tool execution start — emit action with tool name + meta
      if (phase === "start") {
        lastToolAction = toolName;
        emit({ type: "action", action: `Running ${toolName}`, parameter: meta.slice(0, 200) || toolName });
      }

      // Tool execution result with error
      if (phase === "result" && data.isError) {
        emit({ type: "action", action: `${toolName} failed`, parameter: meta.slice(0, 200) || "error" });
      }
    },

    // Partial assistant text (for long responses)
    onPartialReply: (payload) => {
      watchdog.tick();
      // We don't emit every partial chunk to avoid flooding Linear
      // The final response will be posted as a comment
    },
  });

  watchdog.stop();

  // Extract output text from payloads
  const payloads = result.payloads ?? [];
  const outputText = payloads
    .map((p) => p.text)
    .filter(Boolean)
    .join("\n\n");

  // Check if watchdog killed the run
  if (watchdog.wasKilled) {
    const silenceSec = Math.round(watchdog.silenceMs / 1000);
    api.logger.warn(`Embedded agent killed by watchdog: agent=${agentId} session=${sessionId} silence=${silenceSec}s`);
    return {
      success: false,
      output: outputText || `Agent killed by inactivity watchdog after ${silenceSec}s of silence.`,
      watchdogKilled: true,
    };
  }

  if (result.meta?.error) {
    api.logger.error(`Embedded agent error: ${result.meta.error.kind}: ${result.meta.error.message}`);
    return { success: false, output: outputText || result.meta.error.message };
  }

  api.logger.info(`Embedded agent completed: agent=${agentId} session=${sessionId} duration=${result.meta.durationMs}ms`);
  return { success: true, output: outputText || "(no output)" };
}

/**
 * Subprocess fallback (no streaming, used when no Linear session context).
 */
async function runSubprocess(
  api: OpenClawPluginApi,
  agentId: string,
  sessionId: string,
  message: string,
  timeoutMs: number,
): Promise<AgentRunResult> {
  const command = [
    "openclaw",
    "agent",
    "--agent",
    agentId,
    "--session-id",
    sessionId,
    "--message",
    message,
    "--timeout",
    String(Math.floor(timeoutMs / 1000)),
    "--json",
  ];

  const result = await api.runtime.system.runCommandWithTimeout(command, { timeoutMs });

  if (result.code !== 0) {
    const error = result.stderr || result.stdout || "no output";
    api.logger.error(`Agent ${agentId} failed (${result.code}): ${error}`);
    return { success: false, output: error };
  }

  const raw = result.stdout || "";
  api.logger.info(`Agent ${agentId} completed for session ${sessionId}`);

  // Extract clean text from --json output
  try {
    const parsed = JSON.parse(raw);
    const payloads = parsed?.result?.payloads;
    if (Array.isArray(payloads) && payloads.length > 0) {
      const text = payloads.map((p: any) => p.text).filter(Boolean).join("\n\n");
      if (text) return { success: true, output: text };
    }
  } catch {
    // Not JSON — use raw output as-is
  }

  return { success: true, output: raw };
}
