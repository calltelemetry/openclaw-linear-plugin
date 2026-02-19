# Contributing to OpenClaw Linear Plugin

Thanks for your interest in contributing! This plugin connects [OpenClaw](https://github.com/openclaw/openclaw) agents to [Linear](https://linear.app) for webhook-driven AI pipelines.

## Getting Started

1. **Fork and clone** the repository
2. **Install dependencies:** `pnpm install` (or `npm install`)
3. **Read the architecture:** See [docs/architecture.md](docs/architecture.md) for how webhooks, pipelines, and tools fit together

## Development

This is a TypeScript plugin loaded directly by OpenClaw at runtime (no build step). Source files in `src/` are the implementation.

### Key files

| File | Purpose |
|------|---------|
| `index.ts` | Plugin entry point — registers routes, tools, services |
| `src/webhook.ts` | Webhook dispatcher — routes Linear events to handlers |
| `src/pipeline.ts` | 3-stage pipeline: plan, implement, audit |
| `src/code-tool.ts` | Unified `code_run` tool with multi-backend dispatch |
| `src/codex-worktree.ts` | Git worktree management for isolated code runs |

### Testing locally

1. Install the plugin in your OpenClaw instance
2. Run `openclaw doctor` to validate config
3. Use Linear's webhook test feature or `curl` to send test payloads

## Submitting Changes

1. Create a feature branch from `master`
2. Make your changes with clear, descriptive commits
3. Ensure no secrets or credentials are included
4. Open a pull request with a description of what changed and why

## Reporting Issues

Open an issue on GitHub with:
- What you expected to happen
- What actually happened
- Relevant log output (redact any tokens/secrets)
- Your OpenClaw version (`openclaw --version`)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
