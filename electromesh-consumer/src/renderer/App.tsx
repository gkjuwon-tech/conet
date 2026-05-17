import { useEffect } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate
} from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { Dashboard } from "./pages/Dashboard";
import { Devices } from "./pages/Devices";
import { DeviceDetail } from "./pages/DeviceDetail";
import { PairDevice } from "./pages/PairDevice";
import { Claim } from "./pages/Claim";
import { LanWizard } from "./pages/LanWizard";
import { AndroidPairing } from "./pages/AndroidPairing";
import { Earnings } from "./pages/Earnings";
import { Payouts } from "./pages/Payouts";
import { Settings } from "./pages/Settings";
import { Onboarding } from "./pages/Onboarding";
import { useAuth } from "./state/auth";
import { attachAgentEvents, useAgent } from "./state/agent";
import { bridge } from "./api/bridge";

export function App() {
  const { authenticated, loading, refresh, logout } = useAuth();
  const { refreshAll } = useAgent();
  const location = useLocation();
  const nav = useNavigate();

  useEffect(() => {
    void refresh();
    const detach = attachAgentEvents();
    return detach;
  }, [refresh]);

  // When the main process detects a 401 on any backend call it broadcasts
  // `auth:logged-out`. The renderer flushes local auth + agent state and
  // bounces the user back to /login so they can sign in again.
  useEffect(() => {
    if (!bridge?.auth?.onLoggedOut) return;
    return bridge.auth.onLoggedOut(() => {
      void logout();
      nav("/login", { replace: true });
    });
  }, [logout, nav]);

  useEffect(() => {
    if (!loading && authenticated) {
      void refreshAll();
    }
  }, [loading, authenticated, refreshAll]);

  useEffect(() => {
    if (loading) return;
    if (!authenticated && !["/login", "/register"].includes(location.pathname)) {
      nav("/login", { replace: true });
    }
  }, [authenticated, loading, location.pathname, nav]);

  if (loading) {
    return (
      <div className="min-h-full grid place-items-center">
        <Loader2 className="w-8 h-8 animate-spin text-ink-secondary" />
      </div>
    );
  }

  if (!authenticated) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/onboarding" element={<Onboarding />} />
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="devices" element={<Devices />} />
        <Route path="devices/new" element={<PairDevice />} />
        <Route path="devices/claim" element={<Claim />} />
        <Route path="devices/lan-wizard" element={<LanWizard />} />
        <Route path="devices/android" element={<AndroidPairing />} />
        <Route path="devices/:id" element={<DeviceDetail />} />
        <Route path="earnings" element={<Earnings />} />
        <Route path="payouts" element={<Payouts />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
