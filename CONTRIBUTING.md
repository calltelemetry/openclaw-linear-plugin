# Contributing to OpenClaw Linear Plugin

This plugin connects [OpenClaw](https://github.com/openclaw/openclaw) agents to [Linear](https://linear.app) for webhook-driven AI pipelines. Thanks for helping improve it.

## Getting Started

1. Fork and clone the repository.
2. Install dependencies: `pnpm install` (or `npm install`).
3. Read [docs/architecture.md](docs/architecture.md) for how webhooks, pipelines, and tools fit together.

## Development

TypeScript plugin loaded by OpenClaw at runtime (no build step). Source files live in `src/`.

### Key files

| File | Purpose |
|------|---------|
| `index.ts` | Plugin entry point -- registers routes, tools, services |
| `src/pipeline/webhook.ts` | Event router -- routes Linear webhook events to handlers |
| `src/pipeline/pipeline.ts` | Worker-audit pipeline: spawnWorker, triggerAudit, processVerdict |
| `src/pipeline/dag-dispatch.ts` | DAG-based project dispatch |
| `src/tools/code-tool.ts` | Unified `code_run` tool with multi-backend dispatch |
| `src/infra/codex-worktree.ts` | Git worktree management for isolated code runs |
| `src/infra/doctor.ts` | Health check system |

## Testing

319 tests across 20 files. Shared test helpers live in `src/__test__/helpers.ts`.

```bash
# Run all tests
npx vitest run

# Run with coverage
npx vitest run --coverage
```

E2E tests cover the full dispatch and planning pipelines:

- `src/pipeline/e2e-dispatch.test.ts`
- `src/pipeline/e2e-planning.test.ts`

### Live integration tests

Requires the gateway and Cloudflare tunnel to be running:

```bash
npx tsx scripts/uat-linear.ts
```

## Submitting Changes

1. Create a feature branch from `master`.
2. Write clear, descriptive commits.
3. Do not include secrets or credentials.
4. Open a pull request explaining what changed and why.

## Reporting Issues

Open a GitHub issue with:
- What you expected vs. what happened.
- Relevant log output (redact tokens and secrets).
- Your OpenClaw version (`openclaw --version`).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
