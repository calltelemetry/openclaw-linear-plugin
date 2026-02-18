/**
 * tier-assess.ts — LLM-based complexity assessment for Linear issues.
 *
 * Uses runAgent() with the agent's configured model (e.g. kimi-k2.5)
 * to assess issue complexity. The agent model handles orchestration —
 * it never calls coding CLIs directly.
 *
 * Cost: one short agent turn (~500 tokens). Latency: ~2-5s.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { Tier } from "./dispatch-state.js";

// ---------------------------------------------------------------------------
// Tier → Model mapping
// ---------------------------------------------------------------------------

export const TIER_MODELS: Record<Tier, string> = {
  junior: "anthropic/claude-haiku-4-5",
  medior: "anthropic/claude-sonnet-4-6",
  senior: "anthropic/claude-opus-4-6",
};

export interface TierAssessment {
  tier: Tier;
  model: string;
  reasoning: string;
}

export interface IssueContext {
  identifier: string;
  title: string;
  description?: string | null;
  labels?: string[];
  commentCount?: number;
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

const ASSESS_PROMPT = `You are a complexity assessor. Assess this issue and respond ONLY with JSON.

Tiers:
- junior: typos, copy changes, config tweaks, simple CSS, env var additions
- medior: features, bugfixes, moderate refactoring, adding tests, API changes
- senior: architecture changes, database migrations, security fixes, multi-service coordination

Consider:
1. How many files/services are likely affected?
2. Does it touch auth, data, or external APIs? (higher risk → higher tier)
3. Is the description clear and actionable?
4. Are there dependencies or unknowns?

Respond ONLY with: {"tier":"junior|medior|senior","reasoning":"one sentence"}`;

/**
 * Assess issue complexity using the agent's configured model.
 *
 * Falls back to "medior" if the agent call fails or returns invalid JSON.
 */
export async function assessTier(
  api: OpenClawPluginApi,
  issue: IssueContext,
  agentId?: string,
): Promise<TierAssessment> {
  const issueText = [
    `Issue: ${issue.identifier} — ${issue.title}`,
    issue.description ? `Description: ${issue.description.slice(0, 1500)}` : "",
    issue.labels?.length ? `Labels: ${issue.labels.join(", ")}` : "",
    issue.commentCount != null ? `Comments: ${issue.commentCount}` : "",
  ].filter(Boolean).join("\n");

  const message = `${ASSESS_PROMPT}\n\n${issueText}`;

  try {
    const { runAgent } = await import("../agent/agent.js");
    const result = await runAgent({
      api,
      agentId: agentId ?? resolveDefaultAgent(api),
      sessionId: `tier-assess-${issue.identifier}-${Date.now()}`,
      message,
      timeoutMs: 30_000, // 30s — this should be fast
    });

    // Try to parse assessment from output regardless of success flag.
    // runAgent may report success:false (non-zero exit code) even when
    // the agent produced valid JSON output — e.g. agent exited with
    // signal but wrote the response before terminating.
    if (result.output) {
      const parsed = parseAssessment(result.output);
      if (parsed) {
        api.logger.info(`Tier assessment for ${issue.identifier}: ${parsed.tier} — ${parsed.reasoning} (agent success=${result.success})`);
        return parsed;
      }
    }

    if (!result.success) {
      api.logger.warn(`Tier assessment agent failed for ${issue.identifier}: ${result.output.slice(0, 200)}`);
    } else {
      api.logger.warn(`Tier assessment for ${issue.identifier}: could not parse response: ${result.output.slice(0, 200)}`);
    }
  } catch (err) {
    api.logger.warn(`Tier assessment error for ${issue.identifier}: ${err}`);
  }

  // Fallback: medior is the safest default
  const fallback: TierAssessment = {
    tier: "medior",
    model: TIER_MODELS.medior,
    reasoning: "Assessment failed — defaulting to medior",
  };
  api.logger.info(`Tier assessment fallback for ${issue.identifier}: medior`);
  return fallback;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDefaultAgent(api: OpenClawPluginApi): string {
  // Use the plugin's configured default agent (same one that runs the pipeline)
  const fromConfig = (api as any).pluginConfig?.defaultAgentId;
  if (typeof fromConfig === "string" && fromConfig) return fromConfig;

  // Fall back to isDefault in agent profiles
  try {
    const profilesPath = join(process.env.HOME ?? "/home/claw", ".openclaw", "agent-profiles.json");
    const raw = readFileSync(profilesPath, "utf8");
    const profiles = JSON.parse(raw).agents ?? {};
    const defaultAgent = Object.entries(profiles).find(([, p]: [string, any]) => p.isDefault);
    if (defaultAgent) return defaultAgent[0];
  } catch { /* fall through */ }

  return "default";
}

function parseAssessment(raw: string): TierAssessment | null {
  // Extract JSON from the response (may have markdown wrapping)
  const jsonMatch = raw.match(/\{[^}]+\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const tier = parsed.tier as string;
    if (tier !== "junior" && tier !== "medior" && tier !== "senior") return null;

    return {
      tier: tier as Tier,
      model: TIER_MODELS[tier as Tier],
      reasoning: parsed.reasoning ?? "no reasoning provided",
    };
  } catch {
    return null;
  }
}
