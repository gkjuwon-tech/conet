import { useEffect } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { useAuth } from "./state/auth";
import { useDevices } from "./state/devices";
import { bridge } from "./api/bridge";
import { LoadingScreen } from "./components/LoadingScreen";
import { Shell } from "./components/Shell";

import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { Onboarding } from "./pages/Onboarding";
import { Dashboard } from "./pages/Dashboard";
import { Devices } from "./pages/Devices";
import { DeviceDetail } from "./pages/DeviceDetail";
import { PairDevice } from "./pages/PairDevice";
import { LanWizard } from "./pages/LanWizard";
import { AndroidPairing } from "./pages/AndroidPairing";
import { Earnings } from "./pages/Earnings";
import { Payouts } from "./pages/Payouts";
import { Settings } from "./pages/Settings";

export default function App() {
  const { ready, authenticated, refresh, logout } = useAuth();
  const refreshDevices = useDevices((s) => s.refresh);
  const nav = useNavigate();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (authenticated) void refreshDevices();
  }, [authenticated, refreshDevices]);

  useEffect(() => {
    const off = bridge.auth.onLoggedOut(() => {
      void logout();
      nav("/login", { replace: true });
    });
    return () => { off; };
  }, [logout, nav]);

  useEffect(() => {
    const off = bridge.navigation.onGoto((route) => nav(route));
    return () => { off; };
  }, [nav]);

  if (!ready) return <LoadingScreen label="Connecting to backend" />;

  return (
    <Routes>
      {!authenticated && (
        <>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </>
      )}
      {authenticated && (
        <>
          <Route path="/onboarding" element={<Onboarding />} />
          <Route element={<Shell />}>
            <Route index element={<Dashboard />} />
            <Route path="devices" element={<Devices />} />
            <Route path="devices/new" element={<PairDevice />} />
            <Route path="devices/lan" element={<LanWizard />} />
            <Route path="devices/android" element={<AndroidPairing />} />
            <Route path="devices/:id" element={<DeviceDetail />} />
            <Route path="earnings" element={<Earnings />} />
            <Route path="payouts" element={<Payouts />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </>
      )}
    </Routes>
  );
}
