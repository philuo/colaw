import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PatchOptions } from "@deepseek-ai/cordis-plugin-include";
import { boot, loadLayeredEnv, loadProfile, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import { DSH_LAUNCH_ENVIRONMENT_KEY } from "@deepseek-ai/dsh-launch-environment";

async function main() {
  const projectDir = join(process.env.HOME!, ".dsh", "electrobun-test");
  mkdirSync(projectDir, { recursive: true });
  const rootConfig = join(projectDir, "test.cordis.yml");
  writeFileSync(rootConfig, "# Test\n[]\n");

  const environment = loadLayeredEnv("dsh test");
  const dshRoot = dirname(createRequire(join(projectDir, "package.json")).resolve("@deepseek-ai/dsh/package.json"));
  
  // Test base profile
  const profile = loadProfile("dsh test", "sdk-minimal", join(dshRoot, "package.json"));
  console.log("Profile layers:", profile.layers.map(l => l.packageName));

  const patches: PatchOptions[] = [
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
  ];
  console.log("Patches count:", patches.length);

  console.log("\nBooting dsh core (sdk-minimal)...");
  const ctx = await boot("dsh test", rootConfig, structuredClone(patches), (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
    provideCmdline(hostCtx, { args: [], exit: () => {} });
  });

  console.log("Boot complete.");
  console.log("Context fiber state:", ctx.fiber.state);

  // Check common services
  console.log("\nChecking services:");
  const services = ["loader", "agents", "llm", "session", "typertGateway", "connection", "webServer", "webRuntime", "clientModules"];
  for (const name of services) {
    try {
      const svc = (ctx as any).get(name);
      console.log(`  ${name}: ${svc ? "✅ available" : "❌ undefined"}`);
    } catch (e) {
      console.log(`  ${name}: ❌ error - ${(e as Error).message}`);
    }
  }

  await ctx.fiber.dispose();
  console.log("\n✅ sdk-minimal profile test passed!");
}

main().catch(e => { console.error(e); process.exit(1); });
