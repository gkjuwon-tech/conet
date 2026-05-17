/**
 * Thin renderer-side wrapper around `window.electromesh`. Centralizes the
 * "throw on `!ok`" pattern so call sites can `await bridge.devices.list()`
 * and get the data directly, with React-friendly error propagation.
 */

type Result<T> = { ok: true; data?: T } | { ok: false; error: string };

function unwrap<T>(result: Result<unknown>): T {
  if (!result.ok) throw new Error(result.error);
  return (result.data ?? undefined) as T;
}

function w() {
  if (typeof window === "undefined" || !window.electromesh) {
    throw new Error("Electron bridge is unavailable.");
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
    async state(): Promise<{ authenticated: boolean; user?: unknown; error?: string }> {
      const res = await w().auth.state();
      if (!res.ok) return { authenticated: false, error: res.error };
      return (res.data ?? { authenticated: false }) as { authenticated: boolean; user?: unknown };
    },
    async login(email: string, password: string) {
      return unwrap<{ user: unknown }>(await w().auth.login(email, password));
    },
    async register(payload: {
      email: string;
      password: string;
      display_name?: string;
      country_code?: string;
    }) {
      return unwrap<{ user: unknown }>(await w().auth.register(payload));
    },
    async logout() {
      return unwrap<{ ok: boolean }>(await w().auth.logout());
    },
    async oauth(provider: "google" | "apple") {
      return unwrap<{ user: unknown }>(await w().auth.oauth(provider));
    },
    onLoggedOut(cb: (payload: unknown) => void) {
      return w().auth.onLoggedOut(cb);
    }
  },
  api: {
    async call<T>(opts: { method?: string; path: string; body?: unknown }) {
      return unwrap<T>(await w().api.call(opts));
    }
  },
  devices: {
    async list() {
      return unwrap<unknown>(await w().devices.list());
    },
    async register(payload: {
      label?: string;
      device_class: string;
      capabilities?: Record<string, unknown>;
      consents?: Record<string, unknown>;
    }) {
      return unwrap<{ id: string; [k: string]: unknown }>(await w().devices.register(payload));
    },
    async decommission(id: string) {
      return unwrap<unknown>(await w().devices.decommission(id));
    },
    async benchmark(id: string) {
      return unwrap<{ hashrate_mhs: number; ram_mb: number; power_w: number }>(await w().devices.benchmark(id));
    },
    async current() {
      return unwrap<string | null>(await w().devices.current());
    },
    async setCurrent(id: string | null) {
      return unwrap<string | null>(await w().devices.setCurrent(id));
    },
    onBenchmarkProgress(cb: (p: unknown) => void) {
      return w().devices.onBenchmarkProgress(cb);
    }
  },
  agent: {
    async status() {
      return unwrap<{
        running: boolean;
        deviceId: string | null;
        lastTickAt: number | null;
        lastHeartbeatAt: number | null;
        lastWorkAt: number | null;
        lastError: string | null;
        workunitsCompleted: number;
        workunitsActive: number;
      }>(await w().agent.status());
    },
    async start(deviceId?: string) {
      return unwrap<unknown>(await w().agent.start(deviceId));
    },
    async stop() {
      return unwrap<unknown>(await w().agent.stop());
    },
    onEvent(cb: (payload: unknown) => void) {
      return w().agent.onEvent(cb);
    }
  },
  system: {
    async info() {
      return unwrap<{
        hostname: string;
        os: string;
        cpuModel: string;
        cpuPhysical: number;
        cpuLogical: number;
        ramTotalMb: number;
        ramAvailableMb: number;
        cpuPct: number;
        ramPct: number;
        tempC: number | null;
        battery: { hasBattery: boolean; percent: number | null; charging: boolean };
      }>(await w().system.info());
    }
  },
  dashboard: {
    async fetch() {
      return unwrap<unknown>(await w().dashboard.fetch());
    },
    async earnings() {
      return unwrap<unknown>(await w().dashboard.earnings());
    },
    async payoutRequest() {
      return unwrap<unknown>(await w().dashboard.payoutRequest());
    }
  },
  lan: {
    async scan() {
      return unwrap<{ count: number; items: unknown[]; lan_fingerprint?: string }>(await w().lan.scan());
    },
    async claimRequest(payload: {
      lan_fingerprint: string;
      label?: string;
      gateway_mac?: string;
      advertised_subnet?: string;
    }) {
      return unwrap<unknown>(await w().lan.claimRequest(payload));
    },
    async claimVerify(payload: { lan_fingerprint: string; otp: string }) {
      return unwrap<unknown>(await w().lan.claimVerify(payload));
    },
    async claimList() {
      return unwrap<unknown>(await w().lan.claimList());
    },
    async pairAll(payload: {
      devices: unknown[];
      lanFingerprint: string;
      skipRandomized?: boolean;
      skipRouter?: boolean;
    }) {
      return unwrap<unknown>(await w().lan.pairAll(payload));
    },
    onScanProgress(cb: (p: unknown) => void) {
      return w().lan.onScanProgress(cb);
    },
    onPairProgress(cb: (p: unknown) => void) {
      return w().lan.onPairProgress(cb);
    }
  },
  android: {
    async status() {
      return unwrap<unknown>(await w().android.status());
    },
    async discover(opts?: { window_seconds?: number }) {
      return unwrap<unknown>(await w().android.discover(opts));
    },
    async results() {
      return unwrap<unknown>(await w().android.results());
    },
    async enroll(payload: Record<string, unknown>) {
      return unwrap<unknown>(await w().android.enroll(payload));
    },
    async enrollMany(payload: Record<string, unknown>) {
      return unwrap<unknown>(await w().android.enrollMany(payload));
    },
    async addFriend(payload: Record<string, unknown>) {
      return unwrap<unknown>(await w().android.addFriend(payload));
    },
    async vetoIp(ip: string) {
      return unwrap<unknown>(await w().android.vetoIp(ip));
    }
  },
  navigation: {
    onGoto(cb: (route: string) => void) {
      return w().navigation.onGoto(cb);
    }
  }
};
