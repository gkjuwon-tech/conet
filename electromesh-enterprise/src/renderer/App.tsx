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
import { Overview } from "./pages/Overview";
import { Marketplace } from "./pages/Marketplace";
import { Jobs } from "./pages/Jobs";
import { JobDetailPage } from "./pages/JobDetail";
import { NewJob } from "./pages/NewJob";
import { ApiKeys } from "./pages/ApiKeys";
import { Settings } from "./pages/Settings";
import { useAuth } from "./state/auth";

export function App() {
  const { authenticated, loading, refresh } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (loading) return;
    if (!authenticated && loc.pathname !== "/login") {
      nav("/login", { replace: true });
    }
  }, [authenticated, loading, loc.pathname, nav]);

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
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="marketplace" element={<Marketplace />} />
        <Route path="jobs" element={<Jobs />} />
        <Route path="jobs/new" element={<NewJob />} />
        <Route path="jobs/:id" element={<JobDetailPage />} />
        <Route path="api-keys" element={<ApiKeys />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
