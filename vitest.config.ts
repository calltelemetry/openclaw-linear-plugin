import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      include: [
        "src/pipeline/artifacts.ts",
        "src/pipeline/pipeline.ts",
        "src/pipeline/dispatch-state.ts",
        "src/pipeline/active-session.ts",
        "src/pipeline/planning-state.ts",
        "src/pipeline/planner.ts",
        "src/pipeline/intent-classify.ts",
        "src/pipeline/dag-dispatch.ts",
        "src/pipeline/webhook.ts",
        "src/tools/planner-tools.ts",
        "src/infra/notify.ts",
        "src/agent/watchdog.ts",
        "src/infra/doctor.ts",
      ],
      reporter: ["text", "text-summary", "lcov"],
    },
  },
});
