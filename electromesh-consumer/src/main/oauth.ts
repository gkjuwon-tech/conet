/**
 * OAuth helper. Real flow with a child BrowserWindow:
 *
 *   1. Ask the backend for the provider's `authorize_url` via
 *      `POST /v1/users/oauth/{provider}/start`.
 *   2. Open it in a child BrowserWindow.
 *   3. Wait for the navigation to land on the backend's callback URL —
 *      the backend exchanges the OAuth code and renders a tiny HTML page
 *      that embeds the access/refresh tokens inline as JSON for the
 *      `window.opener.postMessage` handshake.
 *   4. We extract those tokens from the page's HTML (since the child
 *      window has no opener, the postMessage itself never fires).
 *   5. Persist tokens and close the window.
 *
 * If the backend's real provider config is missing or the env opts in, the
 * `/dev-login` shortcut still works as a fast path on dev boxes.
 *
 * Renderer contract (unchanged):
 *   auth.oauth("google" | "apple") -> { ok, user?, error? }
 */

import { BrowserWindow, shell } from "electron";
import { api, HttpError } from "./api-client";
import { persistence } from "./store";

const OAUTH_USE_DEV_LOGIN = process.env.EM_OAUTH_USE_DEV_LOGIN === "1";

type OauthResult = { ok: true } | { ok: false; error: string };

export async function oauthLogin(provider: "google" | "apple"): Promise<OauthResult> {
  if (OAUTH_USE_DEV_LOGIN) {
    const dev = await tryDevLogin(provider);
    if (dev.ok) return dev;
  }

  let start: { authorize_url?: string } | null = null;
  try {
    start = await api.oauthStart(provider);
  } catch (err) {
    // Provider not configured on the backend → fall back to dev-login so
    // local-only setups still let you click the button and sign in.
    if (err instanceof HttpError && (err.status === 404 || err.status === 501 || err.status === 503)) {
      const dev = await tryDevLogin(provider);
      if (dev.ok) return dev;
      return { ok: false, error: "Sign-in is temporarily unavailable. Please use email + password." };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : `Failed to start ${provider} sign-in`
    };
  }

  if (!start?.authorize_url) {
    const dev = await tryDevLogin(provider);
    if (dev.ok) return dev;
    return { ok: false, error: "Sign-in is temporarily unavailable. Please use email + password." };
  }

  return await runOauthWindow(provider, start.authorize_url);
}

async function tryDevLogin(provider: "google" | "apple"): Promise<OauthResult> {
  try {
    const tokens = await api.oauthDevLogin(provider);
    if (tokens?.access_token) {
      persistence.setTokens({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token
      });
      return { ok: true };
    }
  } catch {
    /* swallow */
  }
  return { ok: false, error: "dev-login unavailable" };
}

function runOauthWindow(provider: string, authorizeUrl: string): Promise<OauthResult> {
  return new Promise<OauthResult>((resolve) => {
    const child = new BrowserWindow({
      width: 480,
      height: 720,
      title: `Sign in with ${provider}`,
      autoHideMenuBar: true,
      backgroundColor: "#0A0B0A",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: `oauth:${provider}:${Date.now()}`
      }
    });

    let settled = false;
    let extracting = false;
    const finish = (res: OauthResult) => {
      if (settled) return;
      settled = true;
      try {
        if (!child.isDestroyed()) child.destroy();
      } catch {
        /* already gone */
      }
      resolve(res);
    };

    // The callback HTML's inline script calls `window.close()`. Hold the
    // window open while we're reading tokens out so executeJavaScript
    // doesn't race with the renderer being torn down.
    child.on("close", (e) => {
      if (extracting) {
        e.preventDefault();
      }
    });

    child.on("closed", () => {
      finish({ ok: false, error: "Sign-in window closed before completion." });
    });

    // Open any window.open() requests (e.g. provider's "use a different account")
    // in the user's default browser instead of yet another Electron window.
    child.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: "deny" };
    });

    const isCallbackUrl = (url: string): boolean => {
      // matches `<api-base>/v1/users/oauth/<provider>/callback...`
      return /\/v1\/users\/oauth\/[^/]+\/callback(\?|$|#)/.test(url);
    };

    const tryExtract = async () => {
      if (settled || extracting) return;
      extracting = true;
      try {
        const html: string = await child.webContents.executeJavaScript(
          "document.documentElement.outerHTML",
          true
        );
        const result = parseTokensFromHtml(html);
        if (result) {
          persistence.setTokens({
            access_token: result.access_token,
            refresh_token: result.refresh_token ?? null
          });
          extracting = false;
          finish({ ok: true });
        } else {
          extracting = false;
          finish({ ok: false, error: `Sign-in did not return a token for ${provider}.` });
        }
      } catch (err) {
        extracting = false;
        finish({
          ok: false,
          error: err instanceof Error ? err.message : `Failed to read ${provider} callback.`
        });
      }
    };

    child.webContents.on("did-finish-load", () => {
      const url = child.webContents.getURL();
      if (isCallbackUrl(url)) {
        void tryExtract();
      }
    });

    // Some providers fail the redirect before our backend ever sees it
    // (e.g. user denies consent). Catch the navigation error and bail.
    child.webContents.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL) => {
      if (settled) return;
      // ignore aborts that come from `window.close()` after success
      if (errorCode === -3) return;
      if (isCallbackUrl(validatedURL)) return; // give the post-load extract a chance
      finish({
        ok: false,
        error: `Sign-in navigation failed (${errorCode}): ${errorDescription || "unknown"}`
      });
    });

    void child.loadURL(authorizeUrl);
  });
}

/**
 * The backend's callback HTML embeds the tokens as JSON inside an inline
 * `window.opener.postMessage({...})` call. Pull them out with regex —
 * it's the same JSON shape on every callback so this is stable.
 */
function parseTokensFromHtml(html: string): {
  access_token: string;
  refresh_token?: string;
} | null {
  const access = html.match(/"access_token"\s*:\s*"([^"]+)"/);
  if (!access) return null;
  const refresh = html.match(/"refresh_token"\s*:\s*"([^"]+)"/);
  return {
    access_token: access[1] ?? "",
    refresh_token: refresh?.[1] ?? undefined
  };
}
