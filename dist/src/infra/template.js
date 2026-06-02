/**
 * template.ts — Shared template renderer for {{key}} interpolation.
 *
 * Used by pipeline.ts and planner.ts to render prompt templates with
 * issue context variables.
 */
/**
 * Replaces all {{key}} occurrences in `template` with corresponding values
 * from `vars`. Missing keys are replaced with empty string.
 */
export function renderTemplate(template, vars) {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
        result = result.replaceAll(`{{${key}}}`, value ?? "");
    }
    return result;
}
