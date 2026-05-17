import { app, BrowserWindow, ipcMain, IpcMainInvokeEvent } from "electron";
import { IPC } from "./constants";
import { api, HttpError } from "./api-client";
import { persistence } from "./store";

type Result<T> = { ok: true; data?: T } | { ok: false; error: string };

let windowRef: BrowserWindow | null = null;
export function setIpcWindow(win: BrowserWindow) {
  windowRef = win;
}

function send(channel: string, payload: unknown) {
  if (!windowRef || windowRef.isDestroyed()) return;
  try { windowRef.webContents.send(channel, payload); } catch { /* */ }
}

async function handleApiError(err: unknown): Promise<string> {
  if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
    persistence.clearAuth();
    send(IPC.authLoggedOut, { reason: "unauthorized" });
  }
  if (err instanceof HttpError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function guard<TArgs extends unknown[], TOut>(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TOut>
) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const data = await fn(event, ...(args as TArgs));
      return { ok: true, data } as Result<TOut>;
    } catch (err) {
      const message = await handleApiError(err);
      return { ok: false, error: message } as Result<TOut>;
    }
  });
}

export function registerHandlers() {
  // config
  guard(IPC.configGet, async () => persistence.snapshot());
  guard(IPC.configSet, async (_e, partial: Partial<{ apiBase: string; preferences: Record<string, unknown> }>) => {
    if (partial.apiBase) persistence.setApiBase(partial.apiBase);
    if (partial.preferences) persistence.patchPreferences(partial.preferences);
    return persistence.snapshot();
  });

  // auth
  guard(IPC.authState, async () => {
    if (!persistence.apiKey) return { authenticated: false as const };
    try {
      const me = await api.whoami();
      const a = me as {
        name?: string;
        org?: { id?: string };
        wallet?: { balance_cents?: number };
      };
      persistence.setAccount({
        name: a.name ?? null,
        orgId: a.org?.id ?? null,
        walletBalanceCents: a.wallet?.balance_cents ?? 0
      });
      return { authenticated: true as const, account: me };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        persistence.clearAuth();
        return { authenticated: false as const };
      }
      throw err;
    }
  });
  guard(IPC.authConnect, async (_e, payload: { apiKey: string; apiBase?: string }) => {
    if (payload.apiBase) persistence.setApiBase(payload.apiBase);
    persistence.setApiKey(payload.apiKey.trim());
    try {
      const me = await api.whoami();
      const a = me as { name?: string; org?: { id?: string }; wallet?: { balance_cents?: number } };
      persistence.setAccount({
        name: a.name ?? null,
        orgId: a.org?.id ?? null,
        walletBalanceCents: a.wallet?.balance_cents ?? 0
      });
      return { account: me };
    } catch (err) {
      persistence.clearAuth();
      throw err;
    }
  });
  guard(IPC.authDisconnect, async () => {
    persistence.clearAuth();
    return { ok: true };
  });

  // generic passthrough
  guard(IPC.apiCall, async (_e, opts: { method?: string; path: string; body?: unknown }) =>
    api.call({ method: opts.method, path: opts.path, body: opts.body })
  );

  // marketplace
  guard(IPC.marketplaceList, async (_e, filters?: Record<string, unknown>) => api.marketplaceList(filters ?? {}));
  guard(IPC.marketplaceItem, async (_e, id: string) => api.marketplaceItem(id));

  // jobs
  guard(IPC.jobsList, async (_e, filters?: Record<string, unknown>) => api.jobs(filters ?? {}));
  guard(IPC.jobsCreate, async (_e, payload: Record<string, unknown>) => api.createJob(payload));
  guard(IPC.jobsCancel, async (_e, id: string) => api.cancelJob(id));
  guard(IPC.jobsGet, async (_e, id: string) => api.getJob(id));
  guard(IPC.jobsLogs, async (_e, id: string) => api.jobLogs(id));
  guard(IPC.jobsWorkunits, async (_e, id: string) => api.jobWorkunits(id));

  // clusters
  guard(IPC.clustersList, async () => api.clusters());
  guard(IPC.clustersCreate, async (_e, payload: Record<string, unknown>) => api.createCluster(payload));
  guard(IPC.clustersDelete, async (_e, id: string) => api.deleteCluster(id));

  // wallet
  guard(IPC.walletBalance, async () => api.walletBalance());
  guard(IPC.walletDeposit, async (_e, payload: { amount_cents: number; method?: string }) =>
    api.walletDeposit(payload)
  );
  guard(IPC.walletInvoices, async () => api.invoices());

  // api keys
  guard(IPC.apiKeysList, async () => api.apiKeys());
  guard(IPC.apiKeysCreate, async (_e, payload: { label?: string; scopes?: string[]; expires_in_days?: number }) =>
    api.createApiKey(payload)
  );
  guard(IPC.apiKeysRevoke, async (_e, id: string, reason?: string) => api.revokeApiKey(id, reason));

  app.on("before-quit", () => { /* nothing to flush */ });
}
