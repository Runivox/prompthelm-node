// Loads what npm ships (dist/) and runs it, without the dev tools: CI runs this on the oldest
// Node versions package.json promises, which vitest and tsup no longer run on. Build first.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as esm from "../dist/index.js";

const cjs = createRequire(import.meta.url)("../dist/index.cjs");
const payload = { slug: "greet", version: 1, content: "Hi {{name}}", variables: ["name"] };
// In exp-1, user-0 falls in bucket 14 and user-1 in 33: a 20% test serves user-0 the variant.
const experiment = {
  id: "exp-1",
  weight: 20,
  variant: { version: 2, content: "Hey {{name}}", variables: ["name"] },
};

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

  const reports = [];
  const tested = new sdk.PromptHelm({
    apiKey: "ph_smoke",
    fetch: async (url, init) => {
      if (String(url).endsWith("/v1/reports")) {
        reports.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ ...payload, experiment }), {
        headers: { "content-type": "application/json", etag: '"2"' },
      });
    },
  });
  const control = await tested.resolve("greet", { vars: { name: "Ada" }, unit: "user-1" });
  assert.equal(`${control.text} v${control.version}`, "Hi Ada v1", format);
  const variant = await tested.resolve("greet", { vars: { name: "Ada" }, unit: "user-0" });
  assert.equal(`${variant.text} v${variant.version}`, "Hey Ada v2", format);
  variant.outcome(true);
  variant.usage({ input_tokens: 12, output_tokens: 3 }, 120);
  await tested.flush();
  const counted = reports[0]?.experiments[0]?.versions[2];
  assert.equal(`${counted?.served} ${counted?.outcomes} ${counted?.tokensIn}`, "1 1 12", format);

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
