import { createCodeTools } from "./code-tool.js";
import { createOrchestrationTools } from "./orchestration-tools.js";
import { createLinearIssuesTool } from "./linear-issues-tool.js";
import { createSteeringTools } from "./steering-tools.js";
export function createLinearTools(api, ctx) {
    const pluginConfig = api.pluginConfig;
    // Per-backend coding CLI tools: cli_codex, cli_claude, cli_gemini
    const codeTools = [];
    try {
        codeTools.push(...createCodeTools(api, ctx));
    }
    catch (err) {
        api.logger.warn(`CLI coding tools not available: ${err}`);
    }
    // Orchestration tools (conditional on config — defaults to enabled)
    const orchestrationTools = [];
    const enableOrchestration = pluginConfig?.enableOrchestration !== false;
    if (enableOrchestration) {
        try {
            orchestrationTools.push(...createOrchestrationTools(api, ctx));
        }
        catch (err) {
            api.logger.warn(`Orchestration tools not available: ${err}`);
        }
    }
    // Linear issue management — native GraphQL API tool
    const linearIssuesTools = [];
    try {
        linearIssuesTools.push(createLinearIssuesTool(api));
    }
    catch (err) {
        api.logger.warn(`linear_issues tool not available: ${err}`);
    }
    // Steering tools (steer/capture/abort active tmux agent sessions)
    const steeringTools = [];
    const enableTmux = pluginConfig?.enableTmux !== false;
    if (enableTmux) {
        try {
            steeringTools.push(...createSteeringTools(api, ctx));
        }
        catch (err) {
            api.logger.warn(`Steering tools not available: ${err}`);
        }
    }
    return [
        ...codeTools,
        ...orchestrationTools,
        ...linearIssuesTools,
        ...steeringTools,
    ];
}
