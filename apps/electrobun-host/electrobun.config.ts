import type { ElectrobunConfig } from "electrobun";

/**
 * The bundle identity Hutch stamps into the app, by BUILD ENVIRONMENT.
 *
 * macOS keys an app — and every TCC grant made to it — on the bundle
 * identifier, so two bundles claiming one identifier are a single app to
 * LaunchServices: the privacy list resolves the display name to whichever
 * bundle registered last, and a development build could therefore appear
 * beside the product as `Colaw-dev` while holding the grant that belongs to
 * the app. The identifier is therefore distinct per flavor, and the dev name
 * sits outside the product's namespace altogether.
 *
 * The flavor follows `ELECTROBUN_BUILD_ENV`, which Hutch exports into this
 * config — `--env=stable` IS the official release build, so the product
 * identity needs no flag from any caller: the local chain
 * (scripts/pack-stable-release.ts), CI (.github/workflows/colaw-release.yml),
 * and the packer's own dev-env shell build all resolve correctly by their env
 * alone. Anything that is not `stable` gets the internal shell identity, so a
 * build can never claim the product's name or identifier by accident — the
 * failure this replaced was exactly that: the official build silently
 * producing `dsh-shell.app` under `ai.colawdev.harness`, and the release set
 * (DMG, zip, update feed) naming itself after it.
 *
 * Do not print from this file. Hutch reads this config back by parsing the
 * loader's stdout, and a stray console.log fails the entire build with a bare
 * `error: SyntaxError`.
 */
const appIdentity = process.env.ELECTROBUN_BUILD_ENV === "stable"
  ? { name: "Colaw", identifier: "ai.colaw.harness" }
  : { name: "dsh-shell", identifier: "ai.colawdev.harness" };

export default {
  app: {
    ...appIdentity,
    version: "1.0.8",
  },
  // The stable release identity (hash, manifest, delta patches) belongs to
  // Hutch's release packaging; the packer's payload merges in at postWrap.
  release: {
    baseUrl: process.env.COLAW_UPDATE_BASE_URL ?? "",
    generatePatch: true,
  },
  scripts: {
    postBuild: "./scripts/merge-stable-payload.ts",
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
      "tray-cat.png": "views/tray-cat.png",
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
