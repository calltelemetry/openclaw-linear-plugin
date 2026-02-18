import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      include: [
        "src/artifacts.ts",
        "src/pipeline.ts",
        "src/dispatch-state.ts",
        "src/active-session.ts",
        "src/notify.ts",
        "src/watchdog.ts",
      ],
      reporter: ["text", "text-summary"],
    },
  },
});
