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
import { Earnings } from "./pages/Earnings";
import { Payouts } from "./pages/Payouts";
import { Settings } from "./pages/Settings";
import { Onboarding } from "./pages/Onboarding";
import { useAuth } from "./state/auth";
import { attachAgentEvents, useAgent } from "./state/agent";

export function App() {
  const { authenticated, loading, refresh } = useAuth();
  const { refreshAll } = useAgent();
  const location = useLocation();
  const nav = useNavigate();

  useEffect(() => {
    void refresh();
    const detach = attachAgentEvents();
    return detach;
  }, [refresh]);

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
        <Route path="devices/:id" element={<DeviceDetail />} />
        <Route path="earnings" element={<Earnings />} />
        <Route path="payouts" element={<Payouts />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
