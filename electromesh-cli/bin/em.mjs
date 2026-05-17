#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { registerAuth } from "../src/commands/auth.mjs";
import { registerDevice } from "../src/commands/device.mjs";
import { registerAgent } from "../src/commands/agent.mjs";
import { registerEnterprise } from "../src/commands/enterprise.mjs";
import { registerJob } from "../src/commands/job.mjs";
import { registerAdmin } from "../src/commands/admin.mjs";
import { registerDemo } from "../src/commands/demo.mjs";
import { registerConfig } from "../src/commands/config.mjs";
import { registerLan } from "../src/commands/lan.mjs";
import { registerScenarios } from "../src/commands/scenarios.mjs";
import { registerClaim } from "../src/commands/claim.mjs";
import { registerFleet } from "../src/commands/fleet.mjs";
import { registerGateway } from "../src/commands/gateway.mjs";

const program = new Command();
program
  .name("em")
  .description("ElectroMesh CLI — pair, earn, dispatch.")
  .version("0.1.0")
  .option("-v, --verbose", "verbose output")
  .hook("preAction", (thisCommand) => {
    process.env.EM_VERBOSE = thisCommand.opts().verbose ? "1" : "";
  });

registerConfig(program);
registerAuth(program);
registerDevice(program);
registerAgent(program);
registerEnterprise(program);
registerJob(program);
registerAdmin(program);
registerLan(program);
registerDemo(program);
registerScenarios(program);
registerClaim(program);
registerFleet(program);
registerGateway(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(pc.red(`✗ ${err?.message || err}`));
  if (process.env.EM_VERBOSE && err?.stack) console.error(err.stack);
  process.exit(1);
});
