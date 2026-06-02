// The exact set of resource types our webhook handler processes.
export const REQUIRED_RESOURCE_TYPES = ["Comment", "Issue"];
export const WEBHOOK_LABEL = "OpenClaw Integration";
/**
 * Inspect all webhooks and find the one(s) matching our URL pattern.
 */
export async function getWebhookStatus(linearApi, webhookUrl) {
    const webhooks = await linearApi.listWebhooks();
    const ours = webhooks.find((w) => w.url === webhookUrl);
    if (!ours)
        return null;
    const issues = [];
    if (!ours.enabled)
        issues.push("disabled");
    const currentTypes = new Set(ours.resourceTypes);
    const requiredTypes = new Set(REQUIRED_RESOURCE_TYPES);
    for (const t of requiredTypes) {
        if (!currentTypes.has(t))
            issues.push(`missing event type: ${t}`);
    }
    const noiseTypes = [...currentTypes].filter((t) => !requiredTypes.has(t));
    if (noiseTypes.length > 0) {
        issues.push(`unnecessary event types: ${noiseTypes.join(", ")}`);
    }
    return {
        id: ours.id,
        url: ours.url,
        enabled: ours.enabled,
        resourceTypes: ours.resourceTypes,
        label: ours.label,
        issues,
    };
}
/**
 * Provision (create or fix) the workspace webhook.
 *
 * - If no webhook with our URL exists → create one
 * - If one exists but has wrong config → update it
 * - If it's already correct → no-op
 */
export async function provisionWebhook(linearApi, webhookUrl, opts) {
    const status = await getWebhookStatus(linearApi, webhookUrl);
    if (!status) {
        // No webhook found — create one
        const result = await linearApi.createWebhook({
            url: webhookUrl,
            resourceTypes: [...REQUIRED_RESOURCE_TYPES],
            label: WEBHOOK_LABEL,
            enabled: true,
            teamId: opts?.teamId,
            allPublicTeams: opts?.allPublicTeams ?? true,
        });
        return {
            action: "created",
            webhookId: result.id,
            changes: ["created new webhook"],
        };
    }
    // Webhook exists — check if it needs updates
    if (status.issues.length === 0) {
        return { action: "already_ok", webhookId: status.id };
    }
    // Build update payload
    const update = {};
    const changes = [];
    // Fix resource types
    const currentTypes = new Set(status.resourceTypes);
    const requiredTypes = new Set(REQUIRED_RESOURCE_TYPES);
    const typesNeedUpdate = [...requiredTypes].some((t) => !currentTypes.has(t)) ||
        [...currentTypes].some((t) => !requiredTypes.has(t));
    if (typesNeedUpdate) {
        update.resourceTypes = [...REQUIRED_RESOURCE_TYPES];
        const removed = [...currentTypes].filter((t) => !requiredTypes.has(t));
        const added = [...requiredTypes].filter((t) => !currentTypes.has(t));
        if (removed.length)
            changes.push(`removed event types: ${removed.join(", ")}`);
        if (added.length)
            changes.push(`added event types: ${added.join(", ")}`);
    }
    // Fix enabled state
    if (!status.enabled) {
        update.enabled = true;
        changes.push("enabled webhook");
    }
    // Fix label if missing
    if (!status.label) {
        update.label = WEBHOOK_LABEL;
        changes.push("set label");
    }
    await linearApi.updateWebhook(status.id, update);
    return {
        action: "updated",
        webhookId: status.id,
        changes,
    };
}
