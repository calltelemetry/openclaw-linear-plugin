/**
 * planner.ts — Orchestration for the project planning pipeline.
 *
 * Manages the interview-style planning flow:
 * - initiatePlanningSession: enters planning mode for a project
 * - handlePlannerTurn: processes each user comment during planning
 * - runPlanAudit: validates the plan before finalizing
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { loadRawPromptYaml } from "./pipeline.js";
import type { LinearAgentApi } from "../api/linear-api.js";
import { runAgent } from "../agent/agent.js";
import {
  type PlanningSession,
  registerPlanningSession,
  updatePlanningSession,
  endPlanningSession,
  setPlanningCache,
} from "./planning-state.js";
import {
  setActivePlannerContext,
  clearActivePlannerContext,
  buildPlanSnapshot,
  auditPlan,
} from "../tools/planner-tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlannerContext {
  api: OpenClawPluginApi;
  linearApi: LinearAgentApi;
  pluginConfig?: Record<string, unknown>;
}

interface PlannerPrompts {
  system: string;
  interview: string;
  audit_prompt: string;
  welcome: string;
}

// ---------------------------------------------------------------------------
// Prompt loading
// ---------------------------------------------------------------------------

function loadPlannerPrompts(pluginConfig?: Record<string, unknown>): PlannerPrompts {
  const defaults: PlannerPrompts = {
    system: "You are a product planning specialist. Interview the user about features and create Linear issues.",
    interview: "Project: {{projectName}}\n\nPlan:\n{{planSnapshot}}\n\nUser said: {{userMessage}}\n\nContinue planning.",
    audit_prompt: "Run audit_plan for {{projectName}}.",
    welcome: "Entering planning mode for **{{projectName}}**. What are the main feature areas?",
  };

  const parsed = loadRawPromptYaml(pluginConfig);
  if (parsed?.planner) {
    return {
      system: parsed.planner.system ?? defaults.system,
      interview: parsed.planner.interview ?? defaults.interview,
      audit_prompt: parsed.planner.audit_prompt ?? defaults.audit_prompt,
      welcome: parsed.planner.welcome ?? defaults.welcome,
    };
  }

  return defaults;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Planning initiation
// ---------------------------------------------------------------------------

export async function initiatePlanningSession(
  ctx: PlannerContext,
  projectId: string,
  rootIssue: { id: string; identifier: string; title: string; team?: { id: string } },
): Promise<void> {
  const { api, linearApi, pluginConfig } = ctx;
  const configPath = pluginConfig?.planningStatePath as string | undefined;

  // Fetch project metadata
  const project = await linearApi.getProject(projectId);
  const teamId = rootIssue.team?.id ?? project.teams?.nodes?.[0]?.id;
  if (!teamId) throw new Error(`Cannot determine team for project ${projectId}`);

  // Fetch team states for reference
  await linearApi.getTeamStates(teamId);

  // Register session
  const session: PlanningSession = {
    projectId,
    projectName: project.name,
    rootIssueId: rootIssue.id,
    rootIdentifier: rootIssue.identifier,
    teamId,
    status: "interviewing",
    startedAt: new Date().toISOString(),
    turnCount: 0,
  };

  await registerPlanningSession(projectId, session, configPath);
  setPlanningCache(session);

  api.logger.info(`Planning: initiated session for ${project.name} (${rootIssue.identifier})`);

  // Post welcome comment
  const prompts = loadPlannerPrompts(pluginConfig);
  const welcomeMsg = renderTemplate(prompts.welcome, {
    projectName: project.name,
    rootIdentifier: rootIssue.identifier,
  });
  await linearApi.createComment(rootIssue.id, welcomeMsg);
}

// ---------------------------------------------------------------------------
// Interview turn
// ---------------------------------------------------------------------------

const FINALIZE_PATTERN = /\b(finalize\s+(the\s+)?plan\b|done\s+planning\b(?!\s+\w)|approve\s+(the\s+)?plan\b|plan\s+looks\s+good\b|ready\s+to\s+finalize\b|let'?s\s+finalize\b)/i;
const ABANDON_PATTERN = /\b(abandon\s+plan(ning)?|cancel\s+plan(ning)?|stop\s+planning|exit\s+planning|quit\s+planning)\b/i;

export async function handlePlannerTurn(
  ctx: PlannerContext,
  session: PlanningSession,
  input: { issueId: string; commentBody: string; commentorName: string },
  opts?: { onApproved?: (projectId: string) => void },
): Promise<void> {
  const { api, linearApi, pluginConfig } = ctx;
  const configPath = pluginConfig?.planningStatePath as string | undefined;

  // Detect finalization intent
  if (FINALIZE_PATTERN.test(input.commentBody)) {
    await runPlanAudit(ctx, session, { onApproved: opts?.onApproved });
    return;
  }

  // Detect abandon intent
  if (ABANDON_PATTERN.test(input.commentBody)) {
    await endPlanningSession(session.projectId, "abandoned", configPath);
    await linearApi.createComment(
      session.rootIssueId,
      `Planning mode ended for **${session.projectName}**. Session abandoned.`,
    );
    api.logger.info(`Planning: session abandoned for ${session.projectName}`);
    return;
  }

  // Increment turn count
  const newTurnCount = session.turnCount + 1;
  await updatePlanningSession(session.projectId, { turnCount: newTurnCount }, configPath);

  // Build plan snapshot
  const issues = await linearApi.getProjectIssues(session.projectId);
  const planSnapshot = buildPlanSnapshot(issues);

  // Build comment history (last 10 comments on root issue)
  let commentHistory = "";
  try {
    const details = await linearApi.getIssueDetails(session.rootIssueId);
    commentHistory = details.comments?.nodes
      ?.map((c) => `**${c.user?.name ?? "Unknown"}:** ${c.body.slice(0, 300)}`)
      .join("\n\n") ?? "";
  } catch { /* best effort */ }

  // Build prompt
  const prompts = loadPlannerPrompts(pluginConfig);
  const taskPrompt = renderTemplate(prompts.interview, {
    projectName: session.projectName,
    rootIdentifier: session.rootIdentifier,
    planSnapshot,
    turnCount: String(newTurnCount),
    commentHistory,
    userMessage: input.commentBody,
  });

  // Set planner context for tools
  setActivePlannerContext({
    linearApi,
    projectId: session.projectId,
    teamId: session.teamId,
  });

  try {
    const sessionId = `planner-${session.rootIdentifier}-turn-${newTurnCount}`;
    const agentId = (pluginConfig?.defaultAgentId as string) ?? "default";

    api.logger.info(`Planning: turn ${newTurnCount} for ${session.projectName}`);

    const result = await runAgent({
      api,
      agentId,
      sessionId,
      message: `${prompts.system}\n\n${taskPrompt}`,
    });

    // Post agent response as comment
    if (result.output) {
      await linearApi.createComment(session.rootIssueId, result.output);
    }
  } finally {
    clearActivePlannerContext();
  }
}

