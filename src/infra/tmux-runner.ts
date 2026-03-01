import { execSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, createWriteStream } from "node:fs";
import { dirname } from "node:path";
import type { ActivityContent, LinearAgentApi } from "../api/linear-api.js";
import type { CliResult, OnProgressUpdate } from "../tools/cli-shared.js";
import { formatActivityLogLine, createProgressEmitter } from "../tools/cli-shared.js";
import { InactivityWatchdog } from "../agent/watchdog.js";
import { shellEscape } from "./tmux.js";

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
  mapEvent: (event: any) => ActivityContent | null;
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
 * Get the active tmux session for a given issueId, or null if none.
 */
export function getActiveTmuxSession(issueId: string): TmuxSession | null {
  return activeSessions.get(issueId) ?? null;
}

/**
 * Run a command inside a tmux session with pipe-pane streaming to a JSONL log.
 * Monitors the log file for events and streams them to Linear.
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

  try {
    // Create tmux session running the command, piping output to logPath
    const tmuxCmd = [
      `tmux new-session -d -s ${shellEscape(sessionName)} -c ${shellEscape(cwd)}`,
      `${shellEscape(command)} 2>&1 | tee ${shellEscape(logPath)}`,
    ].join(" ");

    execSync(tmuxCmd, { stdio: "ignore", timeout: 10_000 });

    // Tail the log file and process JSONL events
    return await new Promise<CliResult>((resolve) => {
      const tail = spawn("tail", ["-f", "-n", "+1", logPath], {
        stdio: ["ignore", "pipe", "ignore"],
      });

      let killed = false;
      let killedByWatchdog = false;
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
        } else {
          // Normal completion
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

        // Collect text for output
        if (event.type === "assistant") {
          const content = event.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                collectedMessages.push(block.text);
              }
            }
          }
        }

        // Stream to Linear
        const activity = mapEvent(event);
        if (activity) {
          if (linearApi && agentSessionId) {
            linearApi.emitActivity(agentSessionId, activity).catch((err) => {
              logger.warn(`Failed to emit tmux activity: ${err}`);
            });
          }
          progress.push(formatActivityLogLine(activity));
        }

        // Detect completion
        if (event.type === "result") {
          cleanup("done");
          rl.close();
        }
      });

      // Handle tail process ending (tmux session completed)
      tail.on("close", () => {
        if (!killed) {
          cleanup("done");
        }
        rl.close();
      });

      tail.on("error", (err) => {
        logger.error(`tmux tail error: ${err}`);
        cleanup("error");
        rl.close();
      });
    });
  } catch (err) {
    activeSessions.delete(issueId);
    logger.error(`runInTmux failed: ${err}`);
    return {
      success: false,
      output: `Failed to start tmux session: ${err}`,
      error: String(err),
    };
  }
}
