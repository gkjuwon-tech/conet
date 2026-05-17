import { useEffect } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { useAuth } from "./state/auth";
import { bridge } from "./api/bridge";
import { LoadingScreen } from "./components/LoadingScreen";
import { Shell } from "./components/Shell";

import { Login } from "./pages/Login";
import { Overview } from "./pages/Overview";
import { Marketplace } from "./pages/Marketplace";
import { NewJob } from "./pages/NewJob";
import { Jobs } from "./pages/Jobs";
import { JobDetail } from "./pages/JobDetail";
import { ApiKeys } from "./pages/ApiKeys";
import { Wallet } from "./pages/Wallet";
import { Settings } from "./pages/Settings";

export default function App() {
  const { ready, authenticated, refresh, disconnect } = useAuth();
  const nav = useNavigate();

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const off = bridge.auth.onLoggedOut(() => {
      void disconnect();
      nav("/login", { replace: true });
    });
    return () => { off; };
  }, [disconnect, nav]);

  if (!ready) return <LoadingScreen label="Connecting to backend" />;

  return (
    <Routes>
      {!authenticated && (
        <>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </>
      )}
      {authenticated && (
        <>
          <Route element={<Shell />}>
            <Route index element={<Overview />} />
            <Route path="marketplace" element={<Marketplace />} />
            <Route path="jobs" element={<Jobs />} />
            <Route path="jobs/new" element={<NewJob />} />
            <Route path="jobs/:id" element={<JobDetail />} />
            <Route path="api-keys" element={<ApiKeys />} />
            <Route path="wallet" element={<Wallet />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </>
      )}
    </Routes>
  );
}
