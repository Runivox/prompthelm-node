// Loads what npm ships (dist/) and runs it, without the dev tools: CI runs this on the oldest
// Node versions package.json promises, which vitest and tsup no longer run on. Build first.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as esm from "../dist/index.js";

const cjs = createRequire(import.meta.url)("../dist/index.cjs");
const payload = { slug: "greet", version: 1, content: "Hi {{name}}", variables: ["name"] };

for (const [format, sdk] of [
  ["ESM", esm],
  ["CommonJS", cjs],
]) {
  const live = new sdk.PromptHelm({
    apiKey: "ph_smoke",
    fetch: async () =>
      new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json", etag: '"1"' },
      }),
  });
  assert.equal(await live.get("greet", { vars: { name: "Ada" } }), "Hi Ada", format);

  const errors = [];
  const down = new sdk.PromptHelm({
    apiKey: "ph_smoke",
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
    onError: (error) => errors.push(error.code),
  });
  const served = await down.get("greet", { vars: { name: "Ada" }, fallback: "Hello {{name}}" });
  assert.equal(served, "Hello Ada", format);
  assert.deepEqual(errors, ["network"], format);

  assert.deepEqual(sdk.extractVariables("{{a}} and {{b}}"), ["a", "b"], format);
}

execFileSync(process.execPath, ["dist/cli.js", "--help"], { stdio: "ignore" });
console.log(`dist loads and serves on Node ${process.versions.node}`);
