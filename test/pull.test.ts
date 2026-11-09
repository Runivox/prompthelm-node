import { describe, expect, it, vi } from "vitest";
import type { PromptPayload } from "../src/client";
import { type CliIO, parsePullArgs, renderFallbacks, runCli } from "../src/pull";

const PROMPTS: PromptPayload[] = [
  {
    slug: "support-reply",
    version: 7,
    content: "Answer {{name}} in two sentences.",
    variables: ["name"],
  },
  { slug: "greeting", version: 2, content: 'Say "hi".', variables: [] },
];

function io(env: Record<string, string> = { PROMPTHELM_API_KEY: "ph_test" }) {
  const files = new Map<string, string>();
  const logs: string[] = [];
  const errors: string[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({ prompts: PROMPTS }),
  );
  const cli: CliIO = {
    env,
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
    write: async (path, text) => {
      files.set(path, text);
    },
    fetch: fetch as unknown as typeof globalThis.fetch,
  };
  return { cli, files, logs, errors, fetch };
}

describe("pull arguments", () => {
  it("defaults to a JSON file and reads the format from the extension", () => {
    expect(parsePullArgs([])).toEqual({ out: "prompthelm.fallbacks.json", format: "json" });
    expect(parsePullArgs(["--out", "src/fallbacks.ts"])).toEqual({
      out: "src/fallbacks.ts",
      format: "ts",
    });
    expect(parsePullArgs(["--out=a.txt", "--format=json"])).toEqual({
      out: "a.txt",
      format: "json",
    });
  });

  it("explains what it can't use", () => {
    expect(parsePullArgs(["--out", "a.js"])).toMatchObject({
      error: expect.stringContaining("--format"),
    });
    expect(parsePullArgs(["--format", "yaml"])).toMatchObject({
      error: expect.stringContaining("yaml"),
    });
    expect(parsePullArgs(["--out"])).toMatchObject({ error: "--out needs a value" });
    expect(parsePullArgs(["--force"])).toMatchObject({ error: "Unknown argument: --force" });
    expect(parsePullArgs(["--help"])).toBe("help");
  });
});

describe("the fallbacks file", () => {
  it("maps each slug to its live text, sorted, in JSON", () => {
    const text = renderFallbacks(PROMPTS, "json");
    expect(JSON.parse(text)).toEqual({
      greeting: 'Say "hi".',
      "support-reply": "Answer {{name}} in two sentences.",
    });
    expect(Object.keys(JSON.parse(text))).toEqual(["greeting", "support-reply"]);
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("writes TypeScript with typed keys", () => {
    const text = renderFallbacks(PROMPTS, "ts");
    expect(text).toContain("export const fallbacks = {");
    expect(text).toContain('"greeting": "Say \\"hi\\"."');
    expect(text.trimEnd().endsWith("} as const;")).toBe(true);
  });
});

describe("npx @prompt-helm/sdk pull", () => {
  it("fetches the list with the key and writes the file", async () => {
    const run = io({ PROMPTHELM_API_KEY: "ph_test", PROMPTHELM_BASE_URL: "https://example.test/" });
    expect(await runCli(["pull", "--out", "src/f.ts"], run.cli)).toBe(0);

    const [url, init] = run.fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://example.test/v1/prompts");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ph_test");
    expect(run.files.get("src/f.ts")).toBe(renderFallbacks(PROMPTS, "ts"));
    expect(run.logs.join("\n")).toContain("Wrote 2 prompts to src/f.ts");
  });

  it("fails with a message and writes nothing on a bad key or no key", async () => {
    const run = io();
    run.fetch.mockResolvedValueOnce(
      Response.json(
        { error: { code: "unauthorized", message: "Missing or invalid API key" } },
        {
          status: 401,
        },
      ),
    );
    expect(await runCli(["pull"], run.cli)).toBe(1);
    expect(run.errors).toEqual(["PromptHelm: Missing or invalid API key"]);
    expect(run.files.size).toBe(0);

    const keyless = io({});
    expect(await runCli(["pull"], keyless.cli)).toBe(1);
    expect(keyless.errors[0]).toContain("PROMPTHELM_API_KEY");
    expect(keyless.fetch).not.toHaveBeenCalled();
  });

  it("prints usage for help, and fails for anything else", async () => {
    const run = io();
    expect(await runCli(["--help"], run.cli)).toBe(0);
    expect(run.logs[0]).toContain("Usage: npx @prompt-helm/sdk pull");
    expect(await runCli([], run.cli)).toBe(1);
    expect(await runCli(["push"], run.cli)).toBe(1);
    expect(run.errors.at(-1)).toContain("Unknown command: push");
  });
});
