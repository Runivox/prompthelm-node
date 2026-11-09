import { defineConfig } from "tsup";

// tsup builds the two in parallel, so the library's clean spares the CLI's file.
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: ["!cli.js"],
    target: "es2022",
  },
  // `npx @prompt-helm/sdk pull`. Node only, and no part of what an app imports.
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    platform: "node",
    target: "es2022",
  },
]);
