import pc from "picocolors";
import { api } from "../lib/api.mjs";
import { store } from "../lib/store.mjs";

export function registerEnterprise(program) {
  const cmd = program.command("ent").description("Enterprise (tenant) operations");

  cmd
    .command("connect <apiKey>")
    .description("Save an enterprise API key locally")
    .action(async (apiKey) => {
      await store.patchEnterprise({ apiKey });
      const me = await api.enterpriseMe(apiKey);
      await store.patchEnterprise({ id: me.id, slug: me.slug });
      console.log(pc.green("✓ connected"), pc.dim(me.slug), pc.dim(me.id));
    });

  cmd
    .command("me")
    .description("Show the connected tenant")
    .action(async () => {
      const state = await store.get();
      if (!state.enterprise?.apiKey) throw new Error("no key — `em ent connect <key>`");
      const me = await api.enterpriseMe(state.enterprise.apiKey);
      console.log(JSON.stringify(me, null, 2));
    });

  cmd
    .command("disconnect")
    .description("Forget the saved enterprise API key")
    .action(async () => {
      await store.patchEnterprise({ apiKey: null, id: null, slug: null });
      console.log(pc.green("✓ disconnected"));
    });
}
