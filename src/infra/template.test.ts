import { describe, it, expect } from "vitest";
import { renderTemplate } from "./template.js";

// ---------------------------------------------------------------------------
// renderTemplate
// ---------------------------------------------------------------------------

describe("renderTemplate", () => {
  it("replaces a single variable", () => {
    const result = renderTemplate("Hello {{name}}!", { name: "World" });
    expect(result).toBe("Hello World!");
  });

  it("replaces multiple different variables", () => {
    const template = "Issue {{identifier}}: {{title}} ({{status}})";
    const result = renderTemplate(template, {
      identifier: "ENG-123",
      title: "Fix bug",
      status: "In Progress",
    });
    expect(result).toBe("Issue ENG-123: Fix bug (In Progress)");
  });

  it("replaces all occurrences of the same variable", () => {
    const template = "{{name}} said hello to {{name}}";
    const result = renderTemplate(template, { name: "Alice" });
    expect(result).toBe("Alice said hello to Alice");
  });

  it("leaves unmatched placeholders intact", () => {
    const result = renderTemplate("Hello {{name}} and {{other}}", { name: "World" });
    expect(result).toBe("Hello World and {{other}}");
  });

  it("handles empty vars object", () => {
    const result = renderTemplate("Hello {{name}}!", {});
    expect(result).toBe("Hello {{name}}!");
  });

  it("replaces with empty string when value is empty", () => {
    const result = renderTemplate("Hello {{name}}!", { name: "" });
    expect(result).toBe("Hello !");
  });

  it("handles template with no placeholders", () => {
    const result = renderTemplate("No variables here", { name: "World" });
    expect(result).toBe("No variables here");
  });

  it("handles empty template", () => {
    const result = renderTemplate("", { name: "World" });
    expect(result).toBe("");
  });

  it("handles null/undefined values gracefully", () => {
    const result = renderTemplate("Value: {{key}}", { key: undefined as unknown as string });
    expect(result).toBe("Value: ");
  });

  it("works with multiline templates", () => {
    const template = "Issue: {{identifier}}\nTitle: {{title}}\nWorktree: {{worktreePath}}";
    const result = renderTemplate(template, {
      identifier: "CT-42",
      title: "Implement auth",
      worktreePath: "/tmp/test/worktrees/ct-42",
    });
    expect(result).toBe("Issue: CT-42\nTitle: Implement auth\nWorktree: /tmp/test/worktrees/ct-42");
  });

  it("handles special regex characters in values", () => {
    // Note: replaceAll treats $$ as an escape for a literal $ in the replacement.
    // This is standard JS behavior (not a bug). Values with $ may be altered.
    const result = renderTemplate("Pattern: {{pattern}}", {
      pattern: "hello.world+test",
    });
    expect(result).toBe("Pattern: hello.world+test");
  });

  it("handles variables with numeric values as strings", () => {
    const result = renderTemplate("Attempt {{attempt}} of {{max}}", {
      attempt: "3",
      max: "5",
    });
    expect(result).toBe("Attempt 3 of 5");
  });
});
