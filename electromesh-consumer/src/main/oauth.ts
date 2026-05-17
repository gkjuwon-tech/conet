/**
 * OAuth helper. For real prod use the backend would issue an authorize URL
 * we'd open in the system browser and exchange the callback code for tokens.
 * For development / first-run usability we prefer the backend's
 * `/v1/users/oauth/{provider}/dev-login` shortcut which immediately mints a
 * JWT pair. This keeps the consumer app testable on a dev box without
 * configuring a full Google/Apple OAuth client.
 *
 * Renderer expectations (from the IPC contract):
 *   auth.oauth("google" | "apple") -> { ok, user?, error? }
 *
 * Strategy:
 *   1. Try `dev-login` (works against a dev backend).
 *   2. If that fails or returns a marker, fall back to `start` and open
 *      the URL in the user's default browser. Surface a helpful error
 *      so the renderer can show "complete sign-in in your browser".
 */

import { shell } from "electron";
import { api } from "./api-client";
import { persistence } from "./store";

export async function oauthLogin(provider: "google" | "apple") {
  // Path 1: dev shortcut
  try {
    const tokens = await api.oauthDevLogin(provider);
    if (tokens && tokens.access_token) {
      persistence.setTokens({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
      return { ok: true as const };
    }
  } catch {
    // fall through
  }

  // Path 2: open browser, ask user to complete sign-in
  try {
    const start = await api.oauthStart(provider);
    if (start?.authorize_url) {
      await shell.openExternal(start.authorize_url);
      return {
        ok: false as const,
        error: `Complete ${provider} sign-in in your browser, then sign in with the issued credentials.`
      };
    }
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : `OAuth start failed for ${provider}`
    };
  }
  return { ok: false as const, error: `OAuth not configured for ${provider}` };
}
