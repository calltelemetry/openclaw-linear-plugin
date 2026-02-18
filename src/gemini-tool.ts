import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ActivityContent } from "./linear-api.js";
import {
  buildLinearApi,
  resolveSession,
  extractPrompt,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_BASE_REPO,
  type CliToolParams,
  type CliResult,
} from "./cli-shared.js";
import { InactivityWatchdog, resolveWatchdogConfig } from "./watchdog.js";

const GEMINI_BIN = "/home/claw/.npm-global/bin/gemini";

/**
 * Map a Gemini CLI stream-json JSONL event to a Linear activity.
 *
 * Gemini event types:
 *   init → message(user) → message(assistant) → tool_use → tool_result → result
 */
function mapGeminiEventToActivity(event: any): ActivityContent | null {
  const type = event?.type;

  // Assistant message (delta text)
  if (type === "message" && event.role === "assistant") {
    const text = event.content;
    if (text) return { type: "thought", body: text.slice(0, 1000) };
    return null;
  }

  // Tool use — running a command or tool
  if (type === "tool_use") {
    const toolName = event.tool_name ?? "tool";
    const params = event.parameters ?? {};
    let paramSummary: string;
    if (params.command) {
      paramSummary = String(params.command).slice(0, 200);
    } else if (params.file_path) {
      paramSummary = String(params.file_path);
    } else if (params.description) {
      paramSummary = String(params.description).slice(0, 200);
    } else {
      paramSummary = JSON.stringify(params).slice(0, 200);
    }
    return { type: "action", action: `Running ${toolName}`, parameter: paramSummary };
  }

  // Tool result
  if (type === "tool_result") {
    const status = event.status ?? "unknown";
    const output = event.output ?? "";
    const truncated = output.length > 300 ? output.slice(0, 300) + "..." : output;
    return {
      type: "action",
      action: `Tool ${status}`,
      parameter: truncated || "(no output)",
    };
  }

  // Final result
  if (type === "result") {
    const stats = event.stats;
    const parts: string[] = ["Gemini completed"];
    if (stats) {
      if (stats.duration_ms) parts.push(`${Math.round(stats.duration_ms / 1000)}s`);
      if (stats.total_tokens) parts.push(`${stats.total_tokens} tokens`);
      if (stats.tool_calls) parts.push(`${stats.tool_calls} tool calls`);
    }
    return { type: "thought", body: parts.join(" — ") };
  }

  return null;
}

/**
 * Run Gemini CLI with JSONL streaming, mapping events to Linear activities.
 */
