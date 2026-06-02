import { resolveDefaultAgent } from "../infra/shared-profiles.js";
// ---------------------------------------------------------------------------
// Tier → Model mapping
// ---------------------------------------------------------------------------
export const TIER_MODELS = {
    small: "anthropic/claude-haiku-4-5",
    medium: "anthropic/claude-sonnet-4-6",
    high: "anthropic/claude-opus-4-6",
};
// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------
const ASSESS_PROMPT = `You are a complexity assessor. Assess this issue and respond ONLY with JSON.

Tiers:
- small: typos, copy changes, config tweaks, simple CSS, env var additions
- medium: features, bugfixes, moderate refactoring, adding tests, API changes
- high: architecture changes, database migrations, security fixes, multi-service coordination

Consider:
1. How many files/services are likely affected?
2. Does it touch auth, data, or external APIs? (higher risk → higher tier)
3. Is the description clear and actionable?
4. Are there dependencies or unknowns?

Respond ONLY with: {"tier":"small|medium|high","reasoning":"one sentence"}`;
/**
 * Assess issue complexity using the agent's configured model.
 *
 * Falls back to "medium" if the agent call fails or returns invalid JSON.
 */
export async function assessTier(api, issue, agentId) {
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
        }
        else {
            api.logger.warn(`Tier assessment for ${issue.identifier}: could not parse response: ${result.output.slice(0, 200)}`);
        }
    }
    catch (err) {
        api.logger.warn(`Tier assessment error for ${issue.identifier}: ${err}`);
    }
    // Fallback: medium is the safest default
    const fallback = {
        tier: "medium",
        model: TIER_MODELS.medium,
        reasoning: "Assessment failed — defaulting to medium",
    };
    api.logger.info(`Tier assessment fallback for ${issue.identifier}: medium`);
    return fallback;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseAssessment(raw) {
    // Extract JSON from the response (may have markdown wrapping)
    const jsonMatch = raw.match(/\{[^}]+\}/);
    if (!jsonMatch)
        return null;
    try {
        const parsed = JSON.parse(jsonMatch[0]);
        const tier = parsed.tier;
        if (tier !== "small" && tier !== "medium" && tier !== "high")
            return null;
        return {
            tier: tier,
            model: TIER_MODELS[tier],
            reasoning: parsed.reasoning ?? "no reasoning provided",
        };
    }
    catch {
        return null;
    }
}
