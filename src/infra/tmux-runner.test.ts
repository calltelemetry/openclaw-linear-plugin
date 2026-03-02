import { describe, expect, it } from "vitest";
import { isCompletionEvent } from "./tmux-runner.js";

describe("isCompletionEvent", () => {
  it("detects Claude result events", () => {
    expect(isCompletionEvent({ type: "result" })).toBe(true);
  });

  it("detects Codex session completion events", () => {
    expect(isCompletionEvent({ type: "session.completed" })).toBe(true);
  });

  it("detects task completion lifecycle variants", () => {
    expect(isCompletionEvent({ type: "task_completed" })).toBe(true);
    expect(isCompletionEvent({ type: "task.completed" })).toBe(true);
    expect(isCompletionEvent({ type: "task_completion" })).toBe(true);
  });

  it("detects completion when event type is under item.type", () => {
    expect(isCompletionEvent({ item: { type: "task_completed" } })).toBe(true);
  });

  it("detects completion from session.completed boolean", () => {
    expect(isCompletionEvent({ session: { completed: true } })).toBe(true);
  });

  it("does not treat non-completion events as complete", () => {
    expect(isCompletionEvent({ type: "assistant" })).toBe(false);
    expect(isCompletionEvent({ type: "message" })).toBe(false);
    expect(isCompletionEvent({ item: { type: "agent_message" } })).toBe(false);
  });
});
