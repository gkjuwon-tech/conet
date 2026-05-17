import pc from "picocolors";
import { api } from "../lib/api.mjs";
import { store } from "../lib/store.mjs";

export function registerAdmin(program) {
  const cmd = program.command("admin").description("Admin-scoped helpers (requires admin.* on key)");

  cmd
    .command("bundle")
    .description("Trigger the FCFS bundler manually (forms a cluster from idle devices)")
    .action(async () => {
      const state = await store.get();
      const key = state.enterprise?.apiKey;
      if (!key) throw new Error("connect an admin-scoped key first: `em ent connect <key>`");
      const out = await api.runBundler(key);
      console.log(pc.green("✓"), JSON.stringify(out));
    });

  cmd
    .command("stats")
    .description("Show platform-wide stats")
    .action(async () => {
      const state = await store.get();
      const out = await api.adminStats(state.enterprise.apiKey);
      console.log(JSON.stringify(out, null, 2));
    });

  cmd
    .command("settle <jobId>")
    .description("Force-settle a job (credits user wallets)")
    .action(async (jobId) => {
      const state = await store.get();
      const out = await api.finalizeJob(state.enterprise.apiKey, jobId);
      console.log(JSON.stringify(out, null, 2));
    });
}
