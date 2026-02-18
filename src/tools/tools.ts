import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createCodeTool } from "./code-tool.js";
import { createOrchestrationTools } from "./orchestration-tools.js";

export function createLinearTools(api: OpenClawPluginApi, ctx: Record<string, unknown>): any[] {
  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;

  // Unified code_run tool — dispatches to configured backend (claude/codex/gemini)
  const codeTools: AnyAgentTool[] = [];
  try {
    codeTools.push(createCodeTool(api, ctx));
  } catch (err) {
    api.logger.warn(`code_run tool not available: ${err}`);
  }

  // Orchestration tools (conditional on config — defaults to enabled)
  const orchestrationTools: AnyAgentTool[] = [];
  const enableOrchestration = pluginConfig?.enableOrchestration !== false;
  if (enableOrchestration) {
    try {
      orchestrationTools.push(...createOrchestrationTools(api, ctx));
    } catch (err) {
      api.logger.warn(`Orchestration tools not available: ${err}`);
    }
  }

  // Linear issue management (list, create, update, close, comment, etc.)
  // is handled by the `linearis` skill — no custom tools needed here.

  return [
    ...codeTools,
    ...orchestrationTools,
  ];
}
