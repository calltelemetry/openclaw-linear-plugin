/**
 * cli.ts — CLI registration for `openclaw openclaw-linear auth` and `openclaw openclaw-linear status`.
 */
import type { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createInterface } from "node:readline";
import { exec } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { readFileSync as readFileSyncFs, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLinearToken, AUTH_PROFILES_PATH, LINEAR_GRAPHQL_URL } from "../api/linear-api.js";
import { LINEAR_OAUTH_AUTH_URL, LINEAR_OAUTH_TOKEN_URL, LINEAR_AGENT_SCOPES } from "../api/auth.js";
import { listWorktrees } from "./codex-worktree.js";
import { loadPrompts, clearPromptCache } from "../pipeline/pipeline.js";

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  exec(`${cmd} ${JSON.stringify(url)}`, () => {});
}

export function registerCli(program: Command, api: OpenClawPluginApi): void {
  const linear = program
    .command("openclaw-linear")
    .description("Linear plugin — auth and status");

  // --- openclaw openclaw-linear auth ---
  linear
    .command("auth")
    .description("Run Linear OAuth flow to authorize the agent")
    .action(async () => {
      const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
      const clientId = (pluginConfig?.clientId as string) ?? process.env.LINEAR_CLIENT_ID;
      const clientSecret = (pluginConfig?.clientSecret as string) ?? process.env.LINEAR_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        console.error("Error: Linear client ID and secret must be configured.");
        console.error("Set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET env vars, or add clientId/clientSecret to plugin config.");
        process.exitCode = 1;
        return;
      }

      const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT ?? "18789";
      const redirectUri = (pluginConfig?.redirectUri as string)
        ?? process.env.LINEAR_REDIRECT_URI
        ?? `http://localhost:${gatewayPort}/linear/oauth/callback`;

      const state = Math.random().toString(36).substring(7);
      const authUrl = `${LINEAR_OAUTH_AUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(LINEAR_AGENT_SCOPES)}&state=${state}&actor=app`;

      console.log("\nOpening Linear OAuth authorization page...\n");
      console.log(`  ${authUrl}\n`);
      openBrowser(authUrl);

      const code = await prompt("Paste the authorization code from Linear: ");
      if (!code) {
        console.error("No code provided. Aborting.");
        process.exitCode = 1;
        return;
      }

      console.log("Exchanging code for token...");

      const response = await fetch(LINEAR_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`OAuth token exchange failed (${response.status}): ${error}`);
        process.exitCode = 1;
        return;
      }

      const tokens = await response.json();

      // Store in auth profile store
      let store: any = { version: 1, profiles: {} };
      try {
        const raw = readFileSync(AUTH_PROFILES_PATH, "utf8");
        store = JSON.parse(raw);
      } catch {
        // Fresh store
      }

      store.profiles = store.profiles ?? {};
      store.profiles["linear:default"] = {
        type: "oauth",
        provider: "linear",
        accessToken: tokens.access_token,
        access: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        refresh: tokens.refresh_token ?? null,
        expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
        expires: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
        scope: tokens.scope,
      };

      writeFileSync(AUTH_PROFILES_PATH, JSON.stringify(store, null, 2), "utf8");

      const expiresIn = tokens.expires_in ? `${Math.round(tokens.expires_in / 3600)}h` : "unknown";
      console.log(`\nAuthorized! Token stored in auth profile store.`);
      console.log(`  Scopes:  ${tokens.scope ?? "unknown"}`);
      console.log(`  Expires: ${expiresIn}`);
      console.log(`\nRestart the gateway to pick up the new token.`);
    });

  // --- openclaw openclaw-linear status ---
  linear
    .command("status")
    .description("Show current Linear auth and connection status")
    .action(async () => {
      const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
      const tokenInfo = resolveLinearToken(pluginConfig);

      console.log("\nLinear Auth Status");
      console.log("─".repeat(40));
      console.log(`  Source:        ${tokenInfo.source}`);

      if (!tokenInfo.accessToken) {
        console.log(`  Token:         not found`);
        console.log(`\nRun "openclaw openclaw-linear auth" to authorize.`);
        return;
      }

      console.log(`  Token:         ${tokenInfo.accessToken.slice(0, 12)}...`);
      console.log(`  Refresh token: ${tokenInfo.refreshToken ? "present" : "none"}`);

      if (tokenInfo.expiresAt) {
        const remaining = tokenInfo.expiresAt - Date.now();
        if (remaining <= 0) {
          console.log(`  Expires:       EXPIRED`);
        } else {
          const hours = Math.floor(remaining / 3_600_000);
          const mins = Math.floor((remaining % 3_600_000) / 60_000);
          console.log(`  Expires:       ${hours}h ${mins}m`);
        }
      } else {
        console.log(`  Expires:       unknown (no expiry set)`);
      }

      // Try reading scope from profile
      try {
        const raw = readFileSync(AUTH_PROFILES_PATH, "utf8");
        const store = JSON.parse(raw);
        const scope = store?.profiles?.["linear:default"]?.scope;
        if (scope) console.log(`  Scopes:        ${scope}`);
      } catch {}

      // Verify token with API call
      console.log("\nConnection Test");
      console.log("─".repeat(40));
      try {
        const authHeader = tokenInfo.refreshToken
          ? `Bearer ${tokenInfo.accessToken}`
          : tokenInfo.accessToken;

        const res = await fetch(LINEAR_GRAPHQL_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authHeader,
          },
          body: JSON.stringify({
            query: `{ viewer { id name email } organization { name urlKey } }`,
          }),
        });

        if (!res.ok) {
          console.log(`  API response:  ${res.status} ${res.statusText}`);
          return;
        }

        const payload = await res.json();
        if (payload.errors?.length) {
          console.log(`  API error:     ${payload.errors[0].message}`);
          return;
        }

        const { viewer, organization } = payload.data;
        console.log(`  API:           connected`);
        console.log(`  User:          ${viewer.name} (${viewer.email})`);
        console.log(`  Workspace:     ${organization.name} (${organization.urlKey})`);
      } catch (err) {
        console.log(`  API:           failed — ${err instanceof Error ? err.message : String(err)}`);
      }

      console.log();
    });

  // --- openclaw openclaw-linear worktrees ---
  linear
    .command("worktrees")
    .description("List Codex worktrees (use --prune to remove specific ones)")
    .option("--prune <path>", "Remove a specific worktree by path")
    .action(async (opts: { prune?: string }) => {
      if (opts.prune) {
        try {
          const { removeWorktree } = await import("./codex-worktree.js");
          removeWorktree(opts.prune, { deleteBranch: true });
          console.log(`\nRemoved: ${opts.prune}\n`);
        } catch (err) {
          console.error(`\nFailed to remove ${opts.prune}: ${err}\n`);
          process.exitCode = 1;
        }
        return;
      }

      const worktrees = listWorktrees();

      if (worktrees.length === 0) {
        console.log("\nNo Codex worktrees found.\n");
        return;
      }

      console.log(`\nCodex Worktrees (${worktrees.length})`);
      console.log("─".repeat(60));

      for (const wt of worktrees) {
        const ageH = Math.round(wt.ageMs / 3_600_000 * 10) / 10;
        const changes = wt.hasChanges ? " (uncommitted changes)" : "";
        console.log(`  ${wt.path}`);
        console.log(`    branch: ${wt.branch}  age: ${ageH}h${changes}`);
      }

      console.log(`\nTo remove one: openclaw openclaw-linear worktrees --prune <path>\n`);
    });

  // --- openclaw openclaw-linear prompts ---
  const prompts = linear
    .command("prompts")
    .description("Manage pipeline prompt templates (prompts.yaml)");

  prompts
    .command("show")
    .description("Print current prompts.yaml content")
    .action(async () => {
      const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
      const customPath = pluginConfig?.promptsPath as string | undefined;

      let resolvedPath: string;
      if (customPath) {
        resolvedPath = customPath.startsWith("~")
          ? customPath.replace("~", process.env.HOME ?? "")
          : customPath;
      } else {
        const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
        resolvedPath = join(pluginRoot, "prompts.yaml");
      }

      console.log(`\nPrompts file: ${resolvedPath}\n`);

      try {
        const content = readFileSyncFs(resolvedPath, "utf-8");
        console.log(content);
      } catch {
        console.log("(file not found — using built-in defaults)\n");
        // Show the loaded defaults
        clearPromptCache();
        const loaded = loadPrompts(pluginConfig);
        console.log(JSON.stringify(loaded, null, 2));
      }
    });

  prompts
    .command("path")
    .description("Print the resolved prompts.yaml file path")
    .action(async () => {
      const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
      const customPath = pluginConfig?.promptsPath as string | undefined;

      let resolvedPath: string;
      if (customPath) {
        resolvedPath = customPath.startsWith("~")
          ? customPath.replace("~", process.env.HOME ?? "")
          : customPath;
      } else {
        const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
        resolvedPath = join(pluginRoot, "prompts.yaml");
      }

      const exists = existsSync(resolvedPath);
      console.log(`${resolvedPath} ${exists ? "(exists)" : "(not found — using defaults)"}`);
    });

  prompts
    .command("validate")
    .description("Validate prompts.yaml structure")
    .action(async () => {
      const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
      clearPromptCache();

      try {
        const loaded = loadPrompts(pluginConfig);
        const errors: string[] = [];

        if (!loaded.worker?.system) errors.push("Missing worker.system");
        if (!loaded.worker?.task) errors.push("Missing worker.task");
        if (!loaded.audit?.system) errors.push("Missing audit.system");
        if (!loaded.audit?.task) errors.push("Missing audit.task");
        if (!loaded.rework?.addendum) errors.push("Missing rework.addendum");

        // Check for template variables
        const requiredVars = ["{{identifier}}", "{{title}}", "{{description}}", "{{worktreePath}}"];
        for (const v of requiredVars) {
          if (!loaded.worker.task.includes(v)) {
            errors.push(`worker.task missing template variable: ${v}`);
          }
          if (!loaded.audit.task.includes(v)) {
            errors.push(`audit.task missing template variable: ${v}`);
          }
        }

        if (errors.length > 0) {
          console.log("\nValidation FAILED:\n");
          for (const e of errors) console.log(`  - ${e}`);
          console.log();
          process.exitCode = 1;
        } else {
          console.log("\nValidation PASSED — all sections and template variables present.\n");
        }
      } catch (err) {
        console.error(`\nFailed to load prompts: ${err}\n`);
        process.exitCode = 1;
      }
    });

  // --- openclaw openclaw-linear doctor ---
  linear
    .command("doctor")
    .description("Run comprehensive health checks on the Linear plugin")
    .option("--fix", "Auto-fix safe issues (chmod, stale locks, prune old dispatches)")
    .option("--json", "Output results as JSON")
    .action(async (opts: { fix?: boolean; json?: boolean }) => {
      const { runDoctor, formatReport, formatReportJson } = await import("./doctor.js");
      const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;

      const report = await runDoctor({
        fix: opts.fix ?? false,
        json: opts.json ?? false,
        pluginConfig,
      });

      if (opts.json) {
        console.log(formatReportJson(report));
      } else {
        console.log(formatReport(report));
      }

      if (report.summary.errors > 0) {
        process.exitCode = 1;
      }
    });
}
