import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PatchOptions } from "@deepseek-ai/cordis-plugin-include";
import { boot, loadLayeredEnv, loadProfile, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
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

  // Directly concatenate patches, like dsh CLI does
  const patches: PatchOptions[] = [
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
    ...loadOverlayPatches("dsh test", ELECTROBUN_PATCH),
  ];
  console.log("Patches count:", patches.length);
  console.log("First patch:", JSON.stringify(patches[0], null, 2).substring(0, 200));

  console.log("\nBooting dsh core...");
  const ctx = await boot("dsh test", rootConfig, structuredClone(patches), (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
    provideCmdline(hostCtx, { args: [], exit: () => {} });
  });

  console.log("Boot complete.");
  console.log("Context fiber state:", ctx.fiber.state);

  // Check services
  console.log("\nChecking services:");
  const services = ["connection", "clientModules", "typertGateway", "webServer", "webRuntime", "loader", "agents", "llm", "session", "systemPrompt"];
  for (const name of services) {
    try {
      const svc = (ctx as any).get(name);
      console.log(`  ${name}: ${svc ? "✅ available" : "❌ undefined"}`);
    } catch (e) {
      console.log(`  ${name}: ❌ error - ${(e as Error).message}`);
    }
  }

  // Check loader entries
  const loader = ctx.get("loader");
  if (loader) {
    console.log("\nLoader keys:", Object.keys(loader).join(", "));
    // Try different ways to get entries
    if ((loader as any).store) {
      console.log("Loader store keys:", Object.keys((loader as any).store).join(", "));
    }
    if ((loader as any).root) {
      console.log("Loader root type:", typeof (loader as any).root);
      console.log("Loader root keys:", Object.keys((loader as any).root || {}).join(", "));
    }
  }

  await ctx.fiber.dispose();
}

main().catch(e => { console.error(e); process.exit(1); });
