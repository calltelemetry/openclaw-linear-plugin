import { execSync } from "node:child_process";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { getActiveTmuxSession } from "../infra/tmux-runner.js";
import { capturePane, shellEscape } from "../infra/tmux.js";

/**
 * Create steering tools for interacting with active tmux agent sessions.
 *
 * - steer_agent: Send input to an active agent session via tmux send-keys
 * - capture_agent_output: Capture recent output from an agent's tmux pane
 * - abort_agent: Kill an active agent's tmux session
 */
export function createSteeringTools(
  api: OpenClawPluginApi,
  _ctx: Record<string, unknown>,
): AnyAgentTool[] {
  return [
    {
      name: "steer_agent",
      label: "Steer Agent",
      description:
        "Send a message to an active coding agent running in a tmux session. " +
        "Use this to provide information, answer questions, or redirect the agent's approach.",
      parameters: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "The Linear issue ID of the active agent session.",
          },
          message: {
            type: "string",
            description: "The message to send to the agent.",
          },
        },
        required: ["issueId", "message"],
      },
      async execute(params: { issueId: string; message: string }) {
        const session = getActiveTmuxSession(params.issueId);
        if (!session) {
          return jsonResult({ error: `No active tmux session for issue ${params.issueId}` });
        }

        if (session.steeringMode === "one-shot") {
          return jsonResult({
            error: `Agent ${session.backend} is in one-shot mode — steering via stdin is not supported.`,
          });
        }

        try {
          execSync(
            `tmux send-keys -t ${shellEscape(session.sessionName)} ${shellEscape(params.message)} Enter`,
            { stdio: "ignore", timeout: 5_000 },
          );
          return jsonResult({
            success: true,
            sessionName: session.sessionName,
            backend: session.backend,
          });
        } catch (err) {
          return jsonResult({ error: `Failed to steer agent: ${err}` });
        }
      },
    },
    {
      name: "capture_agent_output",
      label: "Capture Agent Output",
      description:
        "Capture the last 50 lines of output from an active coding agent's tmux session. " +
        "Use this to see what the agent is currently doing before deciding how to steer it.",
      parameters: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "The Linear issue ID of the active agent session.",
          },
          lines: {
            type: "number",
            description: "Number of lines to capture (default: 50).",
          },
        },
        required: ["issueId"],
      },
      async execute(params: { issueId: string; lines?: number }) {
        const session = getActiveTmuxSession(params.issueId);
        if (!session) {
          return jsonResult({ error: `No active tmux session for issue ${params.issueId}` });
        }

        try {
          const output = capturePane(session.sessionName, params.lines ?? 50);
          return jsonResult({
            sessionName: session.sessionName,
            backend: session.backend,
            output: output || "(empty pane)",
          });
        } catch (err) {
          return jsonResult({ error: `Failed to capture output: ${err}` });
        }
      },
    },
    {
      name: "abort_agent",
      label: "Abort Agent",
      description:
        "Kill an active coding agent's tmux session. Use this when the user wants to stop a running agent.",
      parameters: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "The Linear issue ID of the active agent session.",
          },
        },
        required: ["issueId"],
      },
      async execute(params: { issueId: string }) {
        const session = getActiveTmuxSession(params.issueId);
        if (!session) {
          return jsonResult({ error: `No active tmux session for issue ${params.issueId}` });
        }

        try {
          execSync(
            `tmux kill-session -t ${shellEscape(session.sessionName)}`,
            { stdio: "ignore", timeout: 5_000 },
          );
          return jsonResult({
            success: true,
            killed: session.sessionName,
            backend: session.backend,
          });
        } catch (err) {
          return jsonResult({ error: `Failed to abort agent: ${err}` });
        }
      },
    },
  ];
}
