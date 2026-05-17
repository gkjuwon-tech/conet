import { create } from "zustand";
import { bridge, type Enterprise } from "../api/bridge";

interface AuthState {
  loading: boolean;
  authenticated: boolean;
  enterprise: Enterprise | null;
  error: string | null;
  refresh: () => Promise<void>;
  connect: (apiBase: string, apiKey: string) => Promise<boolean>;
  disconnect: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  loading: true,
  authenticated: false,
  enterprise: null,
  error: null,
  refresh: async () => {
    set({ loading: true });
    const res = await bridge.auth.state();
    if (res.authenticated) {
      set({
        loading: false,
        authenticated: true,
        enterprise: res.enterprise as Enterprise,
        error: null
      });
    } else {
      set({
        loading: false,
        authenticated: false,
        enterprise: null,
        error: res.error ?? null
      });
    }
  },
  connect: async (apiBase, apiKey) => {
    set({ loading: true, error: null });
    const res = await bridge.auth.connect({ apiBase, apiKey });
    if (res.ok) {
      set({
        loading: false,
        authenticated: true,
        enterprise: (res.data as { enterprise: Enterprise }).enterprise,
        error: null
      });
      return true;
    }
    set({ loading: false, error: res.error ?? "connection failed" });
    return false;
  },
  disconnect: async () => {
    await bridge.auth.disconnect();
    set({ authenticated: false, enterprise: null });
  }
}));
