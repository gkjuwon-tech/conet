import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "./constants";
import { ApiClient, HttpError } from "./api-client";
import { store } from "./store";

function formatError(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.detail && Object.keys(err.detail).length) {
      return `${err.code}: ${err.message} (${JSON.stringify(err.detail)})`;
    }
    return `${err.code}: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function ok<T>(data: T) {
  return { ok: true as const, data };
}
function fail(err: unknown) {
  return { ok: false as const, error: formatError(err) };
}

export function registerIpc(window: BrowserWindow, api: ApiClient): void {
  /**
   * Wrap an async backend call with uniform 401 handling: on 401 we
   * clear the saved api-key + tenant cache and notify the renderer so
   * the user gets bounced back to /login. Other errors are forwarded as a
   * structured `{ok:false, error}` payload.
   */
  async function guard<T>(
    fn: () => Promise<T>
  ): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    try {
      return ok(await fn());
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        await store.clearAuth();
        try {
          window.webContents.send(IPC.authLoggedOut, {
            reason: "unauthorized",
            error: formatError(err)
          });
        } catch {
          /* renderer is gone */
        }
      }
      return fail(err);
    }
  }

  ipcMain.handle(IPC.configGet, () => ({
    apiBase: store.state.apiBase ?? api.baseUrl
  }));

  ipcMain.handle(IPC.configSet, async (_e, payload: { apiBase?: string }) => {
    if (payload.apiBase) {
      const trimmed = payload.apiBase.trim();
      api.setBaseUrl(trimmed);
      await store.patch({ apiBase: trimmed });
    }
    return { ok: true };
  });

  ipcMain.handle(IPC.authState, async () => {
    if (!store.state.apiKey) return { authenticated: false };
    try {
      const me = await api.enterpriseMe();
      await store.patch({
        enterpriseId: me.id,
        enterpriseName: me.name,
        enterpriseSlug: me.slug
      });
      return { authenticated: true, enterprise: me };
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        await store.clearAuth();
      }
      return { authenticated: false, error: formatError(err) };
    }
  });

  ipcMain.handle(
    IPC.authConnect,
    async (_e, payload: { apiBase?: string; apiKey: string }) => {
      try {
        if (payload.apiBase) {
          const trimmed = payload.apiBase.trim();
          api.setBaseUrl(trimmed);
          await store.patch({ apiBase: trimmed });
        }
        await store.patch({ apiKey: payload.apiKey.trim() });
        const me = await api.enterpriseMe();
        await store.patch({
          enterpriseId: me.id,
          enterpriseName: me.name,
          enterpriseSlug: me.slug
        });
        return ok({ enterprise: me });
      } catch (err) {
        await store.clearAuth();
        return fail(err);
      }
    }
  );

  ipcMain.handle(IPC.authDisconnect, async () => {
    await store.clearAuth();
    return { ok: true };
  });

  ipcMain.handle(IPC.stats, () =>
    guard(async () => {
      const [me, stats] = await Promise.all([
        api.enterpriseMe(),
        api.enterpriseStats()
      ]);
      return { enterprise: me, stats };
    })
  );

  ipcMain.handle(
    IPC.marketplaceSearch,
    (_e, filt: Parameters<ApiClient["marketplaceSearch"]>[0]) =>
      guard(() => api.marketplaceSearch(filt))
  );

  ipcMain.handle(
    IPC.marketplaceQuote,
    (_e, payload: { cluster_ids: string[]; hours: number }) =>
      guard(() => api.marketplaceQuote(payload))
  );

  ipcMain.handle(IPC.jobsList, (_e, limit?: number) =>
    guard(() => api.listJobs(limit))
  );

  ipcMain.handle(IPC.jobsGet, (_e, id: string) => guard(() => api.getJob(id)));

  ipcMain.handle(IPC.jobsWorkunits, (_e, id: string) =>
    guard(() => api.jobWorkunits(id))
  );

  ipcMain.handle(IPC.jobsSubmit, (_e, payload: Record<string, unknown>) =>
    guard(() => api.submitJob(payload))
  );

  ipcMain.handle(
    IPC.jobsCancel,
    (_e, payload: { id: string; reason?: string }) =>
      guard(() => api.cancelJob(payload.id, payload.reason))
  );

  ipcMain.handle(IPC.jobsFinalize, (_e, id: string) =>
    guard(() => api.finalizeJob(id))
  );

  ipcMain.handle(IPC.apiKeysList, () => guard(() => api.listApiKeys()));

  ipcMain.handle(
    IPC.apiKeysCreate,
    (
      _e,
      payload: { label: string; scopes: string[]; expires_in_days?: number }
    ) => guard(() => api.createApiKey(payload))
  );

  ipcMain.handle(IPC.apiKeysRevoke, (_e, id: string) =>
    guard(async () => {
      await api.revokeApiKey(id);
      return { id };
    })
  );

  ipcMain.handle(
    IPC.apiCall,
    (_e, opts: { method?: string; path: string; body?: unknown }) =>
      guard(() =>
        api.call({
          method:
            (opts.method as "GET" | "POST" | "PATCH" | "DELETE" | "PUT") ??
            "GET",
          path: opts.path,
          body: opts.body
        })
      )
  );
}
