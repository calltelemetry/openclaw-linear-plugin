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
import { runClaude } from "../tools/claude-tool.js";
import { runCodex } from "../tools/codex-tool.js";
import { runGemini } from "../tools/gemini-tool.js";

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
  review: string;
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
    review: "Plan for {{projectName}} passed checks. {{reviewModel}} recommends:\n{{crossModelFeedback}}\n\nReview and suggest changes, then invite the user to approve.",
  };

  const parsed = loadRawPromptYaml(pluginConfig);
  if (parsed?.planner) {
    return {
      system: parsed.planner.system ?? defaults.system,
      interview: parsed.planner.interview ?? defaults.interview,
      audit_prompt: parsed.planner.audit_prompt ?? defaults.audit_prompt,
      welcome: parsed.planner.welcome ?? defaults.welcome,
      review: parsed.planner.review ?? defaults.review,
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

/**
 * Handle a planning conversation turn. Intent detection (finalize/abandon)
 * is handled by the webhook via intent-classify.ts before calling this function.
 * This is a pure "continue planning" function.
 */
export async function handlePlannerTurn(
  ctx: PlannerContext,
  session: PlanningSession,
  input: { issueId: string; commentBody: string; commentorName: string },
): Promise<void> {
  const { api, linearApi, pluginConfig } = ctx;
  const configPath = pluginConfig?.planningStatePath as string | undefined;

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
    api,
    pluginConfig,
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
): Promise<void> {
  const { api, linearApi, pluginConfig } = ctx;
  const configPath = pluginConfig?.planningStatePath as string | undefined;

  api.logger.info(`Planning: running audit for ${session.projectName}`);

  // Run deterministic audit
  const issues = await linearApi.getProjectIssues(session.projectId);
  const result = auditPlan(issues);

  if (result.pass) {
    // Transition to plan_review (not approved yet — cross-model review first)
    await updatePlanningSession(session.projectId, { status: "plan_review" }, configPath);

    const snapshot = buildPlanSnapshot(issues);
    const warningsList = result.warnings.length > 0
      ? `\n\n**Warnings:**\n${result.warnings.map((w) => `- ${w}`).join("\n")}`
      : "";

    // Determine review model and post "running review" message
    const reviewModel = resolveReviewModel(pluginConfig);
    const reviewModelName = reviewModel.charAt(0).toUpperCase() + reviewModel.slice(1);

    await linearApi.createComment(
      session.rootIssueId,
      `## Plan Passed Checks\n\n` +
      `**${issues.length} issues** with valid dependency graph.${warningsList}\n\n` +
      `Let me have **${reviewModelName}** audit this and make recommendations.`,
    );

    // Run cross-model review
    const crossReview = await runCrossModelReview(api, reviewModel, snapshot, pluginConfig);

    // Run planner agent with review prompt + cross-model feedback
    const prompts = loadPlannerPrompts(pluginConfig);
    const reviewPrompt = renderTemplate(prompts.review, {
      projectName: session.projectName,
      planSnapshot: snapshot,
      issueCount: String(issues.length),
      reviewModel: reviewModelName,
      crossModelFeedback: crossReview,
    });

    const agentId = (pluginConfig?.defaultAgentId as string) ?? "default";

    setActivePlannerContext({
      linearApi,
      projectId: session.projectId,
      teamId: session.teamId,
      api,
      pluginConfig,
    });

    try {
      const agentResult = await runAgent({
        api,
        agentId,
        sessionId: `planner-${session.rootIdentifier}-review`,
        message: `${prompts.system}\n\n${reviewPrompt}`,
      });
      if (agentResult.output) {
        await linearApi.createComment(session.rootIssueId, agentResult.output);
      }
    } finally {
      clearActivePlannerContext();
    }

    api.logger.info(`Planning: entered plan_review for ${session.projectName} (reviewed by ${reviewModelName})`);
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

// ---------------------------------------------------------------------------
// Cross-model review
// ---------------------------------------------------------------------------

export async function runCrossModelReview(
  api: OpenClawPluginApi,
  model: "claude" | "codex" | "gemini",
  planSnapshot: string,
  pluginConfig?: Record<string, unknown>,
): Promise<string> {
  const prompt = `You are reviewing a project plan. Analyze it and suggest specific improvements.\n\n${planSnapshot}\n\nFocus on: missing acceptance criteria, dependency gaps, estimation accuracy, testability, and edge cases. Reference specific issue identifiers. Be concise and actionable.`;

  try {
    const runner = model === "claude" ? runClaude
      : model === "codex" ? runCodex
      : runGemini;
    const result = await runner(api, { prompt } as any, pluginConfig);
    return result.success ? (result.output ?? "(no feedback)") : `(${model} review failed: ${result.error})`;
  } catch (err) {
    api.logger.warn(`Cross-model review failed: ${err}`);
    return "(cross-model review unavailable)";
  }
}

export function resolveReviewModel(pluginConfig?: Record<string, unknown>): "claude" | "codex" | "gemini" {
  // User override in config
  const configured = (pluginConfig as any)?.plannerReviewModel as string | undefined;
  if (configured && ["claude", "codex", "gemini"].includes(configured)) {
    return configured as "claude" | "codex" | "gemini";
  }
  // Always the complement of the user's primary model
  const currentModel = (pluginConfig as any)?.agents?.defaults?.model?.primary as string ?? "";
  if (currentModel.includes("claude") || currentModel.includes("anthropic")) return "codex";
  if (currentModel.includes("codex") || currentModel.includes("openai")) return "gemini";
  if (currentModel.includes("gemini") || currentModel.includes("google")) return "codex";
  return "gemini"; // Kimi, Mistral, other, or unconfigured → Gemini reviews
}
