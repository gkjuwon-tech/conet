import Store from "electron-store";
import { DEFAULT_API_BASE } from "./constants";

export interface ConsumerStoreShape {
  apiBase: string;
  userToken: string | null;
  refreshToken: string | null;
  currentDeviceId: string | null;
  preferences: {
    theme?: "dark" | "light";
    autostart?: boolean;
    notifications?: boolean;
    payoutCurrency?: string;
  };
  deviceTokens: Record<string, string>;
}

const defaults: ConsumerStoreShape = {
  apiBase: DEFAULT_API_BASE,
  userToken: null,
  refreshToken: null,
  currentDeviceId: null,
  preferences: { theme: "dark", autostart: false, notifications: true },
  deviceTokens: {}
};

const store = new Store<ConsumerStoreShape>({
  name: "electromesh-consumer",
  defaults,
  // electron-store handles atomic writes; we want crash-resilient.
  watch: true
});

export const persistence = {
  get apiBase() {
    return store.get("apiBase") || DEFAULT_API_BASE;
  },
  setApiBase(base: string) {
    store.set("apiBase", base);
  },

  get userToken() {
    return store.get("userToken");
  },
  get refreshToken() {
    return store.get("refreshToken");
  },
  setTokens(payload: { access_token?: string | null; refresh_token?: string | null }) {
    if (payload.access_token !== undefined) store.set("userToken", payload.access_token);
    if (payload.refresh_token !== undefined) store.set("refreshToken", payload.refresh_token);
  },
  clearAuth() {
    store.set("userToken", null);
    store.set("refreshToken", null);
    store.set("deviceTokens", {});
    store.set("currentDeviceId", null);
  },

  get currentDeviceId() {
    return store.get("currentDeviceId");
  },
  setCurrentDeviceId(id: string | null) {
    store.set("currentDeviceId", id);
  },

  setDeviceToken(deviceId: string, token: string) {
    const tokens = { ...(store.get("deviceTokens") || {}) };
    tokens[deviceId] = token;
    store.set("deviceTokens", tokens);
  },
  getDeviceToken(deviceId: string): string | undefined {
    return (store.get("deviceTokens") || {})[deviceId];
  },

  get preferences() {
    return store.get("preferences") || {};
  },
  patchPreferences(partial: Partial<ConsumerStoreShape["preferences"]>) {
    const next = { ...(store.get("preferences") || {}), ...partial };
    store.set("preferences", next);
  },

  /** Used by the renderer's `config.get/set` IPC. */
  snapshot() {
    return {
      apiBase: this.apiBase,
      preferences: this.preferences
    };
  }
};
