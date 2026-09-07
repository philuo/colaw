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

  const layers = [
    ...profile.layers.map(layer => layer.patches),
    profile.patches,
    loadOverlayPatches("dsh test", ELECTROBUN_PATCH),
  ];
  const patches: PatchOptions[] = composeEntries(layers).flatMap(row =>
    typeof row.id === "string" ? [row as PatchOptions] : [],
  );

  console.log("Booting dsh core...");
  const ctx = await boot("dsh test", rootConfig, structuredClone(patches), (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
    provideCmdline(hostCtx, { args: [], exit: () => {} });
  });

  console.log("Boot complete. Waiting for loader...");
  const loader = ctx.get("loader");
  if (loader) {
    console.log("Loader available, awaiting...");
    await loader.await();
    console.log("Loader awaited.");
  } else {
    console.log("No loader available.");
  }

  // Wait a bit more for async initialization
  await new Promise(r => setTimeout(r, 2000));

  console.log("\nChecking services after loader await:");
  const services = ["connection", "clientModules", "typertGateway", "webServer", "webRuntime", "agents", "llm", "session"];
  for (const name of services) {
    try {
      const svc = ctx.get(name as any);
      console.log(`  ${name}: ${svc ? "✅ available" : "❌ undefined"}`);
    } catch (e) {
      console.log(`  ${name}: ❌ error - ${(e as Error).message}`);
    }
  }

  // Check loader entries
  console.log("\nLoader entries:");
  if (loader) {
    const entries = loader.entries();
    console.log(`  Total entries: ${entries.length}`);
    const active = entries.filter((e: any) => e.fiber?.state === 'active');
    const pending = entries.filter((e: any) => e.fiber?.state === 'pending');
    const failed = entries.filter((e: any) => e.fiber === undefined);
    console.log(`  Active: ${active.length}, Pending: ${pending.length}, Failed/undefined: ${failed.length}`);
    if (failed.length > 0) {
      console.log("  Failed entries:");
      for (const e of failed.slice(0, 10)) {
        console.log(`    - ${e.options?.name}`);
      }
    }
    if (pending.length > 0) {
      console.log("  Pending entries:");
      for (const e of pending.slice(0, 10)) {
        const missing = Object.keys(e.fiber?.inject || {}).filter((k: string) => ctx.get(k as any) === undefined);
        console.log(`    - ${e.options?.name} (waiting for: ${missing.join(", ")})`);
      }
    }
  }

  await ctx.fiber.dispose();
}

main().catch(e => { console.error(e); process.exit(1); });
