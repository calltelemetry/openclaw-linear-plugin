import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { runAgent } from "../agent/agent.js";

/**
 * Create orchestration tools that let agents delegate work to other crew agents.
 *
 * - spawn_agent: Fire-and-forget parallel delegation (non-blocking)
 * - ask_agent: Synchronous question-answer with another agent
 */
export function createOrchestrationTools(
  api: OpenClawPluginApi,
  _ctx: Record<string, unknown>,
): AnyAgentTool[] {
  return [
    {
      name: "spawn_agent",
      label: "Spawn Agent",
      description:
        "Delegate a task to another crew agent. Runs in the background — does not block. " +
        "Use this when you want to parallelize work (e.g., ask kaylee to investigate DB performance " +
        "while you continue working on something else).",
      parameters: {
        type: "object",
        properties: {
          agentId: {
            type: "string",
            description:
              "Which agent to dispatch (e.g., 'kaylee', 'inara', 'mal'). Must match an agent ID in openclaw.json.",
          },
          task: {
            type: "string",
            description: "Description of what the sub-agent should do.",
          },
          timeoutSeconds: {
            type: "number",
            description: "Max runtime in seconds (default: 300).",
          },
        },
        required: ["agentId", "task"],
      },
      execute: async (_toolCallId: string, { agentId, task, timeoutSeconds }: {
        agentId: string;
        task: string;
        timeoutSeconds?: number;
      }) => {
        const timeout = (timeoutSeconds ?? 300) * 1000;
        const sessionId = `spawn-${agentId}-${Date.now()}`;

        api.logger.info(`spawn_agent: dispatching ${agentId} — "${task.slice(0, 80)}..."`);

        // Fire and forget — don't await the full result
        const resultPromise = runAgent({
          api,
          agentId,
          sessionId,
          message: task,
          timeoutMs: timeout,
        });

        // Store the promise so it can be retrieved later if needed
        resultPromise.catch((err) => {
          api.logger.error(`spawn_agent ${agentId} failed: ${err}`);
        });

        return jsonResult({
          message: `Dispatched task to agent '${agentId}'. It is running in the background.`,
          agentId,
          sessionId,
        });
      },
    } as unknown as AnyAgentTool,

    {
      name: "ask_agent",
      label: "Ask Agent",
      description:
        "Ask another crew agent a question and wait for their reply. " +
        "Use this when you need a specific answer before proceeding " +
        "(e.g., 'wash, would this schema change break existing tests?').",
      parameters: {
        type: "object",
        properties: {
          agentId: {
            type: "string",
            description:
              "Which agent to ask (e.g., 'kaylee', 'inara', 'mal'). Must match an agent ID in openclaw.json.",
          },
          message: {
            type: "string",
            description: "The question or request for the other agent.",
          },
          timeoutSeconds: {
            type: "number",
            description: "How long to wait for a reply in seconds (default: 120).",
          },
        },
        required: ["agentId", "message"],
      },
      execute: async (_toolCallId: string, { agentId, message, timeoutSeconds }: {
        agentId: string;
        message: string;
        timeoutSeconds?: number;
      }) => {
        const timeout = (timeoutSeconds ?? 120) * 1000;
        const sessionId = `ask-${agentId}-${Date.now()}`;

        api.logger.info(`ask_agent: asking ${agentId} — "${message.slice(0, 80)}..."`);

        const result = await runAgent({
          api,
          agentId,
          sessionId,
          message,
          timeoutMs: timeout,
        });

        if (!result.success) {
          return jsonResult({
            message: `Agent '${agentId}' failed to respond.`,
            error: result.output.slice(0, 1000),
            agentId,
          });
        }

        return jsonResult({
          message: `Response from agent '${agentId}':`,
          agentId,
          response: result.output,
        });
      },
    } as unknown as AnyAgentTool,
  ];
}
