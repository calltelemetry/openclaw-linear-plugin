import { execSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { ActivityContent, LinearAgentApi } from "../api/linear-api.js";
import type { CliResult, OnProgressUpdate } from "../tools/cli-shared.js";
import { formatActivityLogLine, createProgressEmitter } from "../tools/cli-shared.js";
import { InactivityWatchdog } from "../agent/watchdog.js";
import { shellEscape } from "./tmux.js";

const COMPLETION_EVENT_TYPES = new Set([
  "result",
  "session.completed",
  "task_completed",
  "task.completed",
  "task_completion",
]);

export interface TmuxSession {
  sessionName: string;
  backend: string;
  issueIdentifier: string;
  issueId: string;
  steeringMode: string;
}

export interface RunInTmuxOptions {
  issueId: string;
  issueIdentifier: string;
  sessionName: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  watchdogMs: number;
  logPath: string;
  mapEvent: (event: any) => ActivityContent[];
  linearApi?: LinearAgentApi;
  agentSessionId?: string;
  steeringMode: "stdin-pipe" | "one-shot";
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void };
  onUpdate?: OnProgressUpdate;
  progressHeader: string;
}

// Track active tmux sessions by issueId
const activeSessions = new Map<string, TmuxSession>();

/**
 * Completion detector for streamed CLI JSONL events.
 * Supports Claude and Codex event variants across releases.
 */
export function isCompletionEvent(event: any): boolean {
  const type = typeof event?.type === "string" ? event.type.trim().toLowerCase() : "";
  if (type && COMPLETION_EVENT_TYPES.has(type)) {
    return true;
  }

  const itemType = typeof event?.item?.type === "string" ? event.item.type.trim().toLowerCase() : "";
  if (itemType && COMPLETION_EVENT_TYPES.has(itemType)) {
    return true;
  }

  return event?.session?.completed === true;
}

/**
 * Get the active tmux session for a given issueId, or null if none.
 */
export function getActiveTmuxSession(issueId: string): TmuxSession | null {
  return activeSessions.get(issueId) ?? null;
}

/**
 * Run a command inside a tmux session with output piped to a JSONL log.
 * Monitors the log file for events and streams them to Linear.
 *
 * The command + tee are wrapped in a shell script so that tee runs INSIDE
 * the tmux session (not in the outer shell). This ensures JSONL output
 * from the CLI subprocess is captured to the log file.
 */
