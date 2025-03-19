import { defineConfig } from "vite";
import electron from 'vite-plugin-electron/simple'
import { viteSingleFile } from "vite-plugin-singlefile";
import { createHtmlPlugin } from "vite-plugin-html";

export default defineConfig({
  define: {
    VERSION: JSON.stringify(process.env.npm_package_version),
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: `[name].js`,  // 保持单文件输出格式
        chunkFileNames: `[name].js`,
        assetFileNames: `[name].[ext]`,
      },
    },
  },
  plugins: [
    electron({
      main: {
        entry: 'electron/main.ts',
      },
      preload: {
        input: 'electron/preload.ts',
      },
      vite: {
        build: {
          // 与现有构建配置兼容
          sourcemap: "inline",  // ✅ 推荐开启源码映射
        }
      }
    }),
    viteSingleFile(),
    createHtmlPlugin({ minify: true })
  ],
});