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

const CLAUDE_BIN = "/home/claw/.npm-global/bin/claude";

/**
 * Map a Claude Code stream-json JSONL event to a Linear activity.
 *
 * Claude event types:
 *   system(init) → assistant (text|tool_use) → user (tool_result) → result
 */
function mapClaudeEventToActivity(event: any): ActivityContent | null {
  const type = event?.type;

  // Assistant message — text response or tool use
  if (type === "assistant") {
    const content = event.message?.content;
    if (!Array.isArray(content)) return null;

    for (const block of content) {
      if (block.type === "text" && block.text) {
        return { type: "thought", body: block.text.slice(0, 1000) };
      }
      if (block.type === "tool_use") {
        const toolName = block.name ?? "tool";
        const input = block.input ?? {};
        // Summarize the input for display
        let paramSummary: string;
        if (input.command) {
          paramSummary = String(input.command).slice(0, 200);
        } else if (input.file_path) {
          paramSummary = String(input.file_path);
        } else if (input.pattern) {
          paramSummary = String(input.pattern);
        } else if (input.query) {
          paramSummary = String(input.query).slice(0, 200);
        } else {
          paramSummary = JSON.stringify(input).slice(0, 200);
        }
        return { type: "action", action: `Running ${toolName}`, parameter: paramSummary };
      }
    }
    return null;
  }

  // Tool result
  if (type === "user") {
    const content = event.message?.content;
    if (!Array.isArray(content)) return null;

    for (const block of content) {
      if (block.type === "tool_result") {
        const output = typeof block.content === "string" ? block.content : "";
        const truncated = output.length > 300 ? output.slice(0, 300) + "..." : output;
        const isError = block.is_error === true;
        return {
          type: "action",
          action: isError ? "Tool error" : "Tool result",
          parameter: truncated || "(no output)",
        };
      }
    }
    return null;
  }

  // Final result
  if (type === "result") {
    const cost = event.total_cost_usd;
    const turns = event.num_turns ?? 0;
    const usage = event.usage;
    const parts: string[] = [`Claude completed (${turns} turns)`];
    if (cost != null) parts.push(`$${cost.toFixed(4)}`);
    if (usage) {
      const input = usage.input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;
      parts.push(`${input} in / ${output} out tokens`);
    }
    return { type: "thought", body: parts.join(" — ") };
  }

  return null;
}

/**
 * Run Claude Code CLI with JSONL streaming, mapping events to Linear activities.
 */
export async function runClaude(
  api: OpenClawPluginApi,
  params: CliToolParams,
  pluginConfig?: Record<string, unknown>,
): Promise<CliResult> {
  api.logger.info(`claude_run params: ${JSON.stringify(params).slice(0, 500)}`);

  const prompt = extractPrompt(params);
  if (!prompt) {
    return {
      success: false,
      output: `claude_run error: no prompt provided. Received keys: ${Object.keys(params).join(", ")}`,
      error: "missing prompt",
    };
  }

  const { model, timeoutMs } = params;
  const { agentSessionId, issueIdentifier } = resolveSession(params);

  api.logger.info(`claude_run: session=${agentSessionId ?? "none"}, issue=${issueIdentifier ?? "none"}`);

  const timeout = timeoutMs ?? (pluginConfig?.claudeTimeoutMs as number) ?? DEFAULT_TIMEOUT_MS;
  const workingDir = params.workingDir ?? (pluginConfig?.claudeBaseRepo as string) ?? DEFAULT_BASE_REPO;

  const linearApi = buildLinearApi(api, agentSessionId);

  if (linearApi && agentSessionId) {
    await linearApi.emitActivity(agentSessionId, {
      type: "thought",
      body: `Starting Claude Code: "${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}"`,
    }).catch(() => {});
  }

  // Build claude command
  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];
  if (model ?? pluginConfig?.claudeModel) {
    args.push("--model", (model ?? pluginConfig?.claudeModel) as string);
  }
  args.push("-p", prompt);

  api.logger.info(`Claude exec: ${CLAUDE_BIN} ${args.join(" ").slice(0, 200)}...`);

  return new Promise<CliResult>((resolve) => {
    // Must unset CLAUDECODE to avoid "nested session" error
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const child = spawn(CLAUDE_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: workingDir,
      env,
      timeout: 0,
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 5_000);
    }, timeout);

    const collectedMessages: string[] = [];
    const collectedCommands: string[] = [];
    let stderrOutput = "";
    let lastToolName = "";

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;

      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        collectedMessages.push(line);
        return;
      }

      // Collect assistant text for final output
      if (event.type === "assistant") {
        const content = event.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              collectedMessages.push(block.text);
            }
            if (block.type === "tool_use") {
              lastToolName = block.name ?? "tool";
            }
          }
        }
      }

      // Collect tool results for final output
      if (event.type === "user") {
        const content = event.message?.content;
        const toolResult = event.tool_use_result;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              const output = toolResult?.stdout ?? (typeof block.content === "string" ? block.content : "");
              const isError = block.is_error === true;
              const truncOutput = output.length > 500 ? output.slice(0, 500) + "..." : output;
              if (truncOutput) {
                collectedCommands.push(
                  `\`${lastToolName}\` → ${isError ? "error" : "ok"}${truncOutput ? "\n```\n" + truncOutput + "\n```" : ""}`
                );
              }
            }
          }
        }
      }

      // Collect final result text
      if (event.type === "result" && event.result) {
        // result.result contains the final answer — only add if we haven't already captured it
        // (it duplicates the last assistant text message)
      }

      // Stream activity to Linear
      const activity = mapClaudeEventToActivity(event);
      if (activity && linearApi && agentSessionId) {
        linearApi.emitActivity(agentSessionId, activity).catch((err) => {
          api.logger.warn(`Failed to emit Claude activity: ${err}`);
        });
      }
    });

    child.stderr?.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      rl.close();

      const parts: string[] = [];
      if (collectedMessages.length > 0) parts.push(collectedMessages.join("\n\n"));
      if (collectedCommands.length > 0) parts.push(collectedCommands.join("\n\n"));
      const output = parts.join("\n\n") || stderrOutput || "(no output)";

      if (killed) {
        api.logger.warn(`Claude timed out after ${timeout}ms`);
        resolve({
          success: false,
          output: `Claude timed out after ${Math.round(timeout / 1000)}s. Partial output:\n${output}`,
          error: "timeout",
        });
        return;
      }

      if (code !== 0) {
        api.logger.warn(`Claude exited with code ${code}`);
        resolve({
          success: false,
          output: `Claude failed (exit ${code}):\n${output}`,
          error: `exit ${code}`,
        });
        return;
      }

      api.logger.info(`Claude completed successfully`);
      resolve({ success: true, output });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      rl.close();
      api.logger.error(`Claude spawn error: ${err}`);
      resolve({
        success: false,
        output: `Failed to start Claude: ${err.message}`,
        error: err.message,
      });
    });
  });
}