export async function runInTmux(opts: RunInTmuxOptions): Promise<CliResult> {
  const {
    issueId,
    issueIdentifier,
    sessionName,
    command,
    cwd,
    timeoutMs,
    watchdogMs,
    logPath,
    mapEvent,
    linearApi,
    agentSessionId,
    steeringMode,
    logger,
    onUpdate,
    progressHeader,
  } = opts;

  // Ensure log directory exists
  mkdirSync(dirname(logPath), { recursive: true });

  // Touch the log file so tail -f can start immediately
  writeFileSync(logPath, "", { flag: "a" });

  // Register active session
  const session: TmuxSession = {
    sessionName,
    backend: sessionName.split("-").slice(-2, -1)[0] ?? "unknown",
    issueIdentifier,
    issueId,
    steeringMode,
  };
  activeSessions.set(issueId, session);

  const progress = createProgressEmitter({ header: progressHeader, onUpdate });
  progress.emitHeader();

  // Write a shell wrapper script so the entire pipeline (command | tee)
  // runs inside the tmux session. This avoids quoting hell and ensures
  // tee captures the subprocess output, not tmux's own stdout.
  const scriptPath = `${logPath}.run.sh`;

  try {
    writeFileSync(scriptPath, [
      "#!/bin/sh",
      `exec ${command} 2>&1 | tee -a ${shellEscape(logPath)}`,
      "",
    ].join("\n"), { mode: 0o755 });

    // Start tmux session running the wrapper script
    execSync(
      `tmux new-session -d -s ${shellEscape(sessionName)} -c ${shellEscape(cwd)} ${shellEscape(scriptPath)}`,
      { stdio: "ignore", timeout: 10_000 },
    );

    logger.info(`tmux session started: ${sessionName} (log: ${logPath})`);

    // Tail the log file and process JSONL events
    return await new Promise<CliResult>((resolve) => {
      const tail = spawn("tail", ["-f", "-n", "+1", logPath], {
        stdio: ["ignore", "pipe", "ignore"],
      });

      let killed = false;
      let killedByWatchdog = false;
      let resolved = false;
      let completionEventReceived = false;
      const collectedMessages: string[] = [];

      const timer = setTimeout(() => {
        killed = true;
        cleanup("timeout");
      }, timeoutMs);

      const watchdog = new InactivityWatchdog({
        inactivityMs: watchdogMs,
        label: `tmux:${sessionName}`,
        logger,
        onKill: () => {
          killedByWatchdog = true;
          killed = true;
          cleanup("inactivity_timeout");
        },
      });
      watchdog.start();

      function cleanup(reason: string) {
        if (resolved) return;
        resolved = true;

        clearTimeout(timer);
        watchdog.stop();
        tail.kill();

        // Kill the tmux session
        try {
          execSync(`tmux kill-session -t ${shellEscape(sessionName)}`, {
            stdio: "ignore",
            timeout: 5_000,
          });
        } catch { /* session may already be gone */ }

        // Clean up wrapper script
        try { unlinkSync(scriptPath); } catch { /* best effort */ }

        activeSessions.delete(issueId);

        const output = collectedMessages.join("\n\n") || "(no output)";

        if (reason === "inactivity_timeout") {
          logger.warn(`tmux session ${sessionName} killed by inactivity watchdog`);
          resolve({
            success: false,
            output: `Agent killed by inactivity watchdog (no I/O for ${Math.round(watchdogMs / 1000)}s). Partial output:\n${output}`,
            error: "inactivity_timeout",
          });
        } else if (reason === "timeout") {
          logger.warn(`tmux session ${sessionName} timed out after ${Math.round(timeoutMs / 1000)}s`);
          resolve({
            success: false,
            output: `Agent timed out after ${Math.round(timeoutMs / 1000)}s. Partial output:\n${output}`,
            error: "timeout",
          });
        } else if (reason === "unexpected_exit") {
          logger.warn(`tmux session ${sessionName} exited without completion event`);
          resolve({
            success: false,
            output: `Agent session exited unexpectedly (no completion event received). Partial output:\n${output}`,
            error: "unexpected_exit",
          });
        } else {
          // Normal completion — only reached when completionEventReceived is true
          resolve({ success: true, output });
        }
      }

      const rl = createInterface({ input: tail.stdout! });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        watchdog.tick();

        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          collectedMessages.push(line);
          return;
        }

        // Collect text for output — handle both Claude and Codex event shapes
        if (event.type === "assistant") {
          // Claude stream-json shape
          const content = event.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                collectedMessages.push(block.text);
              }
            }
          }
        }
        if (event.item?.type === "agent_message" || event.item?.type === "message") {
          // Codex --json shape
          const text = event.item.text ?? event.item.content ?? "";
          if (text) collectedMessages.push(text);
        }

        // Stream to Linear
        const activities = mapEvent(event);
        for (const activity of activities) {
          if (linearApi && agentSessionId) {
            linearApi.emitActivity(agentSessionId, activity).catch((err) => {
              logger.warn(`Failed to emit tmux activity: ${err}`);
            });
          }
          progress.push(formatActivityLogLine(activity));
        }

        // Detect completion across known CLI event shapes.
        if (isCompletionEvent(event)) {
          completionEventReceived = true;
          cleanup("done");
          rl.close();
        }
      });

      // Handle tail process ending (tmux session exited)
      tail.on("close", () => {
        if (!resolved) {
          // If we never saw a completion event, the session died unexpectedly
          if (completionEventReceived) {
            cleanup("done");
          } else {
            cleanup("unexpected_exit");
          }
        }
        rl.close();
      });

      tail.on("error", (err) => {
        logger.error(`tmux tail error: ${err}`);
        if (!resolved) {
          cleanup("error");
        }
        rl.close();
      });
    });
  } catch (err) {
    // Clean up wrapper script on failure
    try { unlinkSync(scriptPath); } catch { /* best effort */ }

    activeSessions.delete(issueId);
    logger.error(`runInTmux failed: ${err}`);
    return {
      success: false,
      output: `Failed to start tmux session: ${err}`,
      error: String(err),
    };
  }
}
