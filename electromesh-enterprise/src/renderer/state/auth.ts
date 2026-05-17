import { create } from "zustand";
import { bridge } from "../api/bridge";

export interface EnterpriseAccount {
  id?: string;
  name?: string;
  email?: string;
  org?: { id?: string; name?: string };
  wallet?: { balance_cents?: number; pending_cents?: number };
  [k: string]: unknown;
}

interface AuthState {
  ready: boolean;
  authenticated: boolean;
  loading: boolean;
  account: EnterpriseAccount | null;
  error: string | null;
  refresh: () => Promise<void>;
  connect: (apiKey: string, apiBase?: string) => Promise<void>;
  disconnect: () => Promise<void>;
  clearError: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  ready: false,
  authenticated: false,
  loading: false,
  account: null,
  error: null,
  async refresh() {
    set({ loading: true });
    try {
      const state = await bridge.auth.state();
      if (state.authenticated) {
        set({
          authenticated: true,
          account: (state.account as EnterpriseAccount) ?? null,
          loading: false,
          ready: true,
          error: null
        });
      } else {
        set({
          authenticated: false,
          account: null,
          loading: false,
          ready: true,
          error: state.error ?? null
        });
      }
    } catch (err) {
      set({
        authenticated: false,
        account: null,
        loading: false,
        ready: true,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  },
  async connect(apiKey, apiBase) {
    set({ loading: true, error: null });
    try {
      const res = await bridge.auth.connect({ apiKey, apiBase });
      set({
        authenticated: true,
        account: (res.account as EnterpriseAccount) ?? null,
        loading: false,
        ready: true,
        error: null
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },
  async disconnect() {
    await bridge.auth.disconnect().catch(() => null);
    set({ authenticated: false, account: null, error: null });
  },
  clearError() {
    set({ error: null });
  }
}));
