import { create } from "zustand";
import { bridge } from "../api/bridge";

export interface AuthUser {
  id?: string;
  email?: string;
  display_name?: string;
  country_code?: string;
  wallet_balance_cents?: number;
  total_earnings_cents?: number;
  device_count?: number;
  active_device_count?: number;
  [k: string]: unknown;
}

interface AuthState {
  ready: boolean;
  authenticated: boolean;
  loading: boolean;
  user: AuthUser | null;
  error: string | null;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (payload: {
    email: string;
    password: string;
    display_name?: string;
    country_code?: string;
  }) => Promise<void>;
  oauth: (provider: "google" | "apple") => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  ready: false,
  authenticated: false,
  loading: false,
  user: null,
  error: null,
  async refresh() {
    set({ loading: true });
    try {
      const state = await bridge.auth.state();
      if (state.authenticated) {
        set({
          authenticated: true,
          user: (state.user as AuthUser) ?? null,
          loading: false,
          ready: true,
          error: null
        });
      } else {
        set({
          authenticated: false,
          user: null,
          loading: false,
          ready: true,
          error: state.error ?? null
        });
      }
    } catch (err) {
      set({
        authenticated: false,
        user: null,
        loading: false,
        ready: true,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  },
  async login(email, password) {
    set({ loading: true, error: null });
    try {
      const res = await bridge.auth.login(email, password);
      set({
        authenticated: true,
        user: (res.user as AuthUser) ?? null,
        loading: false,
        ready: true,
        error: null
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },
  async register(payload) {
    set({ loading: true, error: null });
    try {
      const res = await bridge.auth.register(payload);
      set({
        authenticated: true,
        user: (res.user as AuthUser) ?? null,
        loading: false,
        ready: true,
        error: null
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },
  async oauth(provider) {
    set({ loading: true, error: null });
    try {
      const res = await bridge.auth.oauth(provider);
      set({
        authenticated: true,
        user: (res.user as AuthUser) ?? null,
        loading: false,
        ready: true,
        error: null
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },
  async logout() {
    await bridge.auth.logout().catch(() => null);
    set({ authenticated: false, user: null, error: null });
  },
  clearError() {
    set({ error: null });
  }
}));
