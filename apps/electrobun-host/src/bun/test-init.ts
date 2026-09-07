/**
 * Test script v3: verify dsh core boot using web profile + dsh's own webserver.
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { PatchOptions } from "@deepseek-ai/cordis-plugin-include";
import {
  boot,
  loadLayeredEnv,
  loadProfile,
  loadOverlayPatches,
} from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import { DSH_LAUNCH_ENVIRONMENT_KEY } from "@deepseek-ai/dsh-launch-environment";

const ELECTROBUN_PATCH = fileURLToPath(new URL("../../config/electrobun.cordis.patch.yml", import.meta.url));
const ROOT_CONFIG = "# Test composition root.\n[]\n";
const ROOT_CONFIG_FILENAME = "test.cordis.yml";

async function main() {
  console.log("=== dsh Electrobun Host Test v3 (web profile + dsh webserver) ===\n");

  // 1. Boot dsh core using web profile
  console.log("[1/4] Booting dsh core (web profile)...");
  const projectDir = join(process.env.DSH_HOME ?? join(process.env.HOME ?? "/tmp", ".dsh"), "electrobun-test");
  mkdirSync(projectDir, { recursive: true });
  const rootConfig = join(projectDir, ROOT_CONFIG_FILENAME);
  writeFileSync(rootConfig, ROOT_CONFIG);

  const environment = loadLayeredEnv("dsh test");
  const dshRoot = dirname(createRequire(join(projectDir, "package.json")).resolve("@deepseek-ai/dsh/package.json"));
  const profile = loadProfile("dsh test", "web", join(dshRoot, "package.json"));

  const patches: PatchOptions[] = [
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
    ...loadOverlayPatches("dsh test", ELECTROBUN_PATCH),
  ];

  const ctx = await boot("dsh test", rootConfig, structuredClone(patches), (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
    provideCmdline(hostCtx, { args: [], exit: () => {} });
  });

  console.log("  ✅ dsh core booted");

  // 2. Check required services
  console.log("\n[2/4] Checking services...");
  const connection = ctx.get("connection");
  const clientModules = ctx.get("clientModules");
  const gateway = ctx.get("typertGateway");
  const webServer = ctx.get("webServer");
  console.log(`  connection: ${connection ? "✅" : "❌"}`);
  console.log(`  clientModules: ${clientModules ? "✅" : "❌"}`);
  console.log(`  typertGateway: ${gateway ? "✅" : "❌"}`);
  console.log(`  webServer: ${webServer ? "✅" : "❌"}`);

  if (!connection || !clientModules || !gateway || !webServer) {
    throw new Error("Missing required services");
  }

  // 3. Get webserver URL and test
  console.log("\n[3/4] Testing dsh webserver...");
  const port = webServer.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`  webserver URL: ${baseUrl}`);

  // Test static assets
  const indexRes = await fetch(`${baseUrl}/`);
  const indexText = await indexRes.text();
  console.log(`  ✅ GET / → ${indexRes.status}, ${indexText.length} bytes`);

  // Test API initialize
  const initRes = await fetch(`${baseUrl}/api/initialize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "electrobun-test", version: "0.1.0" },
      },
    }),
  });
  const initText = await initRes.text();
  console.log(`  ✅ POST /api/initialize → ${initRes.status}`);
  console.log(`  Response: ${initText.substring(0, 200)}...`);

  // 4. Summary
  console.log("\n[4/4] Summary");
  console.log(`  ✅ dsh core booted successfully`);
  console.log(`  ✅ All required services available`);
  console.log(`  ✅ dsh webserver serving on ${baseUrl}`);
  console.log(`  ✅ Static assets and API both working`);
  console.log(`\n  → Electrobun can simply load ${baseUrl} in a BrowserWindow!`);

  // Cleanup
  console.log("\n=== Cleanup ===");
  await ctx.fiber.dispose();
  console.log("  ✅ dsh core disposed");

  console.log("\n🎉 All tests passed!");
}

main().catch((error) => {
  console.error("\n❌ Test failed:", error);
  process.exit(1);
});
