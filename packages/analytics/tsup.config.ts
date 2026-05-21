import { defineConfig } from "tsup";
export default defineConfig([
  {
    entry: { index: "src/index.ts", "react/index": "src/react/index.tsx" },
    format: ["esm", "cjs"],
    dts: true,
    splitting: false,
    clean: true,
    target: "es2022",
  },
  {
    entry: { script: "src/script.ts" },
    format: ["iife"],
    globalName: "linkgrep",
    minify: true,
    clean: false,
    target: "es2017",
    outDir: "dist",
    outExtension: () => ({ js: ".js" }),
  },
]);
