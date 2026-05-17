import { create } from "zustand";
import { bridge } from "../api/bridge";

interface AuthState {
  loading: boolean;
  authenticated: boolean;
  user: { id: string; email: string; display_name?: string } | null;
  error: string | null;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<boolean>;
  register: (payload: {
    email: string;
    password: string;
    display_name?: string;
    country_code?: string;
  }) => Promise<boolean>;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  loading: true,
  authenticated: false,
  user: null,
  error: null,
  refresh: async () => {
    set({ loading: true });
    const res = await bridge.auth.state();
    if (res.authenticated) {
      set({ authenticated: true, user: res.user, loading: false, error: null });
    } else {
      set({
        authenticated: false,
        user: null,
        loading: false,
        error: res.error ?? null
      });
    }
  },
  login: async (email, password) => {
    set({ loading: true, error: null });
    const res = await bridge.auth.login({ email, password });
    if (res.ok) {
      set({ authenticated: true, user: res.user, loading: false });
      return true;
    }
    set({ loading: false, error: res.error ?? "login failed" });
    return false;
  },
  register: async (payload) => {
    set({ loading: true, error: null });
    const res = await bridge.auth.register({
      ...payload,
      accepted_tos_version: "v1"
    });
    if (res.ok) {
      set({ authenticated: true, user: res.user, loading: false });
      return true;
    }
    set({ loading: false, error: res.error ?? "register failed" });
    return false;
  },
  logout: async () => {
    await bridge.auth.logout();
    set({ authenticated: false, user: null });
  }
}));
