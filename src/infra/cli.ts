/**
 * cli.ts — CLI registration for `openclaw openclaw-linear auth` and `openclaw openclaw-linear status`.
 */
import type { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createInterface } from "node:readline";
import { exec } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLinearToken, LinearAgentApi, AUTH_PROFILES_PATH, LINEAR_GRAPHQL_URL } from "../api/linear-api.js";
import { validateRepoPath } from "./multi-repo.js";
import { LINEAR_OAUTH_AUTH_URL, LINEAR_OAUTH_TOKEN_URL, LINEAR_AGENT_SCOPES } from "../api/auth.js";
import { listWorktrees } from "./codex-worktree.js";
import { loadPrompts, clearPromptCache } from "../pipeline/pipeline.js";
import { PROFILES_PATH, createAgentProfilesFile, loadAgentProfiles } from "./shared-profiles.js";
import {
  formatMessage,
  parseNotificationsConfig,
  sendToTarget,
  type NotifyKind,
  type NotifyPayload,
} from "./notify.js";

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

  // --- interactive profile creation helper ---
  async function createProfileInteractive(): Promise<void> {
    const name = await prompt("  Agent name (lowercase, no spaces — e.g. bobbin): ");
    if (!name) {
      console.log("  Skipped.\n");
      return;
    }

    const agentId = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (!agentId) {
      console.log("  Invalid name. Skipped.\n");
      return;
    }

    const labelDefault = agentId.charAt(0).toUpperCase() + agentId.slice(1);
    const labelInput = await prompt(`  Display label [${labelDefault}]: `);
    const label = labelInput || labelDefault;

    const aliasInput = await prompt(`  Additional @mention aliases (comma-separated, or blank): `);
    const extraAliases = aliasInput
      ? aliasInput.split(",").map(a => a.trim().toLowerCase()).filter(Boolean)
      : [];
    const mentionAliases = [agentId, ...extraAliases.filter(a => a !== agentId)];

    try {
      createAgentProfilesFile({ agentId, label, mentionAliases });
      console.log(`\n  ✓ Created ${PROFILES_PATH}`);
      console.log(`    Agent: ${agentId} (${label})`);
      console.log(`    Aliases: ${mentionAliases.map(a => "@" + a).join(", ")}`);
      console.log(`    Default: yes`);
    } catch (err) {
      console.log(`\n  ✗ Failed to create agent-profiles.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- openclaw openclaw-linear setup ---
  linear
    .command("setup")
    .description("Guided first-time setup — creates agent profile, checks auth, provisions webhook")
    .action(async () => {
      const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;

      console.log("\nLinear Plugin Setup");
      console.log("═".repeat(50));

      // ---------------------------------------------------------------
      // Step 1: Agent Profile
      // ---------------------------------------------------------------
      console.log("\nStep 1: Agent Profile");
      console.log("─".repeat(50));

      if (existsSync(PROFILES_PATH)) {
        const profiles = loadAgentProfiles();
        const count = Object.keys(profiles).length;
        if (count > 0) {
          const names = Object.entries(profiles)
            .map(([id, p]) => `${id}${p.isDefault ? " (default)" : ""}`)
            .join(", ");
          console.log(`  ✓ agent-profiles.json found (${count} agent${count > 1 ? "s" : ""}: ${names})`);
        } else {
          console.log("  ⚠ agent-profiles.json exists but has no agents.");
          const fix = await prompt("  Overwrite with a new profile? [Y/n]: ");
          if (fix.toLowerCase() === "n") {
            console.log("  Skipped. Fix the file manually and re-run setup.\n");
          } else {
            await createProfileInteractive();
          }
        }
      } else {
        console.log("  No agent-profiles.json found — let's create one!\n");
        console.log("  Your agent needs a name so Linear users can @mention it.");
        console.log("  Example: if your agent is called \"bobbin\", users type @bobbin in comments.\n");
        await createProfileInteractive();
      }

      // ---------------------------------------------------------------
      // Step 2: Authentication
      // ---------------------------------------------------------------
      console.log("\nStep 2: Authentication");
      console.log("─".repeat(50));

      const tokenInfo = resolveLinearToken(pluginConfig);
      if (tokenInfo.accessToken) {
        // Verify the token works
        try {
          const authHeader = tokenInfo.refreshToken
            ? `Bearer ${tokenInfo.accessToken}`
            : tokenInfo.accessToken;
          const res = await fetch(LINEAR_GRAPHQL_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authHeader },
            body: JSON.stringify({ query: `{ viewer { name } organization { name } }` }),
          });
          if (res.ok) {
            const payload = await res.json() as any;
            if (payload.data?.viewer) {
              console.log(`  ✓ Authenticated as ${payload.data.viewer.name} (${payload.data.organization.name})`);
            } else {
              console.log(`  ⚠ Token found but API returned errors. Run: openclaw openclaw-linear auth`);
            }
          } else {
            console.log(`  ⚠ Token found but API returned ${res.status}. Run: openclaw openclaw-linear auth`);
          }
        } catch {
          console.log(`  ⚠ Token found but API unreachable. Check network and retry.`);
        }
      } else {
        console.log("  No Linear token found.\n");
        const doAuth = await prompt("  Run OAuth authorization now? [Y/n]: ");
        if (doAuth.toLowerCase() !== "n") {
          const clientId = (pluginConfig?.clientId as string) ?? process.env.LINEAR_CLIENT_ID;
          const clientSecret = (pluginConfig?.clientSecret as string) ?? process.env.LINEAR_CLIENT_SECRET;

          if (!clientId || !clientSecret) {
            console.log("\n  ✗ OAuth client ID and secret not configured.");
            console.log("    Set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET env vars,");
            console.log("    or add clientId/clientSecret to the plugin config in openclaw.json.");
            console.log("    Then re-run: openclaw openclaw-linear setup\n");
          } else {
            const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT ?? "18789";
            const redirectUri = (pluginConfig?.redirectUri as string)
              ?? process.env.LINEAR_REDIRECT_URI
              ?? `http://localhost:${gatewayPort}/linear/oauth/callback`;

            const state = Math.random().toString(36).substring(7);
            const authUrl = `${LINEAR_OAUTH_AUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(LINEAR_AGENT_SCOPES)}&state=${state}&actor=app`;

            console.log("\n  Opening Linear OAuth page...\n");
            console.log(`    ${authUrl}\n`);
            openBrowser(authUrl);

            const code = await prompt("  Paste the authorization code from Linear: ");
            if (code) {
              try {
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

                if (response.ok) {
                  const tokens = await response.json() as any;
                  let store: any = { version: 1, profiles: {} };
                  try {
                    const raw = readFileSync(AUTH_PROFILES_PATH, "utf8");
                    store = JSON.parse(raw);
                  } catch { /* fresh store */ }

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
                  console.log("  ✓ Token saved to auth-profiles.json");
                } else {
                  const error = await response.text();
                  console.log(`  ✗ Token exchange failed (${response.status}): ${error}`);
                }
              } catch (err) {
                console.log(`  ✗ Token exchange error: ${err instanceof Error ? err.message : String(err)}`);
              }
            } else {
              console.log("  Skipped. Run: openclaw openclaw-linear auth later.");
            }
          }
        } else {
          console.log("  Skipped. Run: openclaw openclaw-linear auth when ready.");
        }
      }

      // ---------------------------------------------------------------
      // Step 3: Webhook
      // ---------------------------------------------------------------
      console.log("\nStep 3: Webhook");
      console.log("─".repeat(50));

      const freshToken = resolveLinearToken(pluginConfig);
      if (!freshToken.accessToken) {
        console.log("  ⚠ Skipped — no auth token available. Complete Step 2 first.");
      } else {
        const { provisionWebhook, getWebhookStatus } = await import("./webhook-provision.js");
        const linearApi = new LinearAgentApi(freshToken.accessToken, {
          refreshToken: freshToken.refreshToken,
          expiresAt: freshToken.expiresAt,
        });

        const webhookUrl = (pluginConfig?.webhookUrl as string)
          ?? "https://linear.calltelemetry.com/linear/webhook";

        try {
          const status = await getWebhookStatus(linearApi, webhookUrl);
          if (status && status.issues.length === 0) {
            console.log(`  ✓ Webhook already configured (${webhookUrl})`);
          } else {
            const result = await provisionWebhook(linearApi, webhookUrl, { allPublicTeams: true });
            if (result.action === "created") {
              console.log(`  ✓ Webhook created (${result.webhookId})`);
            } else if (result.action === "updated") {
              console.log(`  ✓ Webhook updated (${result.webhookId})`);
            } else {
              console.log(`  ✓ Webhook OK (${result.webhookId})`);
            }
          }
        } catch (err) {
          console.log(`  ⚠ Webhook check failed: ${err instanceof Error ? err.message : String(err)}`);
          console.log("    Run: openclaw openclaw-linear webhooks setup");
        }
      }

      // ---------------------------------------------------------------
      // Step 4: Verify
      // ---------------------------------------------------------------
      console.log("\nStep 4: Verification");
      console.log("─".repeat(50));

      try {
        const { runDoctor, formatReport } = await import("./doctor.js");
        const report = await runDoctor({
          fix: false,
          json: false,
          pluginConfig,
        });

        console.log(formatReport(report));

        if (report.summary.errors === 0) {
          const profiles = loadAgentProfiles();
          const defaultAgent = Object.entries(profiles).find(([, p]) => p.isDefault);
          const agentName = defaultAgent?.[1]?.label ?? defaultAgent?.[0] ?? "your agent";
          console.log("─".repeat(50));
          console.log(`Setup complete! ${agentName} is ready to receive Linear issues.`);
          console.log(`\nRestart the gateway to apply changes:`);
          console.log(`  systemctl --user restart openclaw-gateway\n`);
        } else {
          console.log("─".repeat(50));
          console.log("Some issues remain. Fix them and run: openclaw openclaw-linear doctor --fix\n");
          process.exitCode = 1;
        }
      } catch (err) {
        console.log(`  ⚠ Doctor failed: ${err instanceof Error ? err.message : String(err)}`);
        console.log("  Run: openclaw openclaw-linear doctor for details.\n");
      }
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

  // --- openclaw openclaw-linear repos ---
  const repos = linear
    .command("repos")
    .description("Validate multi-repo config and sync labels to Linear");

  repos
    .command("check")
    .description("Validate repo paths and show what labels would be created (dry run)")
    .action(async () => {
      await reposAction(api, { dryRun: true });
    });

  repos
    .command("sync")
    .description("Create missing repo: labels in Linear from your repos config")
    .action(async () => {
      await reposAction(api, { dryRun: false });
    });

  // --- openclaw openclaw-linear prompts ---
  const prompts = linear
    .command("prompts")
    .description("Manage pipeline prompt templates (prompts.yaml)");

  prompts
    .command("show")
    .description("Print resolved prompts (global or per-project)")
    .option("--worktree <path>", "Show merged prompts for a specific worktree")
    .action(async (opts: { worktree?: string }) => {
      const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
      clearPromptCache();
      const loaded = loadPrompts(pluginConfig, opts.worktree);

      if (opts.worktree) {
        console.log(`\nResolved prompts for worktree: ${opts.worktree}\n`);
      } else {
        console.log(`\nGlobal resolved prompts\n`);
      }

      console.log(JSON.stringify(loaded, null, 2));
      console.log();
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
    .description("Validate prompts.yaml structure (global or per-project)")
    .option("--worktree <path>", "Validate merged prompts for a specific worktree")
    .action(async (opts: { worktree?: string }) => {
      const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
      clearPromptCache();

      try {
        const loaded = loadPrompts(pluginConfig, opts.worktree);
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

        const label = opts.worktree ? `worktree ${opts.worktree}` : "global";
        if (errors.length > 0) {
          console.log(`\nValidation FAILED (${label}):\n`);
          for (const e of errors) console.log(`  - ${e}`);
          console.log();
          process.exitCode = 1;
        } else {
          console.log(`\nValidation PASSED (${label}) — all sections and template variables present.\n`);
        }
      } catch (err) {
        console.error(`\nFailed to load prompts: ${err}\n`);
        process.exitCode = 1;
      }
    });

  prompts
    .command("init")
    .description("Scaffold per-project .claw/prompts.yaml in a worktree")
    .argument("<worktree-path>", "Path to the worktree")
    .action(async (worktreePath: string) => {
      const { mkdirSync, writeFileSync: writeFS } = await import("node:fs");
      const clawDir = join(worktreePath, ".claw");
      const promptsFile = join(clawDir, "prompts.yaml");

      if (existsSync(promptsFile)) {
        console.log(`\n  ${promptsFile} already exists.\n`);
        return;
      }

      mkdirSync(clawDir, { recursive: true });
      writeFS(promptsFile, [
        "# Per-project prompt overrides for Linear Agent pipeline.",
        "# Only include sections/fields you want to override.",
        "# Unspecified fields inherit from the global prompts.yaml.",
        "#",
        "# Available sections: worker, audit, rework",
        "# Template variables: {{identifier}}, {{title}}, {{description}}, {{worktreePath}}, {{tier}}, {{attempt}}, {{gaps}}",
        "",
        "# worker:",
        "#   system: \"Custom system prompt for workers in this project.\"",
        "#   task: \"Implement issue {{identifier}}: {{title}}\\n\\n{{description}}\\n\\nWorktree: {{worktreePath}}\"",
        "",
        "# audit:",
        "#   system: \"Custom audit system prompt for this project.\"",
        "",
        "# rework:",
        "#   addendum: \"Custom rework addendum for this project.\"",
        "",
      ].join("\n"), "utf-8");

      console.log(`\n  Created: ${promptsFile}`);
      console.log(`  Edit this file to customize prompts for this worktree.\n`);
    });

  prompts
    .command("diff")
    .description("Show differences between global and per-project prompts")
    .argument("<worktree-path>", "Path to the worktree")
    .action(async (worktreePath: string) => {
      const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
      clearPromptCache();

      const global = loadPrompts(pluginConfig);
      const merged = loadPrompts(pluginConfig, worktreePath);

      const projectFile = join(worktreePath, ".claw", "prompts.yaml");
      if (!existsSync(projectFile)) {
        console.log(`\n  No per-project prompts at ${projectFile}`);
        console.log(`  Run 'openclaw openclaw-linear prompts init ${worktreePath}' to create one.\n`);
        return;
      }

      console.log(`\nPrompt diff: global vs ${worktreePath}\n`);

      let hasDiffs = false;
      for (const section of ["worker", "audit", "rework"] as const) {
        const globalSection = global[section] as Record<string, string>;
        const mergedSection = merged[section] as Record<string, string>;
        for (const [key, val] of Object.entries(mergedSection)) {
          if (globalSection[key] !== val) {
            hasDiffs = true;
            console.log(`  ${section}.${key}:`);
            console.log(`    global:  ${globalSection[key]?.slice(0, 100)}...`);
            console.log(`    project: ${val.slice(0, 100)}...`);
            console.log();
          }
        }
      }

      if (!hasDiffs) {
        console.log("  No differences — per-project prompts match global.\n");
      }
    });

  // --- openclaw openclaw-linear notify ---
  const notifyCmd = linear
    .command("notify")
    .description("Manage dispatch lifecycle notifications");

  notifyCmd
    .command("status")
    .description("Show current notification target configuration")
    .action(async () => {
      const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
      const config = parseNotificationsConfig(pluginConfig);

      console.log("\nNotification Targets");
      console.log("─".repeat(50));

      if (!config.targets?.length) {
        console.log("\n  No notification targets configured.");
        console.log("  Run 'openclaw openclaw-linear notify setup' to configure.\n");
        return;
      }

      for (const t of config.targets) {
        const acct = t.accountId ? ` (account: ${t.accountId})` : "";
        console.log(`  ${t.channel}:  ${t.target}${acct}`);
      }

      // Show event toggles if any are suppressed
      const suppressed = Object.entries(config.events ?? {})
        .filter(([, v]) => v === false)
        .map(([k]) => k);
      if (suppressed.length > 0) {
        console.log(`\n  Suppressed events: ${suppressed.join(", ")}`);
      }

      console.log();
    });

  notifyCmd
    .command("test")
    .description("Send a test notification to all configured targets")
    .option("--channel <name>", "Test only targets for a specific channel (discord, slack, telegram, etc.)")
    .action(async (opts: { channel?: string }) => {
      const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
      const config = parseNotificationsConfig(pluginConfig);

      const testPayload: NotifyPayload = {
        identifier: "TEST-0",
        title: "Test notification from Linear plugin",
        status: "test",
      };
      const testKind: NotifyKind = "dispatch";
      const message = formatMessage(testKind, testPayload);

      console.log("\nSending test notification...\n");

      if (!config.targets?.length) {
        console.error("  No notification targets configured. Run 'openclaw openclaw-linear notify setup' first.\n");
        process.exitCode = 1;
        return;
      }

      const targets = opts.channel
        ? config.targets.filter((t) => t.channel === opts.channel)
        : config.targets;

      if (targets.length === 0) {
        console.error(`  No targets found for channel "${opts.channel}".\n`);
        process.exitCode = 1;
        return;
      }

      for (const target of targets) {
        try {
          await sendToTarget(target, message, api.runtime);
          console.log(`  ${target.channel}:  SENT to ${target.target}`);
          console.log(`            "${message}"`);
        } catch (err) {
          console.error(`  ${target.channel}:  FAILED — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      console.log();
    });

  notifyCmd
    .command("setup")
    .description("Interactive setup for notification targets")
    .action(async () => {
      const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
      const config = parseNotificationsConfig(pluginConfig);

      console.log("\nNotification Target Setup");
      console.log("─".repeat(50));
      console.log("  Dispatch lifecycle notifications can be sent to any OpenClaw channel.");
      console.log("  Add multiple targets for fan-out delivery.\n");

      // Show current targets
      if (config.targets?.length) {
        console.log("  Current targets:");
        for (const t of config.targets) {
          const acct = t.accountId ? ` (account: ${t.accountId})` : "";
          console.log(`    ${t.channel}: ${t.target}${acct}`);
        }
        console.log();
      }

      const newTargets = [...(config.targets ?? [])];
      const supportedChannels = ["discord", "slack", "telegram", "signal"];

      // Add targets loop
      let addMore = true;
      while (addMore) {
        const channelAnswer = await prompt(
          `Add notification target? (${supportedChannels.join("/")}) or blank to finish: `,
        );
        if (!channelAnswer) {
          addMore = false;
          break;
        }

        const channel = channelAnswer.toLowerCase().trim();
        const targetId = await prompt(`  ${channel} target ID (channel/group/user): `);
        if (!targetId) continue;

        let accountId: string | undefined;
        if (channel === "slack") {
          const acct = await prompt("  Slack account ID (leave blank for default): ");
          accountId = acct || undefined;
        }

        newTargets.push({ channel, target: targetId, ...(accountId ? { accountId } : {}) });
        console.log(`  Added: ${channel} → ${targetId}\n`);
      }

      // Summary
      console.log("\nConfiguration Summary");
      console.log("─".repeat(50));
      if (newTargets.length === 0) {
        console.log("  No targets configured (notifications disabled).");
      } else {
        for (const t of newTargets) {
          const acct = t.accountId ? ` (account: ${t.accountId})` : "";
          console.log(`  ${t.channel}: ${t.target}${acct}`);
        }
      }

      if (JSON.stringify(newTargets) === JSON.stringify(config.targets ?? [])) {
        console.log("\n  No changes made.\n");
        return;
      }

      // Write config
      const confirmAnswer = await prompt("\nApply these changes? [Y/n]: ");
      if (confirmAnswer.toLowerCase() === "n") {
        console.log("  Aborted.\n");
        return;
      }

      try {
        const runtimeConfig = api.runtime.config.loadConfig() as Record<string, any>;
        const pluginEntries = runtimeConfig.plugins?.entries ?? {};
        const linearConfig = pluginEntries["openclaw-linear"]?.config ?? {};
        linearConfig.notifications = {
          ...linearConfig.notifications,
          targets: newTargets,
        };
        pluginEntries["openclaw-linear"] = {
          ...pluginEntries["openclaw-linear"],
          config: linearConfig,
        };
        runtimeConfig.plugins = { ...runtimeConfig.plugins, entries: pluginEntries };
        api.runtime.config.writeConfigFile(runtimeConfig);
        console.log("\n  Configuration saved. Restart gateway to apply: systemctl --user restart openclaw-gateway\n");
      } catch (err) {
        console.error(`\n  Failed to save config: ${err instanceof Error ? err.message : String(err)}`);
        console.error("  You can manually add these values to openclaw.json → plugins.entries.openclaw-linear.config\n");
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

  // --- openclaw openclaw-linear code-run ---
  const codeRunCmd = linear
    .command("code-run")
    .description("Manage and diagnose coding tool backends");

  codeRunCmd
    .command("doctor")
    .description("Deep health check: verify each coding backend (Claude, Codex, Gemini) is callable")
    .option("--json", "Output results as JSON")
    .action(async (opts: { json?: boolean }) => {
      const { checkCodeRunDeep, buildSummary, formatReport, formatReportJson } = await import("./doctor.js");
      const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;

      const sections = await checkCodeRunDeep(pluginConfig);
      const report = { sections, summary: buildSummary(sections) };

      if (opts.json) {
        console.log(formatReportJson(report));
      } else {
        console.log(formatReport(report));
      }

      if (report.summary.errors > 0) {
        process.exitCode = 1;
      }
    });

  // --- openclaw openclaw-linear webhooks ---
  const webhooksCmd = linear
    .command("webhooks")
    .description("Manage Linear webhook subscriptions");

  webhooksCmd
    .command("status")
    .description("Show current webhook configuration in Linear")
    .action(async () => {
      const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
      const tokenInfo = resolveLinearToken(pluginConfig);
      if (!tokenInfo.accessToken) {
        console.error("\n  No Linear token found. Run \"openclaw openclaw-linear auth\" first.\n");
        process.exitCode = 1;
        return;
      }

      const linearApi = new LinearAgentApi(tokenInfo.accessToken, {
        refreshToken: tokenInfo.refreshToken,
        expiresAt: tokenInfo.expiresAt,
      });

      console.log("\nLinear Webhooks");
      console.log("─".repeat(50));

      const webhooks = await linearApi.listWebhooks();
      if (webhooks.length === 0) {
        console.log("\n  No webhooks found.");
        console.log("  Run \"openclaw openclaw-linear webhooks setup\" to create one.\n");
        return;
      }

      for (const wh of webhooks) {
        const status = wh.enabled ? "enabled" : "DISABLED";
        const label = wh.label ?? "(no label)";
        const team = wh.team ? ` (team: ${wh.team.name})` : " (all teams)";
        console.log(`\n  ${label}${team}`);
        console.log(`    ID:      ${wh.id}`);
        console.log(`    URL:     ${wh.url}`);
        console.log(`    Status:  ${status}`);
        console.log(`    Events:  ${wh.resourceTypes.join(", ")}`);
        console.log(`    Created: ${wh.createdAt}`);
      }

      console.log();
    });

  webhooksCmd
    .command("setup")
    .description("Auto-provision or fix the workspace webhook (create/update as needed)")
    .option("--url <url>", "Webhook URL (default: from Cloudflare tunnel config)")
    .option("--team <id>", "Restrict to a specific team ID (default: all public teams)")
    .option("--dry-run", "Show what would change without making changes")
    .action(async (opts: { url?: string; team?: string; dryRun?: boolean }) => {
      const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
      const { provisionWebhook, getWebhookStatus, REQUIRED_RESOURCE_TYPES } = await import("./webhook-provision.js");

      const tokenInfo = resolveLinearToken(pluginConfig);
      if (!tokenInfo.accessToken) {
        console.error("\n  No Linear token found. Run \"openclaw openclaw-linear auth\" first.\n");
        process.exitCode = 1;
        return;
      }

      const linearApi = new LinearAgentApi(tokenInfo.accessToken, {
        refreshToken: tokenInfo.refreshToken,
        expiresAt: tokenInfo.expiresAt,
      });

      const webhookUrl = opts.url
        ?? (pluginConfig?.webhookUrl as string)
        ?? "https://linear.calltelemetry.com/linear/webhook";

      console.log("\nWebhook Provisioning");
      console.log("─".repeat(50));
      console.log(`  URL:    ${webhookUrl}`);
      console.log(`  Events: ${[...REQUIRED_RESOURCE_TYPES].join(", ")}`);

      if (opts.dryRun) {
        const status = await getWebhookStatus(linearApi, webhookUrl);
        if (!status) {
          console.log("\n  Would CREATE a new webhook with the above config.");
        } else if (status.issues.length === 0) {
          console.log("\n  Webhook already configured correctly. No changes needed.");
        } else {
          console.log("\n  Would UPDATE existing webhook:");
          for (const issue of status.issues) {
            console.log(`    - Fix: ${issue}`);
          }
        }
        console.log();
        return;
      }

      const result = await provisionWebhook(linearApi, webhookUrl, {
        teamId: opts.team,
        allPublicTeams: !opts.team,
      });

      switch (result.action) {
        case "created":
          console.log(`\n  Created webhook: ${result.webhookId}`);
          break;
        case "updated":
          console.log(`\n  Updated webhook: ${result.webhookId}`);
          for (const change of result.changes ?? []) {
            console.log(`    - ${change}`);
          }
          break;
        case "already_ok":
          console.log(`\n  Webhook already configured correctly (${result.webhookId}). No changes needed.`);
          break;
      }

      console.log();
    });

  webhooksCmd
    .command("delete")
    .description("Delete a webhook by ID")
    .argument("<webhook-id>", "ID of the webhook to delete")
    .action(async (webhookId: string) => {
      const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
      const tokenInfo = resolveLinearToken(pluginConfig);
      if (!tokenInfo.accessToken) {
        console.error("\n  No Linear token found.\n");
        process.exitCode = 1;
        return;
      }

      const linearApi = new LinearAgentApi(tokenInfo.accessToken, {
        refreshToken: tokenInfo.refreshToken,
        expiresAt: tokenInfo.expiresAt,
      });

      const confirmAnswer = await prompt(`Delete webhook ${webhookId}? [y/N]: `);
      if (confirmAnswer.toLowerCase() !== "y") {
        console.log("  Aborted.\n");
        return;
      }

      const success = await linearApi.deleteWebhook(webhookId);
      if (success) {
        console.log(`\n  Deleted webhook ${webhookId}\n`);
      } else {
        console.error(`\n  Failed to delete webhook ${webhookId}\n`);
        process.exitCode = 1;
      }
    });
}

// ---------------------------------------------------------------------------
// repos sync / check helper
// ---------------------------------------------------------------------------

const REPO_LABEL_COLOR = "#5e6ad2"; // Linear indigo

async function reposAction(
  api: OpenClawPluginApi,
  opts: { dryRun: boolean },
): Promise<void> {
  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
  const reposMap = (pluginConfig?.repos as Record<string, string> | undefined) ?? {};
  const repoNames = Object.keys(reposMap);

  const mode = opts.dryRun ? "Repos Check" : "Repos Sync";
  console.log(`\n${mode}`);
  console.log("─".repeat(40));

  // 1. Validate config
  if (repoNames.length === 0) {
    console.log(`\n  No "repos" configured in plugin config.`);
    console.log(`  Add a repos map to openclaw.json → plugins.entries.openclaw-linear.config:`);
    console.log(`\n    "repos": {`);
    console.log(`      "api": "~/repos/api",`);
    console.log(`      "frontend": "~/repos/frontend"`);
    console.log(`    }\n`);
    return;
  }

  // 2. Validate each repo path
  console.log("\n  Repos from config:");
  const warnings: string[] = [];

  for (const name of repoNames) {
    const repoPath = reposMap[name];
    const status = validateRepoPath(repoPath);
    const pad = name.padEnd(16);

    if (!status.exists) {
      console.log(`  \u2717 ${pad} ${repoPath} (path not found)`);
      warnings.push(`"${name}" at ${repoPath} does not exist`);
    } else if (!status.isGitRepo) {
      console.log(`  \u2717 ${pad} ${repoPath} (not a git repo)`);
      warnings.push(`"${name}" at ${repoPath} is not a git repository`);
    } else if (status.isSubmodule) {
      console.log(`  \u26a0 ${pad} ${repoPath} (submodule)`);
      warnings.push(`"${name}" at ${repoPath} is a git submodule`);
    } else {
      console.log(`  \u2714 ${pad} ${repoPath} (git repo)`);
    }
  }

  // 3. Connect to Linear
  const tokenInfo = resolveLinearToken(pluginConfig);
  if (!tokenInfo.accessToken) {
    console.log(`\n  No Linear token found. Run "openclaw openclaw-linear auth" first.\n`);
    process.exitCode = 1;
    return;
  }

  const linearApi = new LinearAgentApi(tokenInfo.accessToken, {
    refreshToken: tokenInfo.refreshToken,
    expiresAt: tokenInfo.expiresAt,
    clientId: pluginConfig?.clientId as string | undefined,
    clientSecret: pluginConfig?.clientSecret as string | undefined,
  });

  // 4. Get teams
  let teams: Array<{ id: string; name: string; key: string }>;
  try {
    teams = await linearApi.getTeams();
  } catch (err) {
    console.log(`\n  Failed to fetch teams: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  if (teams.length === 0) {
    console.log(`\n  No teams found in your Linear workspace.\n`);
    return;
  }

  // 5. Sync labels per team
  let totalCreated = 0;
  let totalExisted = 0;

  for (const team of teams) {
    console.log(`\n  Team: ${team.name} (${team.key})`);

    let existingLabels: Array<{ id: string; name: string }>;
    try {
      existingLabels = await linearApi.getTeamLabels(team.id);
    } catch (err) {
      console.log(`    Failed to fetch labels: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const existingNames = new Set(existingLabels.map(l => l.name.toLowerCase()));

    for (const name of repoNames) {
      const labelName = `repo:${name}`;

      if (existingNames.has(labelName.toLowerCase())) {
        console.log(`  \u2714 ${labelName.padEnd(24)} already exists`);
        totalExisted++;
      } else if (opts.dryRun) {
        console.log(`  + ${labelName.padEnd(24)} would be created`);
      } else {
        try {
          await linearApi.createLabel(team.id, labelName, {
            color: REPO_LABEL_COLOR,
            description: `Multi-repo dispatch: ${name}`,
          });
          console.log(`  + ${labelName.padEnd(24)} created`);
          totalCreated++;
        } catch (err) {
          console.log(`  \u2717 ${labelName.padEnd(24)} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // 6. Summary
  if (opts.dryRun) {
    const wouldCreate = repoNames.length * teams.length - totalExisted;
    console.log(`\n  Dry run: ${wouldCreate} label(s) would be created, ${totalExisted} already exist`);
  } else {
    console.log(`\n  Summary: ${totalCreated} created, ${totalExisted} already existed`);
  }

  // 7. Submodule warnings
  const submoduleWarnings = warnings.filter(w => w.includes("submodule"));
  if (submoduleWarnings.length > 0) {
    console.log(`\n  \u26a0 Submodule warning:`);
    for (const w of submoduleWarnings) {
      console.log(`    ${w}`);
    }
    console.log(`    Multi-repo dispatch uses "git worktree add" which doesn't work on submodules.`);
    console.log(`    Options:`);
    console.log(`    1. Clone the repo as a standalone repo instead`);
    console.log(`    2. Remove it from "repos" config and use the parent repo as codexBaseRepo`);
  }

  // Other warnings
  const otherWarnings = warnings.filter(w => !w.includes("submodule"));
  if (otherWarnings.length > 0) {
    console.log(`\n  Warnings:`);
    for (const w of otherWarnings) {
      console.log(`    \u26a0 ${w}`);
    }
  }

  console.log();
}