export async function runGemini(
  api: OpenClawPluginApi,
  params: CliToolParams,
  pluginConfig?: Record<string, unknown>,
): Promise<CliResult> {
  api.logger.info(`gemini_run params: ${JSON.stringify(params).slice(0, 500)}`);

  const prompt = extractPrompt(params);
  if (!prompt) {
    return {
      success: false,
      output: `gemini_run error: no prompt provided. Received keys: ${Object.keys(params).join(", ")}`,
      error: "missing prompt",
    };
  }

  const { model, timeoutMs } = params;
  const { agentSessionId, issueIdentifier } = resolveSession(params);

  api.logger.info(`gemini_run: session=${agentSessionId ?? "none"}, issue=${issueIdentifier ?? "none"}`);

  const agentId = (params as any).agentId ?? (pluginConfig?.defaultAgentId as string) ?? "default";
  const wdConfig = resolveWatchdogConfig(agentId, pluginConfig ?? undefined);
  const timeout = timeoutMs ?? (pluginConfig?.geminiTimeoutMs as number) ?? wdConfig.toolTimeoutMs;
  const workingDir = params.workingDir ?? (pluginConfig?.geminiBaseRepo as string) ?? DEFAULT_BASE_REPO;

  const linearApi = buildLinearApi(api, agentSessionId);

  if (linearApi && agentSessionId) {
    await linearApi.emitActivity(agentSessionId, {
      type: "thought",
      body: `Starting Gemini: "${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}"`,
    }).catch(() => {});
  }

  // Build gemini command — no -C flag, use cwd in spawn options
  const args = [
    "-p", prompt,
    "-o", "stream-json",
    "--yolo",
  ];
  if (model ?? pluginConfig?.geminiModel) {
    args.push("-m", (model ?? pluginConfig?.geminiModel) as string);
  }

  api.logger.info(`Gemini exec: ${GEMINI_BIN} ${args.join(" ").slice(0, 200)}...`);

  return new Promise<CliResult>((resolve) => {
    const child = spawn(GEMINI_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: workingDir,
      env: { ...process.env },
      timeout: 0,
    });

    let killed = false;
    let killedByWatchdog = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 5_000);
    }, timeout);

    const watchdog = new InactivityWatchdog({
      inactivityMs: wdConfig.inactivityMs,
      label: `gemini:${agentSessionId ?? "unknown"}`,
      logger: api.logger,
      onKill: () => {
        killedByWatchdog = true;
        killed = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 5_000);
      },
    });
    watchdog.start();

    const collectedMessages: string[] = [];
    const collectedCommands: string[] = [];
    let stderrOutput = "";

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      watchdog.tick();

      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        // Non-JSON lines (e.g. "YOLO mode" warnings) — skip
        return;
      }

      // Collect assistant text for final output
      if (event.type === "message" && event.role === "assistant") {
        const text = event.content;
        if (text) collectedMessages.push(text);
      }

      // Collect tool use/result for final output
      if (event.type === "tool_use") {
        const toolName = event.tool_name ?? "tool";
        const cmd = event.parameters?.command ?? event.parameters?.description ?? "";
        if (cmd) collectedCommands.push(`\`${toolName}\`: ${String(cmd).slice(0, 200)}`);
      }

      if (event.type === "tool_result") {
        const output = event.output ?? "";
        const status = event.status ?? "unknown";
        const truncOutput = output.length > 500 ? output.slice(0, 500) + "..." : output;
        if (truncOutput) {
          collectedCommands.push(
            `→ ${status}${truncOutput ? "\n```\n" + truncOutput + "\n```" : ""}`
          );
        }
      }

      // Stream activity to Linear
      const activity = mapGeminiEventToActivity(event);
      if (activity && linearApi && agentSessionId) {
        linearApi.emitActivity(agentSessionId, activity).catch((err) => {
          api.logger.warn(`Failed to emit Gemini activity: ${err}`);
        });
      }
    });

    child.stderr?.on("data", (chunk) => {
      watchdog.tick();
      stderrOutput += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      watchdog.stop();
      rl.close();

      const parts: string[] = [];
      if (collectedMessages.length > 0) parts.push(collectedMessages.join("\n\n"));
      if (collectedCommands.length > 0) parts.push(collectedCommands.join("\n\n"));
      const output = parts.join("\n\n") || stderrOutput || "(no output)";

      if (killed) {
        const errorType = killedByWatchdog ? "inactivity_timeout" : "timeout";
        const reason = killedByWatchdog
          ? `Gemini killed by inactivity watchdog (no I/O for ${Math.round(wdConfig.inactivityMs / 1000)}s)`
          : `Gemini timed out after ${Math.round(timeout / 1000)}s`;
        api.logger.warn(reason);
        resolve({
          success: false,
          output: `${reason}. Partial output:\n${output}`,
          error: errorType,
        });
        return;
      }

      if (code !== 0) {
        api.logger.warn(`Gemini exited with code ${code}`);
        resolve({
          success: false,
          output: `Gemini failed (exit ${code}):\n${output}`,
          error: `exit ${code}`,
        });
        return;
      }

      api.logger.info(`Gemini completed successfully`);
      resolve({ success: true, output });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      watchdog.stop();
      rl.close();
      api.logger.error(`Gemini spawn error: ${err}`);
      resolve({
        success: false,
        output: `Failed to start Gemini: ${err.message}`,
        error: err.message,
      });
    });
  });
}

