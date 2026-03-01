import { execSync } from "node:child_process";

/**
 * Check if tmux is available on the system.
 */
export function isTmuxAvailable(): boolean {
  try {
    execSync("tmux -V", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a deterministic tmux session name from issue identifier, backend, and index.
 */
export function buildSessionName(identifier: string, backend: string, index: number): string {
  // tmux session names can't contain dots or colons — sanitize
  const safe = `${identifier}-${backend}-${index}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `claw-${safe}`;
}

/**
 * Escape a string for safe shell interpolation (single-quote wrapping).
 */
export function shellEscape(value: string): string {
  // Wrap in single quotes, escaping any embedded single quotes
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Capture the last N lines from a tmux session pane.
 */
export function capturePane(sessionName: string, lines: number): string {
  try {
    return execSync(
      `tmux capture-pane -t ${shellEscape(sessionName)} -p -S -${lines}`,
      { encoding: "utf8", timeout: 5_000 },
    ).trimEnd();
  } catch {
    return "";
  }
}
