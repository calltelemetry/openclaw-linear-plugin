import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { refreshTokenProactively } from "../api/linear-api.js";

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the proactive token refresh timer.
 * Runs immediately on start, then every 6 hours.
 */
export function startTokenRefreshTimer(
  api: OpenClawPluginApi,
  pluginConfig?: Record<string, unknown>,
): void {
  // Run immediately
  doRefresh(api, pluginConfig);

  // Then schedule periodic refresh
  timer = setInterval(() => doRefresh(api, pluginConfig), REFRESH_INTERVAL_MS);
  // Don't keep the process alive just for this timer
  if (timer && typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }
}

/**
 * Stop the proactive token refresh timer.
 */
export function stopTokenRefreshTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function doRefresh(
  api: OpenClawPluginApi,
  pluginConfig?: Record<string, unknown>,
): Promise<void> {
  try {
    const result = await refreshTokenProactively(pluginConfig);
    if (result.refreshed) {
      api.logger.info(`Token refresh: ${result.reason}`);
    } else {
      api.logger.debug?.(`Token refresh skipped: ${result.reason}`);
    }
  } catch (err) {
    api.logger.warn(`Token refresh failed: ${err}`);
  }
}
