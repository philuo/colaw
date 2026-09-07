import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PatchOptions } from "@deepseek-ai/cordis-plugin-include";
import { boot, composeEntries, loadLayeredEnv, loadProfile, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import { DSH_LAUNCH_ENVIRONMENT_KEY } from "@deepseek-ai/dsh-launch-environment";

const ELECTROBUN_PATCH = "/Users/fanchong/Desktop/workspace/colaw-test/deepseek-harness/apps/electrobun-host/config/electrobun.cordis.patch.yml";

async function main() {
  const projectDir = join(process.env.HOME!, ".dsh", "electrobun-test");
  mkdirSync(projectDir, { recursive: true });
  const rootConfig = join(projectDir, "test.cordis.yml");
  writeFileSync(rootConfig, "# Test\n[]\n");

  const environment = loadLayeredEnv("dsh test");
  const dshRoot = dirname(createRequire(join(projectDir, "package.json")).resolve("@deepseek-ai/dsh/package.json"));
  const profile = loadProfile("dsh test", "web", join(dshRoot, "package.json"));
  console.log("Profile layers:", profile.layers.map(l => l.packageName));

  const layers = [
    ...profile.layers.map(layer => layer.patches),
    profile.patches,
    loadOverlayPatches("dsh test", ELECTROBUN_PATCH),
  ];
  const patches: PatchOptions[] = composeEntries(layers).flatMap(row =>
    typeof row.id === "string" ? [row as PatchOptions] : [],
  );
  console.log("Patches count:", patches.length);
  console.log("Patch IDs:", patches.map(p => p.id).join(", "));

  const ctx = await boot("dsh test", rootConfig, structuredClone(patches), (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
    provideCmdline(hostCtx, { args: [], exit: () => {} });
  });

  console.log("\nContext keys:", Object.keys(ctx).join(", "));
  console.log("\nTrying common service names...");
  const services = ["connection", "clientModules", "typertGateway", "webServer", "webRuntime", "loader", "agents", "llm", "session"];
  for (const name of services) {
    try {
      const svc = ctx.get(name as any);
      console.log(`  ${name}: ${svc ? "✅ available" : "❌ undefined"}`);
    } catch (e) {
      console.log(`  ${name}: ❌ error - ${(e as Error).message}`);
    }
  }

  // Try to list all services from the fiber
  console.log("\nFiber keys:", Object.keys(ctx.fiber).join(", "));
  if (ctx.fiber.entries) {
    console.log("Fiber entries count:", ctx.fiber.entries.length);
  }

  await ctx.fiber.dispose();
}

main().catch(e => { console.error(e); process.exit(1); });
