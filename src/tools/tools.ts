import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createCodeTool } from "./code-tool.js";
import { createOrchestrationTools } from "./orchestration-tools.js";
import { createLinearIssuesTool } from "./linear-issues-tool.js";

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

  // Linear issue management — native GraphQL API tool
  const linearIssuesTools: AnyAgentTool[] = [];
  try {
    linearIssuesTools.push(createLinearIssuesTool(api));
  } catch (err) {
    api.logger.warn(`linear_issues tool not available: ${err}`);
  }

  return [
    ...codeTools,
    ...orchestrationTools,
    ...linearIssuesTools,
  ];
}
