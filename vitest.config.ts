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
        "src/infra/notify.ts",
        "src/agent/watchdog.ts",
        "src/infra/doctor.ts",
      ],
      reporter: ["text", "text-summary"],
    },
  },
});
