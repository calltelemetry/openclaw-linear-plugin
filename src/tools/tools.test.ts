/**
 * tools.test.ts — Integration tests for tool registration.
 *
 * Verifies createLinearTools() returns expected tools and handles
 * configuration flags and graceful failure scenarios.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./code-tool.js", () => ({
  createCodeTool: vi.fn(() => ({ name: "code_run", execute: vi.fn() })),
}));

vi.mock("./orchestration-tools.js", () => ({
  createOrchestrationTools: vi.fn(() => [
    { name: "spawn_agent", execute: vi.fn() },
    { name: "ask_agent", execute: vi.fn() },
  ]),
}));

vi.mock("./linear-issues-tool.js", () => ({
  createLinearIssuesTool: vi.fn(() => ({ name: "linear_issues", execute: vi.fn() })),
}));

import { createLinearTools } from "./tools.js";
import { createCodeTool } from "./code-tool.js";
import { createOrchestrationTools } from "./orchestration-tools.js";
import { createLinearIssuesTool } from "./linear-issues-tool.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeApi(pluginConfig?: Record<string, unknown>) {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    pluginConfig: pluginConfig ?? {},
  } as any;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("createLinearTools", () => {
  it("returns code_run, spawn_agent, ask_agent, and linear_issues tools", () => {
    const api = makeApi();
    const tools = createLinearTools(api, {});

    expect(tools).toHaveLength(4);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("code_run");
    expect(names).toContain("spawn_agent");
    expect(names).toContain("ask_agent");
    expect(names).toContain("linear_issues");
  });

  it("includes orchestration tools by default", () => {
    const api = makeApi();
    createLinearTools(api, {});

    expect(createOrchestrationTools).toHaveBeenCalled();
  });

  it("excludes orchestration tools when enableOrchestration is false", () => {
    vi.mocked(createOrchestrationTools).mockClear();
    const api = makeApi({ enableOrchestration: false });
    const tools = createLinearTools(api, {});

    expect(tools).toHaveLength(2);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("code_run");
    expect(names).toContain("linear_issues");
    expect(createOrchestrationTools).not.toHaveBeenCalled();
  });

  it("handles code_run creation failure gracefully", () => {
    vi.mocked(createCodeTool).mockImplementationOnce(() => {
      throw new Error("CLI not found");
    });

    const api = makeApi();
    const tools = createLinearTools(api, {});

    expect(tools).toHaveLength(3);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("spawn_agent");
    expect(names).toContain("ask_agent");
    expect(names).toContain("linear_issues");
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("code_run tool not available"),
    );
  });

  it("handles orchestration tools creation failure gracefully", () => {
    vi.mocked(createOrchestrationTools).mockImplementationOnce(() => {
      throw new Error("orchestration init failed");
    });

    const api = makeApi();
    const tools = createLinearTools(api, {});

    expect(tools).toHaveLength(2);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("code_run");
    expect(names).toContain("linear_issues");
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Orchestration tools not available"),
    );
  });

  it("handles linear_issues creation failure gracefully", () => {
    vi.mocked(createLinearIssuesTool).mockImplementationOnce(() => {
      throw new Error("no token");
    });

    const api = makeApi();
    const tools = createLinearTools(api, {});

    expect(tools).toHaveLength(3);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("code_run");
    expect(names).toContain("spawn_agent");
    expect(names).toContain("ask_agent");
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("linear_issues tool not available"),
    );
  });
});
