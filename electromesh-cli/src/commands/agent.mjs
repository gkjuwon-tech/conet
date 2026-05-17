import pc from "picocolors";
import { Agent } from "../lib/agent.mjs";
import { store } from "../lib/store.mjs";

export function registerAgent(program) {
  const cmd = program.command("agent").description("Run / inspect the worker agent");

  cmd
    .command("run")
    .description("Start the agent for the active device — Ctrl-C to stop")
    .option("--device <id>", "override active device id")
    .action(async (opts) => {
      const state = await store.get();
      const deviceId = opts.device || state.currentDeviceId;
      if (!deviceId) throw new Error("no active device — `em device pair` first");
      const token = state.deviceTokens?.[deviceId];
      if (!token) throw new Error(`no device token for ${deviceId} — re-pair`);

      console.log(pc.bold(`▸ Agent for ${deviceId}`));
      const agent = new Agent({
        deviceId,
        deviceToken: token,
        onLog: (line) => console.log(line)
      });

      const stop = async () => {
        console.log(pc.yellow("\n• stopping…"));
        agent.stop();
        console.log(
          pc.dim(
            `  completed=${agent.stats.completed} failed=${agent.stats.failed} avg=${
              agent.stats.completed
                ? Math.round(agent.stats.totalRuntimeMs / agent.stats.completed)
                : 0
            }ms`
          )
        );
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);

      try {
        await agent.start();
      } catch (err) {
        console.error(pc.red(`✗ ${err.message}`));
        agent.stop();
        process.exit(1);
      }
      // keep alive
      await new Promise(() => undefined);
    });

  cmd
    .command("once")
    .description("Run a single claim/process cycle and exit (useful for tests)")
    .action(async () => {
      const state = await store.get();
      const deviceId = state.currentDeviceId;
      const token = state.deviceTokens?.[deviceId];
      if (!deviceId || !token) throw new Error("no active device — pair first");

      const agent = new Agent({
        deviceId,
        deviceToken: token,
        onLog: (l) => console.log(l)
      });
      await agent.start();
      // Wait for the first tick to actually finish a network round-trip with
      // the dispatcher — without this the loop below sees active.size==0
      // before the claim-work POST has even started, so `once` exits before
      // doing any real work. We give the first claim up to 5s, then if any
      // workunit was picked up we wait up to 60s for it to drain.
      try {
        await agent.tick();
      } catch (e) {
        agent.onLog(pc.yellow(`! tick: ${e.message}`));
      }
      const drainStart = Date.now();
      while (agent.active.size > 0 && Date.now() - drainStart < 60_000) {
        await new Promise((r) => setTimeout(r, 250));
      }
      agent.stop();
      console.log(pc.green(`✓ cycle complete · completed=${agent.stats.completed} failed=${agent.stats.failed}`));
    });
}
