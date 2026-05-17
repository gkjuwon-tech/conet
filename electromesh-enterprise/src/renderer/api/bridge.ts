type Result<T> = { ok: true; data?: T } | { ok: false; error: string };

function unwrap<T>(res: Result<unknown>): T {
  if (!res.ok) throw new Error(res.error);
  return (res.data ?? undefined) as T;
}

function w() {
  if (typeof window === "undefined" || !window.electromesh) {
    throw new Error("Electron bridge unavailable.");
  }
  return window.electromesh;
}

export const bridge = {
  config: {
    async get() {
      return unwrap<{ apiBase: string; preferences: Record<string, unknown> }>(await w().config.get());
    },
    async set(partial: Record<string, unknown>) {
      return unwrap<{ apiBase: string; preferences: Record<string, unknown> }>(await w().config.set(partial));
    }
  },
  auth: {
    async state(): Promise<{ authenticated: boolean; account?: unknown; error?: string }> {
      const res = await w().auth.state();
      if (!res.ok) return { authenticated: false, error: res.error };
      return (res.data ?? { authenticated: false }) as { authenticated: boolean; account?: unknown };
    },
    async connect(payload: { apiKey: string; apiBase?: string }) {
      return unwrap<{ account: unknown }>(await w().auth.connect(payload));
    },
    async disconnect() {
      return unwrap<{ ok: boolean }>(await w().auth.disconnect());
    },
    onLoggedOut(cb: (p: unknown) => void) {
      return w().auth.onLoggedOut(cb);
    }
  },
  api: {
    async call<T>(opts: { method?: string; path: string; body?: unknown }) {
      return unwrap<T>(await w().api.call<T>(opts));
    }
  },
  marketplace: {
    async list(filters?: Record<string, unknown>) {
      return unwrap<unknown>(await w().marketplace.list(filters));
    },
    async item(id: string) {
      return unwrap<unknown>(await w().marketplace.item(id));
    }
  },
  jobs: {
    async list(filters?: Record<string, unknown>) {
      return unwrap<unknown>(await w().jobs.list(filters));
    },
    async create(payload: Record<string, unknown>) {
      return unwrap<unknown>(await w().jobs.create(payload));
    },
    async cancel(id: string) {
      return unwrap<unknown>(await w().jobs.cancel(id));
    },
    async get(id: string) {
      return unwrap<unknown>(await w().jobs.get(id));
    },
    async logs(id: string) {
      return unwrap<unknown>(await w().jobs.logs(id));
    },
    async workunits(id: string) {
      return unwrap<unknown>(await w().jobs.workunits(id));
    }
  },
  clusters: {
    async list() {
      return unwrap<unknown>(await w().clusters.list());
    },
    async create(payload: Record<string, unknown>) {
      return unwrap<unknown>(await w().clusters.create(payload));
    },
    async delete(id: string) {
      return unwrap<unknown>(await w().clusters.delete(id));
    }
  },
  wallet: {
    async balance() {
      return unwrap<unknown>(await w().wallet.balance());
    },
    async deposit(payload: { amount_cents: number; method?: string }) {
      return unwrap<unknown>(await w().wallet.deposit(payload));
    },
    async invoices() {
      return unwrap<unknown>(await w().wallet.invoices());
    }
  },
  apiKeys: {
    async list() {
      return unwrap<unknown>(await w().apiKeys.list());
    },
    async create(payload: { label?: string; scopes?: string[] }) {
      return unwrap<{ id: string; api_key: string; label?: string }>(await w().apiKeys.create(payload));
    },
    async revoke(id: string) {
      return unwrap<unknown>(await w().apiKeys.revoke(id));
    }
  }
};
