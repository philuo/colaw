import { Context } from "@deepseek-ai/cordis";
import WebServer from "@deepseek-ai/dsh-host-webserver";

async function main() {
  console.log("Testing webserver plugin directly...");
  
  const ctx = new Context();
  
  try {
    console.log("Loading webserver plugin...");
    await ctx.plugin(WebServer, {
      host: "127.0.0.1",
      port: 0,
    });
    
    console.log("Plugin loaded.");
    console.log("Context fiber state:", ctx.fiber.state);
    
    // Check webServer service
    const webServer = ctx.get("webServer");
    console.log("webServer available:", !!webServer);
    
    if (webServer) {
      console.log("webServer port:", (webServer as any).port);
      console.log("webServer host:", (webServer as any).host);
      
      // Test register route
      const disposer = (webServer as any).register({
        kind: "exact",
        path: "/test",
        handler: (req: any, res: any) => {
          res.writeHead(200);
          res.end("Hello from test!");
        },
      });
      console.log("Route registered.");
      
      // Test fetch
      const port = (webServer as any).port;
      const res = await fetch(`http://127.0.0.1:${port}/test`);
      const text = await res.text();
      console.log(`Fetch /test → ${res.status}: ${text}`);
      
      disposer();
    }
    
    await ctx.fiber.dispose();
    console.log("\n✅ webserver plugin test passed!");
  } catch (e) {
    console.error("\n❌ webserver plugin test failed:", e);
    await ctx.fiber.dispose().catch(() => {});
    process.exit(1);
  }
}

main();
