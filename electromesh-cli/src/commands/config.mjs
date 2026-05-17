import pc from "picocolors";
import { store } from "../lib/store.mjs";
import { api } from "../lib/api.mjs";

export function registerConfig(program) {
  const cmd = program.command("config").description("Local CLI configuration");

  cmd
    .command("show")
    .description("Show current config + auth state")
    .action(async () => {
      const state = await store.get();
      console.log(pc.bold("api base       "), state.apiBase);
      console.log(pc.bold("user           "), state.user?.email ?? pc.dim("(not signed in)"));
      console.log(pc.bold("device id      "), state.currentDeviceId ?? pc.dim("(none)"));
      console.log(pc.bold("device tokens  "), Object.keys(state.deviceTokens || {}).length);
      console.log(pc.bold("enterprise key "), state.enterprise?.apiKey ? `${state.enterprise.apiKey.slice(0, 16)}…` : pc.dim("(none)"));
      console.log(pc.bold("state file     "), store.filePath);
    });

  cmd
    .command("set-api <url>")
    .description("Point CLI at an ElectroMesh backend")
    .action(async (url) => {
      await store.set({ apiBase: url.replace(/\/+$/, "") });
      console.log(pc.green("✓ saved"), url);
    });

  cmd
    .command("ping")
    .description("Ping the configured backend's health endpoint")
    .action(async () => {
      try {
        const out = await api.health();
        console.log(pc.green("✓ ok"), JSON.stringify(out));
      } catch (err) {
        console.error(pc.red(`✗ ${err.message}`));
        process.exit(1);
      }
    });

  cmd
    .command("reset")
    .description("Wipe local CLI state (does NOT touch the backend)")
    .action(async () => {
      await store.set({
        user: null,
        userToken: null,
        refreshToken: null,
        currentDeviceId: null,
        deviceTokens: {},
        enterprise: { apiKey: null, id: null, slug: null }
      });
      console.log(pc.green("✓ local state cleared"));
    });
}