// ---------------------------------------------------------------------------
// Plan audit
// ---------------------------------------------------------------------------

export async function runPlanAudit(
  ctx: PlannerContext,
  session: PlanningSession,
  opts?: { onApproved?: (projectId: string) => void },
): Promise<void> {
  const { api, linearApi, pluginConfig } = ctx;
  const configPath = pluginConfig?.planningStatePath as string | undefined;

  api.logger.info(`Planning: running audit for ${session.projectName}`);

  // Run deterministic audit
  const issues = await linearApi.getProjectIssues(session.projectId);
  const result = auditPlan(issues);

  if (result.pass) {
    // Build final summary
    const snapshot = buildPlanSnapshot(issues);
    const warningsList = result.warnings.length > 0
      ? `\n\n**Warnings:**\n${result.warnings.map((w) => `- ${w}`).join("\n")}`
      : "";

    await linearApi.createComment(
      session.rootIssueId,
      `## Plan Approved\n\n` +
      `The plan for **${session.projectName}** passed all checks.\n\n` +
      `**${issues.length} issues** created with valid dependency graph.${warningsList}\n\n` +
      `### Final Plan\n${snapshot}\n\n` +
      `---\n*Planning mode complete. Project is ready for implementation dispatch.*`,
    );

    await endPlanningSession(session.projectId, "approved", configPath);
    api.logger.info(`Planning: session approved for ${session.projectName}`);

    // Trigger DAG-based dispatch if callback provided
    opts?.onApproved?.(session.projectId);
  } else {
    // Post problems and keep planning
    const problemsList = result.problems.map((p) => `- ${p}`).join("\n");
    const warningsList = result.warnings.length > 0
      ? `\n\n**Warnings:**\n${result.warnings.map((w) => `- ${w}`).join("\n")}`
      : "";

    await linearApi.createComment(
      session.rootIssueId,
      `## Plan Audit Failed\n\n` +
      `The following issues need attention before the plan can be approved:\n\n` +
      `**Problems:**\n${problemsList}${warningsList}\n\n` +
      `Please address these issues, then say "finalize plan" again.`,
    );

    api.logger.info(`Planning: audit failed for ${session.projectName} (${result.problems.length} problems)`);
  }
}
