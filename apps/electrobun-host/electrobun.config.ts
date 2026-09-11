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
    // dsh 前端由运行中的 webserver 提供；overlay 补丁文件与两套主题图标需进包
    // （主进程按 Resources/ 相对路径读取：补丁在 Resources/app/、图标同处）。
    // bundle 图标用暗色（退出后 Dock/Launchpad 保持一致不回浅）；浅色版作为
    // 独立文件随包，运行时按偏好切换。
    copy: {
      "config/electrobun.cordis.patch.yml": "config/electrobun.cordis.patch.yml",
      "cat5_dark.icns": "cat5_dark.icns",
      "cat5_light.icns": "cat5_light.icns",
      "tray-cat.png": "tray-cat.png",
    },
    mac: {
      bundleCEF: false,
      // App icon: the dark set — the product's resting identity in the Dock
      // and Launchpad; a light-theme preference swaps it at runtime from the
      // copied cat5_light.icns. The iconset is not tracked: pack-stable-app
      // derives it from cat5_dark.icns with iconutil ahead of this build.
      icons: "build/cat5-dark.iconset",
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig;
