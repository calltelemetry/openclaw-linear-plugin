/**
 * pipeline.ts — Dispatch pipeline v2: hook-driven with hard-enforced audit.
 *
 * v1 (runFullPipeline) ran plan→implement→audit in a single synchronous flow
 * with the same agent self-certifying its own work.
 *
 * v2 splits into:
 * - Worker phase: orchestrator spawns worker via plugin code, worker plans + implements
 * - Audit phase: agent_end hook auto-triggers independent audit (runAgent)
 * - Verdict phase: agent_end hook processes audit result → done/rework/stuck
 *
 * Prompts are loaded from prompts.yaml (sidecar file, customizable).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { LinearAgentApi, ActivityContent } from "../api/linear-api.js";
import { runAgent } from "../agent/agent.js";
import { setActiveSession, clearActiveSession } from "./active-session.js";
import {
  type Tier,
  type DispatchStatus,
  type ActiveDispatch,
  type DispatchState,
  type SessionMapping,
  transitionDispatch,
  registerSessionMapping,
  markEventProcessed,
  completeDispatch,
  TransitionError,
  readDispatchState,
  getActiveDispatch,
} from "./dispatch-state.js";
import { type NotifyFn } from "../infra/notify.js";
import {
  saveWorkerOutput,
  saveAuditVerdict,
  appendLog,
  updateManifest,
  writeSummary,
  buildSummaryFromArtifacts,
  writeDispatchMemory,
  resolveOrchestratorWorkspace,
} from "./artifacts.js";
import { resolveWatchdogConfig } from "../agent/watchdog.js";

// ---------------------------------------------------------------------------
// Prompt loading
// ---------------------------------------------------------------------------

interface PromptTemplates {
  worker: { system: string; task: string };
  audit: { system: string; task: string };
  rework: { addendum: string };
}

const DEFAULT_PROMPTS: PromptTemplates = {
  worker: {
    system: "You are implementing a Linear issue. Post an implementation summary as a Linear comment when done. DO NOT mark the issue as Done.",
    task: "Implement issue {{identifier}}: {{title}}\n\nIssue body:\n{{description}}\n\nWorktree: {{worktreePath}}",
  },
  audit: {
    system: "You are an independent auditor. The Linear issue body is the SOURCE OF TRUTH. Worker comments are secondary evidence.",
    task: 'Audit issue {{identifier}}: {{title}}\n\nIssue body:\n{{description}}\n\nWorktree: {{worktreePath}}\n\nReturn JSON verdict: {"pass": true/false, "criteria": [...], "gaps": [...], "testResults": "..."}',
  },
  rework: {
    addendum: "PREVIOUS AUDIT FAILED (attempt {{attempt}}). Gaps:\n{{gaps}}\n\nAddress these specific issues.",
  },
};

let _cachedPrompts: PromptTemplates | null = null;

export function loadPrompts(pluginConfig?: Record<string, unknown>): PromptTemplates {
  if (_cachedPrompts) return _cachedPrompts;

  try {
    // Try custom path first
    const customPath = pluginConfig?.promptsPath as string | undefined;
    let raw: string;

    if (customPath) {
      const resolved = customPath.startsWith("~")
        ? customPath.replace("~", process.env.HOME ?? "")
        : customPath;
      raw = readFileSync(resolved, "utf-8");
    } else {
      // Load from plugin directory (sidecar file)
      const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
      raw = readFileSync(join(pluginRoot, "prompts.yaml"), "utf-8");
    }

    const parsed = parseYaml(raw) as Partial<PromptTemplates>;
    _cachedPrompts = {
      worker: { ...DEFAULT_PROMPTS.worker, ...parsed.worker },
      audit: { ...DEFAULT_PROMPTS.audit, ...parsed.audit },
      rework: { ...DEFAULT_PROMPTS.rework, ...parsed.rework },
    };
  } catch {
    _cachedPrompts = DEFAULT_PROMPTS;
  }

  return _cachedPrompts;
}

/** Clear prompt cache (for testing or after config change) */
export function clearPromptCache(): void {
  _cachedPrompts = null;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Task builders
// ---------------------------------------------------------------------------

export interface IssueContext {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
}

/**
 * Build the task prompt for a worker sub-agent (sessions_spawn).
 * Includes rework addendum if attempt > 0.
 */
export function buildWorkerTask(
  issue: IssueContext,
  worktreePath: string,
  opts?: { attempt?: number; gaps?: string[]; pluginConfig?: Record<string, unknown> },
): { system: string; task: string } {
  const prompts = loadPrompts(opts?.pluginConfig);
  const vars: Record<string, string> = {
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "(no description)",
    worktreePath,
    tier: "",
    attempt: String(opts?.attempt ?? 0),
    gaps: opts?.gaps?.join("\n- ") ?? "",
  };

  let task = renderTemplate(prompts.worker.task, vars);
  if ((opts?.attempt ?? 0) > 0 && opts?.gaps?.length) {
    task += "\n\n" + renderTemplate(prompts.rework.addendum, vars);
  }

  return {
    system: renderTemplate(prompts.worker.system, vars),
    task,
  };
}

/**
 * Build the task prompt for an audit sub-agent (runAgent).
 */
export function buildAuditTask(
  issue: IssueContext,
  worktreePath: string,
  pluginConfig?: Record<string, unknown>,
): { system: string; task: string } {
  const prompts = loadPrompts(pluginConfig);
  const vars: Record<string, string> = {
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "(no description)",
    worktreePath,
    tier: "",
    attempt: "0",
    gaps: "",
  };

  return {
    system: renderTemplate(prompts.audit.system, vars),
    task: renderTemplate(prompts.audit.task, vars),
  };
}

// ---------------------------------------------------------------------------
// Verdict parsing
// ---------------------------------------------------------------------------

export interface AuditVerdict {
  pass: boolean;
  criteria: string[];
  gaps: string[];
  testResults: string;
}

/**
 * Parse the audit verdict JSON from the agent's output.
 * Looks for the last JSON object in the output that matches the verdict shape.
 */
export function parseVerdict(output: string): AuditVerdict | null {
  // Try to find JSON in the output (last occurrence)
  const jsonMatches = output.match(/\{[^{}]*"pass"\s*:\s*(true|false)[^{}]*\}/g);
  if (!jsonMatches?.length) return null;

  for (const match of jsonMatches.reverse()) {
    try {
      const parsed = JSON.parse(match);
      if (typeof parsed.pass === "boolean") {
        return {
          pass: parsed.pass,
          criteria: Array.isArray(parsed.criteria) ? parsed.criteria : [],
          gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
          testResults: typeof parsed.testResults === "string" ? parsed.testResults : "",
        };
      }
    } catch { /* try next match */ }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Hook handlers (called by agent_end hook in index.ts)
// ---------------------------------------------------------------------------

export interface HookContext {
  api: OpenClawPluginApi;
  linearApi: LinearAgentApi;
  notify: NotifyFn;
  pluginConfig?: Record<string, unknown>;
  configPath?: string;
}

/**
 * Triggered by agent_end hook when a worker sub-agent completes.
 * Transitions dispatch to "auditing" and spawns an independent audit agent.
 *
 * Idempotent: uses CAS transition + event dedup.
 */
export async function triggerAudit(
  hookCtx: HookContext,
  dispatch: ActiveDispatch,
  event: { messages?: unknown[]; success: boolean; output?: string },
  sessionKey: string,
): Promise<void> {
  const { api, linearApi, notify, pluginConfig, configPath } = hookCtx;
  const TAG = `[${dispatch.issueIdentifier}]`;

  // Dedup check
  const eventKey = `worker-end:${sessionKey}`;
  const isNew = await markEventProcessed(eventKey, configPath);
  if (!isNew) {
    api.logger.info(`${TAG} duplicate worker agent_end, skipping`);
    return;
  }

  // CAS transition: working → auditing
  try {
    await transitionDispatch(
      dispatch.issueIdentifier,
      "working",
      "auditing",
      undefined,
      configPath,
    );
  } catch (err) {
    if (err instanceof TransitionError) {
      api.logger.warn(`${TAG} CAS failed for audit trigger: ${err.message}`);
      return;
    }
    throw err;
  }

  api.logger.info(`${TAG} worker completed, triggering audit (attempt ${dispatch.attempt})`);

  // Update .claw/ manifest
  try { updateManifest(dispatch.worktreePath, { status: "auditing", attempts: dispatch.attempt }); } catch {}

  // Fetch fresh issue details for audit context
  const issueDetails = await linearApi.getIssueDetails(dispatch.issueId).catch(() => null);
  const issue: IssueContext = {
    id: dispatch.issueId,
    identifier: dispatch.issueIdentifier,
    title: issueDetails?.title ?? dispatch.issueIdentifier,
    description: issueDetails?.description,
  };

  // Build audit prompt from YAML templates
  const auditPrompt = buildAuditTask(issue, dispatch.worktreePath, pluginConfig);

  // Set Linear label
  await linearApi.emitActivity(dispatch.agentSessionId ?? "", {
    type: "thought",
    body: `Audit triggered for ${dispatch.issueIdentifier} (attempt ${dispatch.attempt})`,
  }).catch(() => {});

  await notify("auditing", {
    identifier: dispatch.issueIdentifier,
    title: issue.title,
    status: "auditing",
    attempt: dispatch.attempt,
  });

  // Spawn audit agent via runAgent (deterministic, plugin-level — NOT sessions_spawn)
  const auditSessionId = `linear-audit-${dispatch.issueIdentifier}-${dispatch.attempt}`;

  // Register session mapping so the agent_end hook can find this dispatch
  await registerSessionMapping(auditSessionId, {
    dispatchId: dispatch.issueIdentifier,
    phase: "audit",
    attempt: dispatch.attempt,
  }, configPath);

  // Update dispatch with audit session key
  const state = await readDispatchState(configPath);
  const activeDispatch = getActiveDispatch(state, dispatch.issueIdentifier);
  if (activeDispatch) {
    activeDispatch.auditSessionKey = auditSessionId;
  }

  api.logger.info(`${TAG} spawning audit agent session=${auditSessionId}`);

  const result = await runAgent({
    api,
    agentId: (pluginConfig?.defaultAgentId as string) ?? "default",
    sessionId: auditSessionId,
    message: `${auditPrompt.system}\n\n${auditPrompt.task}`,
    streaming: dispatch.agentSessionId
      ? { linearApi, agentSessionId: dispatch.agentSessionId }
      : undefined,
  });

  // runAgent returns inline (embedded runner) — process verdict directly.
  // The agent_end hook in index.ts serves as safety net for sessions_spawn.
  api.logger.info(`${TAG} audit completed inline (${result.output.length} chars, success=${result.success})`);

  await processVerdict(hookCtx, dispatch, {
    success: result.success,
    output: result.output,
  }, auditSessionId);
}

/**
 * Triggered by agent_end hook when an audit sub-agent completes.
 * Parses the verdict and transitions dispatch accordingly.
 *
 * Idempotent: uses CAS transition + event dedup.
 */
export async function processVerdict(
  hookCtx: HookContext,
  dispatch: ActiveDispatch,
  event: { messages?: unknown[]; success: boolean; output?: string },
  sessionKey: string,
): Promise<void> {
  const { api, linearApi, notify, pluginConfig, configPath } = hookCtx;
  const TAG = `[${dispatch.issueIdentifier}]`;
  const maxAttempts = (pluginConfig?.maxReworkAttempts as number) ?? 2;

  // Dedup check
  const eventKey = `audit-end:${sessionKey}`;
  const isNew = await markEventProcessed(eventKey, configPath);
  if (!isNew) {
    api.logger.info(`${TAG} duplicate audit agent_end, skipping`);
    return;
  }

  // Extract output from event messages or direct output
  let auditOutput = event.output ?? "";
  if (!auditOutput && Array.isArray(event.messages)) {
    // Get the last assistant message
    for (const msg of [...(event.messages as any[])].reverse()) {
      if (msg?.role === "assistant" && typeof msg?.content === "string") {
        auditOutput = msg.content;
        break;
      }
      // Handle array content (tool use + text blocks)
      if (msg?.role === "assistant" && Array.isArray(msg?.content)) {
        for (const block of msg.content) {
          if (block?.type === "text" && typeof block?.text === "string") {
            auditOutput = block.text;
          }
        }
        if (auditOutput) break;
      }
    }
  }

  // Log audit interaction to .claw/
  try {
    appendLog(dispatch.worktreePath, {
      ts: new Date().toISOString(), phase: "audit", attempt: dispatch.attempt,
      agent: "auditor", prompt: "(audit task)",
      outputPreview: auditOutput.slice(0, 500), success: event.success,
    });
  } catch {}

  // Parse verdict
  const verdict = parseVerdict(auditOutput);
  if (!verdict) {
    api.logger.warn(`${TAG} could not parse audit verdict from output (${auditOutput.length} chars)`);
    // Treat unparseable verdict as failure
    await handleAuditFail(hookCtx, dispatch, {
      pass: false,
      criteria: [],
      gaps: ["Audit produced no parseable verdict"],
      testResults: "",
    });
    return;
  }

  api.logger.info(
    `${TAG} audit verdict: ${verdict.pass ? "PASS" : "FAIL"} ` +
    `(criteria: ${verdict.criteria.length}, gaps: ${verdict.gaps.length})`,
  );

  if (verdict.pass) {
    await handleAuditPass(hookCtx, dispatch, verdict);
  } else {
    await handleAuditFail(hookCtx, dispatch, verdict);
  }
}

// ---------------------------------------------------------------------------
// Verdict handlers
// ---------------------------------------------------------------------------

async function handleAuditPass(
  hookCtx: HookContext,
  dispatch: ActiveDispatch,
  verdict: AuditVerdict,
): Promise<void> {
  const { api, linearApi, notify, pluginConfig, configPath } = hookCtx;
  const TAG = `[${dispatch.issueIdentifier}]`;

  // Save audit verdict to .claw/
  try { saveAuditVerdict(dispatch.worktreePath, dispatch.attempt, verdict); } catch {}
  try { updateManifest(dispatch.worktreePath, { status: "done", attempts: dispatch.attempt + 1 }); } catch {}

  // CAS transition: auditing → done
  try {
    await transitionDispatch(dispatch.issueIdentifier, "auditing", "done", undefined, configPath);
  } catch (err) {
    if (err instanceof TransitionError) {
      api.logger.warn(`${TAG} CAS failed for audit pass: ${err.message}`);
      return;
    }
    throw err;
  }

  // Move to completed
  await completeDispatch(dispatch.issueIdentifier, {
    tier: dispatch.tier,
    status: "done",
    completedAt: new Date().toISOString(),
    project: dispatch.project,
  }, configPath);

  // Build summary from .claw/ artifacts and write to memory
  let summary: string | null = null;
  try {
    summary = buildSummaryFromArtifacts(dispatch.worktreePath);
    if (summary) {
      writeSummary(dispatch.worktreePath, summary);
      const wsDir = resolveOrchestratorWorkspace(api, pluginConfig);
      writeDispatchMemory(dispatch.issueIdentifier, summary, wsDir);
      api.logger.info(`${TAG} .claw/ summary and memory written`);
    }
  } catch (err) {
    api.logger.warn(`${TAG} failed to write summary/memory: ${err}`);
  }

  // Post approval comment (with summary excerpt if available)
  const criteriaList = verdict.criteria.map((c) => `- ${c}`).join("\n");
  const summaryExcerpt = summary ? `\n\n**Summary:**\n${summary.slice(0, 2000)}` : "";
  await linearApi.createComment(
    dispatch.issueId,
    `## Audit Passed\n\n**Criteria verified:**\n${criteriaList}\n\n**Tests:** ${verdict.testResults || "N/A"}${summaryExcerpt}\n\n---\n*Attempt ${dispatch.attempt + 1} — audit passed. Artifacts: \`${dispatch.worktreePath}/.claw/\`*`,
  ).catch((err) => api.logger.error(`${TAG} failed to post audit pass comment: ${err}`));

  api.logger.info(`${TAG} audit PASSED — dispatch completed (attempt ${dispatch.attempt})`);

  await notify("audit_pass", {
    identifier: dispatch.issueIdentifier,
    title: dispatch.issueIdentifier,
    status: "done",
    attempt: dispatch.attempt,
    verdict: { pass: true, gaps: [] },
  });

  clearActiveSession(dispatch.issueId);
}

async function handleAuditFail(
  hookCtx: HookContext,
  dispatch: ActiveDispatch,
  verdict: AuditVerdict,
): Promise<void> {
  const { api, linearApi, notify, pluginConfig, configPath } = hookCtx;
  const TAG = `[${dispatch.issueIdentifier}]`;
  const maxAttempts = (pluginConfig?.maxReworkAttempts as number) ?? 2;
  const nextAttempt = dispatch.attempt + 1;

  // Save audit verdict to .claw/ (both escalation and rework paths)
  try { saveAuditVerdict(dispatch.worktreePath, dispatch.attempt, verdict); } catch {}

  if (nextAttempt > maxAttempts) {
    // Escalate — too many failures
    try { updateManifest(dispatch.worktreePath, { status: "stuck", attempts: nextAttempt }); } catch {}

    try {
      await transitionDispatch(
        dispatch.issueIdentifier,
        "auditing",
        "stuck",
        { stuckReason: `audit_failed_${nextAttempt}x` },
        configPath,
      );
    } catch (err) {
      if (err instanceof TransitionError) {
        api.logger.warn(`${TAG} CAS failed for stuck transition: ${err.message}`);
        return;
      }
      throw err;
    }

    // Write summary + memory for stuck dispatches too
    try {
      const summary = buildSummaryFromArtifacts(dispatch.worktreePath);
      if (summary) {
        writeSummary(dispatch.worktreePath, summary);
        const wsDir = resolveOrchestratorWorkspace(api, pluginConfig);
        writeDispatchMemory(dispatch.issueIdentifier, summary, wsDir);
      }
    } catch {}

    const gapsList = verdict.gaps.map((g) => `- ${g}`).join("\n");
    await linearApi.createComment(
      dispatch.issueId,
      `## Audit Failed — Escalating\n\n**Attempt ${nextAttempt} of ${maxAttempts + 1}**\n\n**Gaps:**\n${gapsList}\n\n**Tests:** ${verdict.testResults || "N/A"}\n\n---\n*Max rework attempts reached. Needs human review. Artifacts: \`${dispatch.worktreePath}/.claw/\`*`,
    ).catch((err) => api.logger.error(`${TAG} failed to post escalation comment: ${err}`));

    api.logger.warn(`${TAG} audit FAILED ${nextAttempt}x — escalating to human`);

    await notify("escalation", {
      identifier: dispatch.issueIdentifier,
      title: dispatch.issueIdentifier,
      status: "stuck",
      attempt: nextAttempt,
      reason: `audit failed ${nextAttempt}x`,
      verdict: { pass: false, gaps: verdict.gaps },
    });

    return;
  }

  // Rework — transition back to working with incremented attempt
  try {
    await transitionDispatch(
      dispatch.issueIdentifier,
      "auditing",
      "working",
      { attempt: nextAttempt },
      configPath,
    );
  } catch (err) {
    if (err instanceof TransitionError) {
      api.logger.warn(`${TAG} CAS failed for rework transition: ${err.message}`);
      return;
    }
    throw err;
  }

  const gapsList = verdict.gaps.map((g) => `- ${g}`).join("\n");
  await linearApi.createComment(
    dispatch.issueId,
    `## Audit Failed — Rework\n\n**Attempt ${nextAttempt} of ${maxAttempts + 1}**\n\n**Gaps:**\n${gapsList}\n\n**Tests:** ${verdict.testResults || "N/A"}\n\n---\n*Reworking: addressing gaps above.*`,
  ).catch((err) => api.logger.error(`${TAG} failed to post rework comment: ${err}`));

  api.logger.info(`${TAG} audit FAILED — rework attempt ${nextAttempt}/${maxAttempts + 1}`);

  await notify("audit_fail", {
    identifier: dispatch.issueIdentifier,
    title: dispatch.issueIdentifier,
    status: "working",
    attempt: nextAttempt,
    verdict: { pass: false, gaps: verdict.gaps },
  });

  // The webhook handler or dispatch service should re-spawn a worker
  // with the rework context. Log emitted for observability.
  api.logger.info(
    `${TAG} dispatch is back in "working" state (attempt ${nextAttempt}). ` +
    `Orchestrator should re-spawn worker with gaps: ${verdict.gaps.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Worker phase (called by handleDispatch in webhook.ts)
// ---------------------------------------------------------------------------

/**
 * Spawn the worker agent for a dispatch.
 * Transitions dispatched→working, builds task, runs agent, then triggers audit.
 *
 * This is the main entry point for the v2 pipeline — replaces runFullPipeline.
 */
export async function spawnWorker(
  hookCtx: HookContext,
  dispatch: ActiveDispatch,
  opts?: { gaps?: string[] },
): Promise<void> {
  const { api, linearApi, pluginConfig, configPath } = hookCtx;
  const TAG = `[${dispatch.issueIdentifier}]`;

  // Transition dispatched → working (first run) — skip if already working (rework)
  if (dispatch.status === "dispatched") {
    try {
      await transitionDispatch(
        dispatch.issueIdentifier,
        "dispatched",
        "working",
        undefined,
        configPath,
      );
    } catch (err) {
      if (err instanceof TransitionError) {
        api.logger.warn(`${TAG} CAS failed for worker spawn: ${err.message}`);
        return;
      }
      throw err;
    }
  }

  // Fetch fresh issue details
  const issueDetails = await linearApi.getIssueDetails(dispatch.issueId).catch(() => null);
  const issue: IssueContext = {
    id: dispatch.issueId,
    identifier: dispatch.issueIdentifier,
    title: issueDetails?.title ?? dispatch.issueIdentifier,
    description: issueDetails?.description,
  };

  // Build worker prompt from YAML templates
  const workerPrompt = buildWorkerTask(issue, dispatch.worktreePath, {
    attempt: dispatch.attempt,
    gaps: opts?.gaps,
    pluginConfig,
  });

  const workerSessionId = `linear-worker-${dispatch.issueIdentifier}-${dispatch.attempt}`;

  // Register session mapping for agent_end hook lookup
  await registerSessionMapping(workerSessionId, {
    dispatchId: dispatch.issueIdentifier,
    phase: "worker",
    attempt: dispatch.attempt,
  }, configPath);

  await hookCtx.notify("working", {
    identifier: dispatch.issueIdentifier,
    title: issue.title,
    status: "working",
    attempt: dispatch.attempt,
  });

  api.logger.info(`${TAG} spawning worker agent session=${workerSessionId} (attempt ${dispatch.attempt})`);

  const workerStartTime = Date.now();
  const result = await runAgent({
    api,
    agentId: (pluginConfig?.defaultAgentId as string) ?? "default",
    sessionId: workerSessionId,
    message: `${workerPrompt.system}\n\n${workerPrompt.task}`,
    streaming: dispatch.agentSessionId
      ? { linearApi, agentSessionId: dispatch.agentSessionId }
      : undefined,
  });

  // Save worker output to .claw/
  const workerElapsed = Date.now() - workerStartTime;
  const agentId = (pluginConfig?.defaultAgentId as string) ?? "default";
  try { saveWorkerOutput(dispatch.worktreePath, dispatch.attempt, result.output); } catch {}
  try {
    appendLog(dispatch.worktreePath, {
      ts: new Date().toISOString(), phase: "worker", attempt: dispatch.attempt,
      agent: agentId,
      prompt: workerPrompt.task.slice(0, 200),
      outputPreview: result.output.slice(0, 500),
      success: result.success, durationMs: workerElapsed,
    });
  } catch {}

  // Handle watchdog kill (runAgent already retried once — both attempts failed)
  if (result.watchdogKilled) {
    const wdConfig = resolveWatchdogConfig(agentId, pluginConfig ?? undefined);
    const thresholdSec = Math.round(wdConfig.inactivityMs / 1000);

    api.logger.warn(`${TAG} worker killed by inactivity watchdog 2x — escalating to stuck`);

    try {
      appendLog(dispatch.worktreePath, {
        ts: new Date().toISOString(), phase: "watchdog", attempt: dispatch.attempt,
        agent: agentId, prompt: "(watchdog kill)",
        outputPreview: result.output.slice(0, 500), success: false,
        durationMs: workerElapsed,
        watchdog: { reason: "inactivity", silenceSec: thresholdSec, thresholdSec, retried: true },
      });
    } catch {}

    try { updateManifest(dispatch.worktreePath, { status: "stuck", attempts: dispatch.attempt + 1 }); } catch {}

    try {
      await transitionDispatch(
        dispatch.issueIdentifier, "working", "stuck",
        { stuckReason: "watchdog_kill_2x" }, configPath,
      );
    } catch (err) {
      if (err instanceof TransitionError) {
        api.logger.warn(`${TAG} CAS failed for watchdog stuck transition: ${err.message}`);
      }
    }

    await linearApi.createComment(
      dispatch.issueId,
      `## Watchdog Kill\n\nAgent killed by inactivity watchdog (no I/O for ${thresholdSec}s). ` +
      `Automatic retry also failed.\n\n---\n*Needs human review. Artifacts: \`${dispatch.worktreePath}/.claw/\`*`,
    ).catch(() => {});

    await hookCtx.notify("watchdog_kill", {
      identifier: dispatch.issueIdentifier,
      title: issue.title,
      status: "stuck",
      attempt: dispatch.attempt,
      reason: `no I/O for ${thresholdSec}s`,
    });

    clearActiveSession(dispatch.issueId);
    return;
  }

  // runAgent returns inline — trigger audit directly.
  // Re-read dispatch state since it may have changed during worker run.
  const freshState = await readDispatchState(configPath);
  const freshDispatch = getActiveDispatch(freshState, dispatch.issueIdentifier);
  if (!freshDispatch) {
    api.logger.warn(`${TAG} dispatch disappeared during worker run — skipping audit`);
    return;
  }

  api.logger.info(`${TAG} worker completed (success=${result.success}, ${result.output.length} chars) — triggering audit`);

  await triggerAudit(hookCtx, freshDispatch, {
    success: result.success,
    output: result.output,
  }, workerSessionId);
}

// ---------------------------------------------------------------------------
// Exports for backward compatibility (v1 pipeline)
// ---------------------------------------------------------------------------

// Re-export v1 types and functions that other files may still use
export type { Tier } from "./dispatch-state.js";

export interface PipelineContext {
  api: OpenClawPluginApi;
  linearApi: LinearAgentApi;
  agentSessionId: string;
  agentId: string;
  issue: IssueContext;
  promptContext?: unknown;
  worktreePath?: string | null;
  codexBranch?: string | null;
  tier?: Tier;
  model?: string;
}
