import Store from "electron-store";
import { DEFAULT_API_BASE } from "./constants";

export interface EnterpriseStoreShape {
  apiBase: string;
  apiKey: string | null;
  account: {
    name: string | null;
    orgId: string | null;
    walletBalanceCents: number;
  } | null;
  preferences: {
    theme?: "dark" | "light" | "ivory";
    notifications?: boolean;
    defaultRegion?: string;
  };
}

const defaults: EnterpriseStoreShape = {
  apiBase: DEFAULT_API_BASE,
  apiKey: null,
  account: null,
  preferences: { theme: "dark", notifications: true, defaultRegion: "asia-northeast" }
};

const store = new Store<EnterpriseStoreShape>({
  name: "electromesh-enterprise",
  defaults,
  watch: true
});

export const persistence = {
  get apiBase() { return store.get("apiBase") || DEFAULT_API_BASE; },
  setApiBase(base: string) { store.set("apiBase", base); },

  get apiKey() { return store.get("apiKey"); },
  setApiKey(key: string | null) { store.set("apiKey", key); },

  get account() { return store.get("account"); },
  setAccount(a: EnterpriseStoreShape["account"]) { store.set("account", a); },

  get preferences() { return store.get("preferences") || {}; },
  patchPreferences(partial: Partial<EnterpriseStoreShape["preferences"]>) {
    const next = { ...(store.get("preferences") || {}), ...partial };
    store.set("preferences", next);
  },

  clearAuth() {
    store.set("apiKey", null);
    store.set("account", null);
  },

  snapshot() {
    return {
      apiBase: this.apiBase,
      preferences: this.preferences
    };
  }
};
