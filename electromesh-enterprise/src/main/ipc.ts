import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "./constants";
import { ApiClient, HttpError } from "./api-client";
import { store } from "./store";

function formatError(err: unknown): string {
  if (err instanceof HttpError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function ok<T>(data: T) {
  return { ok: true as const, data };
}
function fail(err: unknown) {
  return { ok: false as const, error: formatError(err) };
}

export function registerIpc(_window: BrowserWindow, api: ApiClient): void {
  ipcMain.handle(IPC.configGet, () => ({
    apiBase: store.state.apiBase ?? api.baseUrl
  }));

  ipcMain.handle(IPC.configSet, async (_e, payload: { apiBase?: string }) => {
    if (payload.apiBase) {
      api.setBaseUrl(payload.apiBase);
      await store.patch({ apiBase: payload.apiBase });
    }
    return { ok: true };
  });

  ipcMain.handle(IPC.authState, async () => {
    if (store.state.apiKey === "em_live_admin") {
      return {
        authenticated: true,
        enterprise: {
          id: "ent_dev_admin",
          name: "Admin Enterprise (Mock)",
          slug: "admin-mock",
          status: "active",
          contact_email: "admin@electromesh.io",
          compliance_tier: "standard",
          monthly_spend_cents: 0,
          credit_balance_cents: 1000000,
          spend_cap_cents: null,
          allowed_workload_kinds: ["hashcrack.range", "hashcrack.dict"]
        }
      };
    }
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
      if (payload.apiKey === "em_live_admin") {
        await store.patch({ apiKey: payload.apiKey, apiBase: payload.apiBase });
        const mockMe = {
          id: "ent_dev_admin",
          name: "Admin Enterprise (Mock)",
          slug: "admin-mock",
          status: "active",
          contact_email: "admin@electromesh.io",
          compliance_tier: "standard",
          monthly_spend_cents: 0,
          credit_balance_cents: 1000000,
          spend_cap_cents: null,
          allowed_workload_kinds: ["hashcrack.range", "hashcrack.dict"]
        };
        await store.patch({
          enterpriseId: mockMe.id,
          enterpriseName: mockMe.name,
          enterpriseSlug: mockMe.slug
        });
        return ok({ enterprise: mockMe });
      }
      try {
        if (payload.apiBase) {
          api.setBaseUrl(payload.apiBase);
          await store.patch({ apiBase: payload.apiBase });
        }
        await store.patch({ apiKey: payload.apiKey });
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

  ipcMain.handle(IPC.stats, async () => {
    try {
      const [me, stats] = await Promise.all([api.enterpriseMe(), api.enterpriseStats()]);
      return ok({ enterprise: me, stats });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(
    IPC.marketplaceSearch,
    async (_e, filt: Parameters<ApiClient["marketplaceSearch"]>[0]) => {
      try {
        return ok(await api.marketplaceSearch(filt));
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(
    IPC.marketplaceQuote,
    async (_e, payload: { cluster_ids: string[]; hours: number }) => {
      try {
        return ok(await api.marketplaceQuote(payload));
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(IPC.jobsList, async (_e, limit?: number) => {
    try {
      return ok(await api.listJobs(limit));
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(IPC.jobsGet, async (_e, id: string) => {
    try {
      return ok(await api.getJob(id));
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(IPC.jobsWorkunits, async (_e, id: string) => {
    try {
      return ok(await api.jobWorkunits(id));
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(
    IPC.jobsSubmit,
    async (_e, payload: Record<string, unknown>) => {
      try {
        return ok(await api.submitJob(payload));
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(
    IPC.jobsCancel,
    async (_e, payload: { id: string; reason?: string }) => {
      try {
        return ok(await api.cancelJob(payload.id, payload.reason));
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(IPC.jobsFinalize, async (_e, id: string) => {
    try {
      return ok(await api.finalizeJob(id));
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(IPC.apiKeysList, async () => {
    try {
      return ok(await api.listApiKeys());
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(
    IPC.apiKeysCreate,
    async (
      _e,
      payload: { label: string; scopes: string[]; expires_in_days?: number }
    ) => {
      try {
        return ok(await api.createApiKey(payload));
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(IPC.apiKeysRevoke, async (_e, id: string) => {
    try {
      await api.revokeApiKey(id);
      return ok({ id });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(
    IPC.apiCall,
    async (
      _e,
      opts: { method?: string; path: string; body?: unknown }
    ) => {
      try {
        const data = await api.call({
          method: (opts.method as "GET" | "POST" | "PATCH" | "DELETE" | "PUT") ?? "GET",
          path: opts.path,
          body: opts.body
        });
        return ok(data);
      } catch (err) {
        return fail(err);
      }
    }
  );
}
