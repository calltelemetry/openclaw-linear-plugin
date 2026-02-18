import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { LinearAgentApi, ActivityContent } from "./linear-api.js";
import { runAgent } from "./agent.js";
import { setActiveSession, clearActiveSession } from "./active-session.js";
import type { Tier } from "./dispatch-state.js";
import { runCodex } from "./codex-tool.js";
import { runClaude } from "./claude-tool.js";
import { runGemini } from "./gemini-tool.js";
import { resolveCodingBackend, loadCodingConfig, type CodingBackend } from "./code-tool.js";
import type { CliResult } from "./cli-shared.js";

export interface PipelineContext {
  api: OpenClawPluginApi;
  linearApi: LinearAgentApi;
  agentSessionId: string;
  agentId: string;
  issue: {
    id: string;
    identifier: string;
    title: string;
    description?: string | null;
  };
  promptContext?: unknown;
  /** Populated by implementor stage if Codex creates a worktree */
  worktreePath?: string | null;
  /** Codex branch name, e.g. codex/UAT-123 */
  codexBranch?: string | null;
  /** Complexity tier selected by tier assessment */
  tier?: Tier;
  /** Tier model ID — for display/tracking only, NOT passed to coding CLI */
  model?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(ctx: PipelineContext, content: ActivityContent): Promise<void> {
  return ctx.linearApi.emitActivity(ctx.agentSessionId, content).catch((err) => {
    ctx.api.logger.error(`[${ctx.issue.identifier}] emit failed: ${err}`);
  });
}

/** Resolve the agent's model string from config for logging/display. */
function resolveAgentModel(api: OpenClawPluginApi, agentId: string): string {
  try {
    const config = (api as any).runtime?.config?.getCachedConfig?.() ?? {};
    const agents = config?.agents?.list as Array<Record<string, any>> | undefined;
    const entry = agents?.find((a) => a.id === agentId);
    const modelRef: string =
      entry?.model?.primary ??
      config?.agents?.defaults?.model?.primary ??
      "unknown";
    // Strip provider prefix for display: "openrouter/moonshotai/kimi-k2.5" → "kimi-k2.5"
    const parts = modelRef.split("/");
    return parts.length > 1 ? parts.slice(1).join("/") : modelRef;
  } catch {
    return "unknown";
  }
}

function elapsed(startMs: number): string {
  const sec = ((Date.now() - startMs) / 1000).toFixed(1);
  return `${sec}s`;
}

function toolContext(ctx: PipelineContext): string {
  const lines = [
    `\n## code_run Tool`,
    `When calling \`code_run\`, pass these parameters:`,
  ];
  lines.push(`- \`prompt\`: describe what to implement (be specific — file paths, function names, expected behavior)`);
  if (ctx.worktreePath) {
    lines.push(`- \`workingDir\`: \`"${ctx.worktreePath}"\``);
  }
  // Don't suggest model override — each coding CLI uses its own configured model
  lines.push(`Progress streams to Linear automatically. The worktree is an isolated git branch for this issue.`);
  return lines.join("\n");
}

const TAG = (ctx: PipelineContext) => `Pipeline [${ctx.issue.identifier}]`;

// ---------------------------------------------------------------------------
// Stage 1: Planner
// ---------------------------------------------------------------------------

export async function runPlannerStage(ctx: PipelineContext): Promise<string | null> {
  const t0 = Date.now();
  const agentModel = resolveAgentModel(ctx.api, ctx.agentId);

  ctx.api.logger.info(`${TAG(ctx)} stage 1/3: planner starting (agent=${ctx.agentId}, model=${agentModel})`);
  await emit(ctx, {
    type: "thought",
    body: `[1/3 Plan] Analyzing ${ctx.issue.identifier} with ${ctx.agentId} (${agentModel})...`,
  });

  const issueDetails = await ctx.linearApi.getIssueDetails(ctx.issue.id).catch(() => null);

  const description = issueDetails?.description ?? ctx.issue.description ?? "(no description)";
  const comments = issueDetails?.comments?.nodes ?? [];
  const commentSummary = comments
    .slice(-5)
    .map((c) => `${c.user?.name ?? "Unknown"}: ${c.body}`)
    .join("\n");

  const message = `You are a planner agent. Analyze this Linear issue and create an implementation plan.

## Issue: ${ctx.issue.identifier} — ${ctx.issue.title}

**Description:**
${description}

${commentSummary ? `**Recent comments:**\n${commentSummary}` : ""}

${ctx.promptContext ? `**Additional context:**\n${JSON.stringify(ctx.promptContext)}` : ""}

## Instructions
1. Analyze the issue thoroughly
2. Break it into concrete implementation steps
3. Identify files that need to change
4. Note any risks or dependencies
5. Output your plan in markdown format

IMPORTANT: Do NOT call code_run or any coding tools. Your job is ONLY to analyze and write a plan. The implementor stage will execute the plan using code_run after you're done.

Output ONLY the plan, nothing else.`;

  await emit(ctx, {
    type: "action",
    action: "Planning",
    parameter: `${ctx.issue.identifier} — agent: ${ctx.agentId} (${agentModel})`,
  });

  const sessionId = `linear-plan-${ctx.agentSessionId}`;
  ctx.api.logger.info(`${TAG(ctx)} planner: spawning agent session=${sessionId}`);

  const result = await runAgent({
    api: ctx.api,
    agentId: ctx.agentId,
    sessionId,
    message,
    timeoutMs: 5 * 60_000,
  });

  if (!result.success) {
    ctx.api.logger.error(`${TAG(ctx)} planner failed after ${elapsed(t0)}: ${result.output.slice(0, 300)}`);
    await emit(ctx, {
      type: "error",
      body: `[1/3 Plan] Failed after ${elapsed(t0)}: ${result.output.slice(0, 400)}`,
    });
    return null;
  }

  const plan = result.output;
  ctx.api.logger.info(`${TAG(ctx)} planner completed in ${elapsed(t0)} (${plan.length} chars)`);

  // Post plan as a Linear comment
  await ctx.linearApi.createComment(
    ctx.issue.id,
    `## Implementation Plan\n\n${plan}\n\n---\n*Proceeding to implementation...*`,
  );

  await emit(ctx, {
    type: "action",
    action: "Plan complete",
    parameter: `${ctx.issue.identifier} — ${elapsed(t0)}, moving to implementation`,
  });

  return plan;
}

// ---------------------------------------------------------------------------
// Stage 2: Implementor
// ---------------------------------------------------------------------------
//
// Deterministic: pipeline CODE calls the coding CLI directly.
// The agent model only evaluates results between runs.

const BACKEND_RUNNERS: Record<
  CodingBackend,
  (api: OpenClawPluginApi, params: any, pluginConfig?: Record<string, unknown>) => Promise<CliResult>
> = {
  codex: runCodex,
  claude: runClaude,
  gemini: runGemini,
};

export async function runImplementorStage(
  ctx: PipelineContext,
  plan: string,
): Promise<string | null> {
  const t0 = Date.now();
  const agentModel = resolveAgentModel(ctx.api, ctx.agentId);
  const pluginConfig = (ctx.api as any).pluginConfig as Record<string, unknown> | undefined;

  // Resolve coding backend from config (coding-tools.json)
  const codingConfig = loadCodingConfig();
  const backend = resolveCodingBackend(codingConfig);
  const runner = BACKEND_RUNNERS[backend];
  const backendName = backend.charAt(0).toUpperCase() + backend.slice(1);

  ctx.api.logger.info(
    `${TAG(ctx)} stage 2/3: implementor starting ` +
    `(coding_cli=${backendName}, tier=${ctx.tier ?? "unknown"}, ` +
    `worktree=${ctx.worktreePath ?? "default"}, ` +
    `eval_agent=${ctx.agentId}, eval_model=${agentModel})`,
  );

  await emit(ctx, {
    type: "thought",
    body: `[2/3 Implement] Starting ${backendName} CLI → ${ctx.worktreePath ?? "default workspace"}`,
  });

  // Build the implementation prompt for the coding CLI
  const codePrompt = [
    `Implement the following plan for issue ${ctx.issue.identifier} — ${ctx.issue.title}.`,
    ``,
    `## Plan`,
    plan,
    ``,
    `## Instructions`,
    `- Follow the plan step by step`,
    `- Create commits for each logical change`,
    `- Run tests if the project has them`,
    `- Stay within scope of the plan`,
  ].join("\n");

  await emit(ctx, {
    type: "action",
    action: `Running ${backendName}`,
    parameter: `${ctx.tier ?? "unknown"} tier — worktree: ${ctx.worktreePath ?? "default"}`,
  });

  // Call the coding CLI directly — deterministic, not LLM choice.
  // NOTE: Do NOT pass ctx.model here. The tier model (e.g. anthropic/claude-sonnet-4-6)
  // is for tracking/display only. Each coding CLI uses its own configured model.
  ctx.api.logger.info(`${TAG(ctx)} implementor: invoking ${backendName} CLI (no model override — CLI uses its own config)`);
  const cliStart = Date.now();

  const codeResult = await runner(ctx.api, {
    prompt: codePrompt,
    workingDir: ctx.worktreePath ?? undefined,
    timeoutMs: 10 * 60_000,
  }, pluginConfig);

  const cliElapsed = elapsed(cliStart);

  if (!codeResult.success) {
    ctx.api.logger.warn(
      `${TAG(ctx)} implementor: ${backendName} CLI failed after ${cliElapsed} — ` +
      `error: ${codeResult.error ?? "unknown"}, output: ${codeResult.output.slice(0, 300)}`,
    );
    await emit(ctx, {
      type: "error",
      body: `[2/3 Implement] ${backendName} failed after ${cliElapsed}: ${(codeResult.error ?? codeResult.output).slice(0, 400)}`,
    });

    // Ask the agent to evaluate the failure
    ctx.api.logger.info(`${TAG(ctx)} implementor: spawning ${ctx.agentId} (${agentModel}) to evaluate failure`);
    await emit(ctx, {
      type: "action",
      action: "Evaluating failure",
      parameter: `${ctx.agentId} (${agentModel}) analyzing ${backendName} error`,
    });

    const evalResult = await runAgent({
      api: ctx.api,
      agentId: ctx.agentId,
      sessionId: `linear-impl-eval-${ctx.agentSessionId}`,
      message: `${backendName} failed to implement the plan for ${ctx.issue.identifier}.\n\n## Plan\n${plan}\n\n## ${backendName} Output\n${codeResult.output.slice(0, 3000)}\n\n## Error\n${codeResult.error ?? "unknown"}\n\nAnalyze the failure. Summarize what went wrong and suggest next steps. Be concise.`,
      timeoutMs: 2 * 60_000,
    });

    const failureSummary = evalResult.success
      ? evalResult.output
      : `Implementation failed and evaluation also failed: ${codeResult.output.slice(0, 500)}`;

    await ctx.linearApi.createComment(
      ctx.issue.id,
      `## Implementation Failed\n\n**Backend:** ${backendName} (ran for ${cliElapsed})\n**Tier:** ${ctx.tier ?? "unknown"}\n\n${failureSummary}`,
    );

    return null;
  }

  ctx.api.logger.info(`${TAG(ctx)} implementor: ${backendName} CLI completed in ${cliElapsed} (${codeResult.output.length} chars output)`);

  // Ask the agent to evaluate the result
  const evalMessage = [
    `${backendName} completed implementation for ${ctx.issue.identifier}. Evaluate the result.`,
    ``,
    `## Original Plan`,
    plan,
    ``,
    `## ${backendName} Output`,
    codeResult.output.slice(0, 5000),
    ``,
    `## Worktree`,
    `Path: ${ctx.worktreePath ?? "default"}`,
    `Branch: ${ctx.codexBranch ?? "unknown"}`,
    ``,
    `Summarize what was implemented, any issues found, and whether the plan was fully executed. Be concise.`,
  ].join("\n");

  ctx.api.logger.info(`${TAG(ctx)} implementor: spawning ${ctx.agentId} (${agentModel}) to evaluate results`);
  await emit(ctx, {
    type: "action",
    action: "Evaluating results",
    parameter: `${ctx.agentId} (${agentModel}) reviewing ${backendName} output`,
  });

  const evalStart = Date.now();
  const evalResult = await runAgent({
    api: ctx.api,
    agentId: ctx.agentId,
    sessionId: `linear-impl-eval-${ctx.agentSessionId}`,
    message: evalMessage,
    timeoutMs: 3 * 60_000,
  });

  const summary = evalResult.success
    ? evalResult.output
    : `Implementation completed but evaluation failed. ${backendName} output:\n${codeResult.output.slice(0, 2000)}`;

  ctx.api.logger.info(
    `${TAG(ctx)} implementor: evaluation ${evalResult.success ? "succeeded" : "failed"} in ${elapsed(evalStart)}, ` +
    `total stage time: ${elapsed(t0)}`,
  );

  await emit(ctx, {
    type: "action",
    action: "Implementation complete",
    parameter: `${backendName} ${cliElapsed} + eval ${elapsed(evalStart)} = ${elapsed(t0)} total`,
  });

  return summary;
}

// ---------------------------------------------------------------------------
// Stage 3: Auditor
// ---------------------------------------------------------------------------

export async function runAuditorStage(
  ctx: PipelineContext,
  plan: string,
  implResult: string,
): Promise<void> {
  const t0 = Date.now();
  const agentModel = resolveAgentModel(ctx.api, ctx.agentId);

  ctx.api.logger.info(
    `${TAG(ctx)} stage 3/3: auditor starting (agent=${ctx.agentId}, model=${agentModel})`,
  );
  await emit(ctx, {
    type: "thought",
    body: `[3/3 Audit] Reviewing implementation with ${ctx.agentId} (${agentModel})...`,
  });

  const worktreeInfo = ctx.worktreePath
    ? `\n## Worktree\nCode changes are at: \`${ctx.worktreePath}\` (branch: \`${ctx.codexBranch ?? "unknown"}\`)\n`
    : "";

  const message = `You are an auditor. Review this implementation against the original plan.

## Issue: ${ctx.issue.identifier} — ${ctx.issue.title}

## Original Plan:
${plan}

## Implementation Result:
${implResult}
${worktreeInfo}
## Instructions
1. Verify each plan step was completed
2. Check for any missed items — use \`ask_agent\` / \`spawn_agent\` for specialized review if needed
3. Note any concerns or improvements needed
4. Provide a pass/fail verdict with reasoning
5. Output a concise audit summary in markdown
${toolContext(ctx)}

Output ONLY the audit summary.`;

  const sessionId = `linear-audit-${ctx.agentSessionId}`;
  ctx.api.logger.info(`${TAG(ctx)} auditor: spawning agent session=${sessionId}`);

  await emit(ctx, {
    type: "action",
    action: "Auditing",
    parameter: `${ctx.issue.identifier} — agent: ${ctx.agentId} (${agentModel})`,
  });

  const result = await runAgent({
    api: ctx.api,
    agentId: ctx.agentId,
    sessionId,
    message,
    timeoutMs: 5 * 60_000,
  });

  const auditSummary = result.success
    ? result.output
    : `Audit failed: ${result.output.slice(0, 500)}`;

  ctx.api.logger.info(
    `${TAG(ctx)} auditor: ${result.success ? "completed" : "failed"} in ${elapsed(t0)} (${auditSummary.length} chars)`,
  );

  await ctx.linearApi.createComment(
    ctx.issue.id,
    `## Audit Report\n\n${auditSummary}`,
  );

  await emit(ctx, {
    type: "response",
    body: `[3/3 Audit] ${result.success ? "Complete" : "Failed"} (${elapsed(t0)}). ` +
      `All stages done for ${ctx.issue.identifier}. Plan, implementation, and audit posted as comments.`,
  });
}

// ---------------------------------------------------------------------------
// Full Pipeline
// ---------------------------------------------------------------------------
//
// Runs all three stages sequentially: plan → implement → audit.
// Assignment is the trigger AND the approval — no pause between stages.
// Each stage's result feeds into the next. If any stage fails, the
// pipeline stops and reports the error.

export async function runFullPipeline(ctx: PipelineContext): Promise<void> {
  const t0 = Date.now();
  const agentModel = resolveAgentModel(ctx.api, ctx.agentId);
  const codingConfig = loadCodingConfig();
  const codingBackend = resolveCodingBackend(codingConfig);

  ctx.api.logger.info(
    `${TAG(ctx)} === PIPELINE START === ` +
    `agent=${ctx.agentId}, agent_model=${agentModel}, ` +
    `coding_cli=${codingBackend}, tier=${ctx.tier ?? "unknown"}, ` +
    `worktree=${ctx.worktreePath ?? "none"}, ` +
    `branch=${ctx.codexBranch ?? "none"}, ` +
    `session=${ctx.agentSessionId}`,
  );

  // Register active session so tools (code_run) can resolve it
  setActiveSession({
    agentSessionId: ctx.agentSessionId,
    issueIdentifier: ctx.issue.identifier,
    issueId: ctx.issue.id,
    agentId: ctx.agentId,
    startedAt: Date.now(),
  });

  await emit(ctx, {
    type: "thought",
    body: `Pipeline started for ${ctx.issue.identifier} — ` +
      `agent: ${ctx.agentId} (${agentModel}), ` +
      `coding: ${codingBackend}, ` +
      `tier: ${ctx.tier ?? "unknown"}`,
  });

  try {
    // Stage 1: Plan
    const plan = await runPlannerStage(ctx);
    if (!plan) {
      ctx.api.logger.error(`${TAG(ctx)} planner produced no plan — aborting after ${elapsed(t0)}`);
      await emit(ctx, {
        type: "error",
        body: `Pipeline aborted — planning stage failed after ${elapsed(t0)}. No plan produced.`,
      });
      return;
    }

    // Stage 2: Implement
    const implResult = await runImplementorStage(ctx, plan);
    if (!implResult) {
      ctx.api.logger.error(`${TAG(ctx)} implementor failed — aborting after ${elapsed(t0)}`);
      await emit(ctx, {
        type: "error",
        body: `Pipeline aborted — implementation stage failed after ${elapsed(t0)}.`,
      });
      return;
    }

    // Stage 3: Audit
    await runAuditorStage(ctx, plan, implResult);

    ctx.api.logger.info(
      `${TAG(ctx)} === PIPELINE COMPLETE === total time: ${elapsed(t0)}`,
    );
  } catch (err) {
    ctx.api.logger.error(`${TAG(ctx)} === PIPELINE ERROR === after ${elapsed(t0)}: ${err}`);
    await emit(ctx, {
      type: "error",
      body: `Pipeline crashed after ${elapsed(t0)}: ${String(err).slice(0, 400)}`,
    });
  } finally {
    clearActiveSession(ctx.issue.id);
  }
}
