import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type WorkflowStep = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};

type Workflow = {
  permissions?: Record<string, unknown>;
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
};

const workflow = parse(
  readFileSync(
    new URL("../../.github/workflows/npm-publish.yml", import.meta.url),
    "utf8",
  ),
) as Workflow;

describe("npm publish workflow", () => {
  it("leaves registry authentication to the OIDC trusted publisher", () => {
    const publishJob = workflow.jobs?.publish;
    const setupNode = publishJob?.steps?.find((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    const publish = publishJob?.steps?.find((step) =>
      step.run?.startsWith("npm publish"),
    );

    expect(workflow.permissions?.["id-token"]).toBe("write");
    expect(publishJob).toBeDefined();
    expect(setupNode?.with).not.toHaveProperty("registry-url");
    expect(publish?.run).toBe("npm publish --provenance --access public");
    expect(publish?.env).toBeUndefined();
  });
});
