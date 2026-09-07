import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "DeepSeek Harness",
    identifier: "ai.deepseek.harness",
    version: "0.1.3-alpha.2",
  },
  build: {
    // 使用 Bun 作为主进程运行时（完全抛弃 Node.js）
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    // dsh 前端由 Bun.serve HTTP 服务器提供，不需要拷贝静态资源
    copy: {},
    mac: {
      bundleCEF: false,
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig;
