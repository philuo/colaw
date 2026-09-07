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
  const profile = loadProfile("dsh test", "web", join(dshRoot, "package.json"));

  const patches: PatchOptions[] = [
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
  ];

  // Disable modules plugin to see if other plugins load
  const disabledModulesPatch = [{ id: "modules", disabled: true }];
  const allPatches = [...patches, ...disabledModulesPatch];

  console.log("Booting dsh core (web + modules disabled)...");
  const ctx = await boot("dsh test", rootConfig, structuredClone(allPatches), (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
    provideCmdline(hostCtx, { args: [], exit: () => {} });
  });

  console.log("Boot complete.");
  console.log("Context fiber state:", ctx.fiber.state);

  // Check services
  console.log("\nChecking services:");
  const services = ["loader", "webServer", "webRuntime", "connection", "typertGateway", "clientModules"];
  for (const name of services) {
    try {
      const svc = (ctx as any).get(name);
      console.log(`  ${name}: ${svc ? "✅ available" : "❌ undefined"}`);
    } catch (e) {
      console.log(`  ${name}: ❌ error - ${(e as Error).message}`);
    }
  }

  // Check webServer details
  const webServer = ctx.get("webServer") as { port?: number; host?: string } | undefined;
  if (webServer) {
    console.log(`\nWebServer details:`);
    console.log(`  port: ${webServer.port}`);
    console.log(`  host: ${webServer.host}`);
  }

  // Try to fetch from webserver
  if (webServer?.port) {
    try {
      const res = await fetch(`http://127.0.0.1:${webServer.port}/`);
      console.log(`\nFetch / → ${res.status}`);
    } catch (e) {
      console.log(`\nFetch failed: ${(e as Error).message}`);
    }
  }

  await ctx.fiber.dispose();
  console.log("\n✅ Test completed!");
}

main().catch(e => { console.error(e); process.exit(1); });
