import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { ApplicationBuildInfo } from "./src/shared/build-info.js";

const fromRoot = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig(async ({ command }) => {
  if (command === "serve") {
    const { prepareDevelopment } = createRequire(import.meta.url)(
      "./build/prepare-development.cjs",
    ) as {
      prepareDevelopment(root: string): Promise<void>;
    };
    await prepareDevelopment(fromRoot("."));
  }
  const { captureBuildInfo } = createRequire(import.meta.url)("./build/build-info.cjs") as {
    captureBuildInfo(root: string, mode: "development" | "production"): ApplicationBuildInfo;
  };
  const info = captureBuildInfo(fromRoot("."), command === "serve" ? "development" : "production");
  const { rendererDevelopmentOptions } = createRequire(import.meta.url)(
    "./build/renderer-development.cjs",
  ) as {
    rendererDevelopmentOptions(root: string): {
      cacheDir: string;
      resolve: { dedupe: string[] };
      optimizeDeps: { include: string[]; exclude: string[] };
      server: { fs: { allow: string[] } };
    };
  };
  const rendererDevelopment = rendererDevelopmentOptions(fromRoot("."));
  const define = { __APPLICATION_BUILD_INFO__: JSON.stringify(info) };
  const buildInfoAsset = () => ({
    name: "application-build-info",
    generateBundle(this: {
      emitFile(file: { type: "asset"; fileName: string; source: string }): void;
    }) {
      this.emitFile({
        type: "asset",
        fileName: "build-info.json",
        source: JSON.stringify(info, null, 2),
      });
    },
  });
  return {
    main: {
      define,
      plugins: [buildInfoAsset()],
      build: {
        rollupOptions: {
          input: {
            index: fromRoot("./src/main/index.ts"),
            "print-font-worker": fromRoot("./src/main/exports/print-font-worker.ts"),
          },
        },
      },
    },
    preload: {
      build: {
        externalizeDeps: false,
        rollupOptions: {
          input: {
            index: fromRoot("./src/preload/index.ts"),
            "automation-tiles": fromRoot("./src/preload/automation-tiles.ts"),
          },
          output: {
            entryFileNames: "[name].cjs",
            format: "cjs" as const,
          },
        },
      },
    },
    renderer: {
      cacheDir: rendererDevelopment.cacheDir,
      optimizeDeps: rendererDevelopment.optimizeDeps,
      server: {
        ...rendererDevelopment.server,
        // vite 默认可能只绑定 IPv6 [::1]，而 Electron 渲染层按 IPv4 127.0.0.1 连接
        // dev server，连不上会触发 window.load_failed；显式绑定 IPv4 保证一致。
        host: "127.0.0.1",
      },
      define,
      plugins: [react(), buildInfoAsset()],
      resolve: {
        dedupe: rendererDevelopment.resolve.dedupe,
        alias: {
          // binaryWasm 变体使用 Web Worker + 独立 .wasm 文件，
          // 比默认的 base64 内联方案更适合 Electron file:// 环境
          "ketcher-standalone": fromRoot(
            "./node_modules/ketcher-standalone/dist/binaryWasm/main.js",
          ),
        },
      },
      build: {
        rollupOptions: {
          input: {
            index: fromRoot("./src/renderer/index.html"),
            automation: fromRoot("./src/renderer/automation-render.html"),
          },
        },
        commonjsOptions: {
          transformMixedEsModules: true,
        },
      },
    },
  };
});
