import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Colaw",
    identifier: "ai.deepseek.harness",
    version: "0.1.5-alpha.1",
  },
  build: {
    // 使用 Bun 作为主进程运行时（完全抛弃 Node.js）
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    // dsh 前端由运行中的 webserver 提供；overlay 补丁文件需进包（主进程按
    // Resources/config/... 相对路径读取）
    copy: {
      "config/electrobun.cordis.patch.yml": "config/electrobun.cordis.patch.yml",
    },
    mac: {
      bundleCEF: false,
      // App icon: .iconset converted to .icns via iconutil at build time.
      icons: "build/icon.iconset",
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig;
