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
import { api } from "./api-client";
import { persistence } from "./store";

// We exclusively use the real OAuth flow now — opening the provider's own
// consent screen in a child window. The old "dev-stub fallback" silently
// logged anyone-who-clicked-the-button in as a shared `oauth_<provider>@
// electromesh.dev` user; that produced a "Google Demo · PERSONAL" identity
// in the rail and meant every button on the login page resolved to the
// same account. That is now gone. If the provider isn't configured the UI
// surfaces a real error and asks the user to set EM_OAUTH_..._CLIENT_ID.

type OauthResult = { ok: true } | { ok: false; error: string };

const PROVIDER_LABEL: Record<string, string> = {
  google: "Google",
  apple: "Apple",
};

function label(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider;
}

export async function oauthLogin(provider: "google" | "apple"): Promise<OauthResult> {
  let start: { authorize_url?: string } | null = null;
  try {
    start = await api.oauthStart(provider);
  } catch (err) {
    void err;
    return {
      ok: false,
      error: `${label(provider)} sign-in isn't configured on this backend. Ask the admin to set EM_OAUTH_${provider.toUpperCase()}_CLIENT_ID, or use email + password.`,
    };
  }

  if (!start?.authorize_url) {
    return {
      ok: false,
      error: `${label(provider)} sign-in isn't configured on this backend. Ask the admin to set EM_OAUTH_${provider.toUpperCase()}_CLIENT_ID, or use email + password.`,
    };
  }

  return await runOauthWindow(provider, start.authorize_url);
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
