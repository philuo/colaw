import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

  console.log("\nBooting dsh core...");
  const ctx = await boot("dsh test", rootConfig, structuredClone(patches), (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
    provideCmdline(hostCtx, { args: [], exit: () => {} });
  });

  console.log("Boot complete.");
  console.log("\nContext fiber state:", ctx.fiber.state);
  console.log("Context keys:", Object.keys(ctx).join(", "));

  // Check loader
  const loader = ctx.get("loader");
  console.log("\nLoader available:", !!loader);
  if (loader) {
    console.log("Loader keys:", Object.keys(loader).join(", "));
    console.log("Loader type:", typeof loader);
    if (typeof loader.entries === "function") {
      const entries = loader.entries();
      console.log("Loader entries count:", entries?.length ?? "undefined");
      if (entries && entries.length > 0) {
        console.log("First 5 entry names:", entries.slice(0, 5).map((e: any) => e.options?.name ?? e.name));
      }
    } else {
      console.log("loader.entries is not a function");
    }
  }

  // Try to get services with various names
  console.log("\nTrying various service names:");
  const serviceNames = [
    "connection", "Connection", "clientConnection",
    "clientModules", "ClientModules", "modules",
    "typertGateway", "TypertGateway", "gateway",
    "webServer", "WebServer", "webserver",
    "webRuntime", "WebRuntime", "webruntime",
    "agents", "Agents", "agent",
    "llm", "LLM",
    "session", "Session",
    "cmdlineArgs", "cmdline",
  ];
  for (const name of serviceNames) {
    try {
      const svc = (ctx as any).get(name);
      if (svc !== undefined) {
        console.log(`  ✅ ${name}: available (type: ${typeof svc})`);
      }
    } catch (e) {
      // ignore
    }
  }

  // Check fiber inject
  console.log("\nFiber inject keys:", Object.keys(ctx.fiber.inject || {}).join(", "));
  console.log("Fiber runtime keys:", Object.keys(ctx.fiber.runtime || {}).join(", "));

  await ctx.fiber.dispose();
}

main().catch(e => { console.error(e); process.exit(1); });
