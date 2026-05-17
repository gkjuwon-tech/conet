import pc from "picocolors";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { api } from "../lib/api.mjs";
import { store } from "../lib/store.mjs";

export function registerAuth(program) {
  program
    .command("register")
    .description("Create a new user account")
    .option("-e, --email <email>", "email")
    .option("-p, --password <password>", "password (>= 10 chars)")
    .option("-n, --name <name>", "display name")
    .option("--country <iso2>", "country code (ISO-2)")
    .action(async (opts) => {
      const email = opts.email || (await prompt("Email: "));
      const password = opts.password || (await prompt("Password: ", true));
      const display = opts.name || email.split("@")[0];

      const user = await api.register({
        email,
        password,
        display_name: display,
        country_code: opts.country,
        accepted_tos_version: "v1"
      });
      const tokens = await api.login(email, password);
      await store.set({
        user: { id: user.id, email, display_name: display },
        userToken: tokens.access_token,
        refreshToken: tokens.refresh_token
      });
      console.log(pc.green("✓ registered"), pc.dim(user.id), pc.dim(email));
    });

  program
    .command("login")
    .description("Sign in as an existing user")
    .option("-e, --email <email>", "email")
    .option("-p, --password <password>", "password")
    .action(async (opts) => {
      const email = opts.email || (await prompt("Email: "));
      const password = opts.password || (await prompt("Password: ", true));
      const tokens = await api.login(email, password);
      const me = await api.me(tokens.access_token);
      await store.set({
        user: me,
        userToken: tokens.access_token,
        refreshToken: tokens.refresh_token
      });
      console.log(pc.green("✓ signed in"), pc.dim(me.email));
    });

  program
    .command("whoami")
    .description("Show the signed-in user")
    .action(async () => {
      const state = await store.get();
      if (!state.userToken) {
        console.log(pc.dim("(not signed in)"));
        return;
      }
      try {
        const me = await api.me(state.userToken);
        console.log(JSON.stringify(me, null, 2));
      } catch (err) {
        if (err.status === 401) {
          await store.clearAuth();
          console.log(pc.yellow("session expired — run `em login`"));
          return;
        }
        throw err;
      }
    });

  program
    .command("logout")
    .description("Forget local credentials (does not revoke server-side tokens)")
    .action(async () => {
      await store.clearAuth();
      console.log(pc.green("✓ logged out"));
    });

  program
    .command("dashboard")
    .description("Show wallet + earnings summary")
    .action(async () => {
      const state = await store.get();
      const dash = await api.dashboard(state.userToken);
      console.log(JSON.stringify(dash, null, 2));
    });
}

async function prompt(label, hide = false) {
  const rl = readline.createInterface({ input, output });
  if (!hide) {
    const ans = await rl.question(label);
    rl.close();
    return ans;
  }
  // Crude password prompt (echo-on); avoids terminal raw mode quirks on Windows.
  const ans = await rl.question(label);
  rl.close();
  return ans;
}
