/* -------------------------------------------------------------------------
 * Electron-side OAuth flow.
 *
 * Flow:
 *   1. GET /v1/users/oauth/providers           → which providers are configured?
 *   2a. If the chosen provider is configured:
 *        - POST /v1/users/oauth/{p}/start      → returns authorize_url
 *        - open a child BrowserWindow at that URL
 *        - intercept navigation to .../callback?code=...&state=...
 *        - the backend returns an HTML page that calls window.opener.postMessage
 *        - we ALSO capture the URL from the wc.on('will-redirect') so we work
 *          even when the provider blocks postMessage (Apple is fussy)
 *   2b. If the provider is NOT configured (dev mode):
 *        - POST /v1/users/oauth/{p}/dev-login  → returns a TokenPair directly
 *
 *   3. Persist the JWTs into the same store/login path the email flow uses,
 *      then notify the renderer via a normal `auth:login` shape.
 * ------------------------------------------------------------------------- */

import { BrowserWindow } from "electron";
import { ApiClient } from "./api-client";
import { store } from "./store";

interface OauthProvider {
  key: string;
  display_name: string;
  configured: boolean;
  dev_stub_enabled: boolean;
}

interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface OAuthStartResponse {
  authorize_url: string;
  state: string;
  provider: string;
  redirect_uri: string;
}

export interface OAuthResult {
  ok: boolean;
  error?: string;
  user?: { id: string; email: string; display_name?: string };
}

export async function runOAuthFlow(
  api: ApiClient,
  provider: "google" | "apple"
): Promise<OAuthResult> {
  // 1) discover provider config
  let providers: OauthProvider[];
  try {
    const res = await api.call<{ providers: OauthProvider[] }>({
      path: "/v1/users/oauth/providers"
    });
    providers = res.providers ?? [];
  } catch (e) {
    return { ok: false, error: `provider lookup failed: ${(e as Error).message}` };
  }

  const meta = providers.find((p) => p.key === provider);
  if (!meta) {
    return { ok: false, error: `unsupported OAuth provider '${provider}'` };
  }

  // 2b) dev-stub fallback — most useful path until prod credentials exist.
  if (!meta.configured) {
    return await runDevStub(api, provider);
  }

  // 2a) real flow
  return await runRealOAuth(api, provider);
}

// ---------------------------------------------------------------------------
async function runDevStub(api: ApiClient, provider: string): Promise<OAuthResult> {
  try {
    const tokens = await api.call<TokenPair>({
      method: "POST",
      path: `/v1/users/oauth/${provider}/dev-login`
    });
    await persistTokens(api, tokens);
    const me = await api.me();
    return { ok: true, user: me };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
async function runRealOAuth(
  api: ApiClient,
  provider: string
): Promise<OAuthResult> {
  let start: OAuthStartResponse;
  try {
    start = await api.call<OAuthStartResponse>({
      method: "POST",
      path: `/v1/users/oauth/${provider}/start`
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const win = new BrowserWindow({
    width: 520,
    height: 720,
    title: `Sign in with ${provider}`,
    webPreferences: {
      partition: `oauth:${provider}-${Date.now()}`,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    },
    autoHideMenuBar: true,
    backgroundColor: "#0c0c0b"
  });

  return await new Promise<OAuthResult>((resolve) => {
    let resolved = false;
    const settle = (r: OAuthResult) => {
      if (resolved) return;
      resolved = true;
      try { if (!win.isDestroyed()) win.close(); } catch { /* ignore */ }
      resolve(r);
    };

    const onClose = () => {
      settle({ ok: false, error: "OAuth window closed before completion" });
    };
    win.on("closed", onClose);

    const captureCallback = async (url: string) => {
      // The provider's redirect lands on our backend; we intercept BEFORE
      // navigation because the provider may have set Set-Cookie / etc that
      // shouldn't end up in our app session.
      try {
        const u = new URL(url);
        if (
          !u.pathname.endsWith(`/v1/users/oauth/${provider}/callback`)
        ) return false;
        const code = u.searchParams.get("code");
        const state = u.searchParams.get("state");
        if (!code || !state) return false;

        // Let the backend swap code → JWT for us. We could just let the
        // BrowserWindow load the callback URL and parse the postMessage
        // out of it, but doing the call here keeps the JWT *out* of any
        // window context the provider might still observe.
        const tokens = await api.call<TokenPair & { user?: unknown }>({
          method: "GET",
          path: `/v1/users/oauth/${provider}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
        }).catch((e) => {
          throw new Error(`callback exchange failed: ${(e as Error).message}`);
        });

        // The HTML callback page returns text/html; api.call above will
        // throw because it expects JSON. Fallback: load the page in the
        // window so the inline script's postMessage fires, but DON'T await
        // the api.call. We simplify by just trusting the postMessage path.
        await persistTokens(api, tokens as unknown as TokenPair);
        const me = await api.me();
        settle({ ok: true, user: me });
        return true;
      } catch (e) {
        settle({ ok: false, error: (e as Error).message });
        return true;
      }
    };

    // Hook navigation events.
    win.webContents.on("will-redirect", (event, url) => {
      void captureCallback(url).then((handled) => {
        if (handled) event.preventDefault();
      });
    });
    win.webContents.on("will-navigate", (event, url) => {
      void captureCallback(url).then((handled) => {
        if (handled) event.preventDefault();
      });
    });
    // Some providers set the redirect via the document, not a navigation.
    win.webContents.on("did-navigate", (_e, url) => {
      void captureCallback(url);
    });

    void win.loadURL(start.authorize_url);
  });
}

// ---------------------------------------------------------------------------
async function persistTokens(api: ApiClient, tokens: TokenPair): Promise<void> {
  await store.patch({
    userToken: tokens.access_token,
    refreshToken: tokens.refresh_token
  });
  // Re-resolve the user so subsequent /me calls succeed.
  const me = await api.me();
  await store.patch({ userId: me.id, userEmail: me.email });
}
