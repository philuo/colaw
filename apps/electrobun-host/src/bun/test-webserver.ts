import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PatchOptions } from "@deepseek-ai/cordis-plugin-include";
import { boot, loadLayeredEnv, loadProfile, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import { DSH_LAUNCH_ENVIRONMENT_KEY } from "@deepseek-ai/dsh-launch-environment";

// Custom patch: override webserver config with hardcoded values to test if !!js is the issue
const CUSTOM_PATCH = `
# Override webserver config with hardcoded values
- id: webserver
  config:
    host: 127.0.0.1
    port: 0
`;

async function main() {
  const projectDir = join(process.env.HOME!, ".dsh", "electrobun-test");
  mkdirSync(projectDir, { recursive: true });
  const rootConfig = join(projectDir, "test.cordis.yml");
  writeFileSync(rootConfig, "# Test\n[]\n");

  // Write custom patch
  const customPatchPath = join(projectDir, "custom.patch.yml");
  writeFileSync(customPatchPath, CUSTOM_PATCH);

  const environment = loadLayeredEnv("dsh test");
  const dshRoot = dirname(createRequire(join(projectDir, "package.json")).resolve("@deepseek-ai/dsh/package.json"));
  const profile = loadProfile("dsh test", "web", join(dshRoot, "package.json"));
  console.log("Profile layers:", profile.layers.map(l => l.packageName));

  const patches: PatchOptions[] = [
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
    ...loadOverlayPatches("dsh test", customPatchPath),
  ];
  console.log("Patches count:", patches.length);

  // Find webserver patch and print it
  const webserverPatch = patches.find(p => p.id === 'webserver');
  console.log("Webserver patch config:", JSON.stringify(webserverPatch?.config, null, 2));

  console.log("\nBooting dsh core (web + hardcoded webserver config)...");
  const ctx = await boot("dsh test", rootConfig, structuredClone(patches), (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
    provideCmdline(hostCtx, { args: [], exit: () => {} });
  });

  console.log("Boot complete.");
  console.log("Context fiber state:", ctx.fiber.state);

  // Check services
  console.log("\nChecking services:");
  const services = ["loader", "webServer", "webRuntime", "connection", "clientModules", "typertGateway"];
  for (const name of services) {
    try {
      const svc = (ctx as any).get(name);
      console.log(`  ${name}: ${svc ? "✅ available" : "❌ undefined"}`);
    } catch (e) {
      console.log(`  ${name}: ❌ error - ${(e as Error).message}`);
    }
  }

  // Try to fetch from webserver
  const webServer = ctx.get("webServer") as { port?: number } | undefined;
  if (webServer?.port) {
    console.log(`\nWebServer port: ${webServer.port}`);
    try {
      const res = await fetch(`http://127.0.0.1:${webServer.port}/`);
      console.log(`Fetch / → ${res.status}`);
    } catch (e) {
      console.log(`Fetch failed: ${(e as Error).message}`);
    }
  }

  await ctx.fiber.dispose();
  console.log("\n✅ Test completed!");
}

main().catch(e => { console.error(e); process.exit(1); });
