import { describe, expect, it } from "vitest";
import plugin from "../index.js";

describe("plugin entry", () => {
  it("uses the canonical OpenClaw advanced-plugin contract", () => {
    expect(plugin).toMatchObject({
      id: "openclaw-linear",
      name: "Linear Agent",
      description: expect.any(String),
      register: expect.any(Function),
    });
  });
});
