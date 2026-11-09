import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import {
  DEFAULT_BASE_URL,
  errorFromResponse,
  type PromptListPayload,
  type PromptPayload,
} from "./client";
import { PromptHelmError } from "./errors";

/**
 * `npx @prompt-helm/sdk pull`: writes the live text of every published prompt to one file, so the
 * fallbacks an app passes to `get()` follow the dashboard instead of going stale in the code. Node
 * only, and never part of the library's bundle.
 */

export type FallbackFormat = "json" | "ts";

export interface PullOptions {
  out: string;
  format: FallbackFormat;
}

const DEFAULT_OUT = "prompthelm.fallbacks.json";
const TIMEOUT_MS = 10_000;

export const USAGE = `Usage: npx @prompt-helm/sdk pull [--out <file>] [--format json|ts]

Writes the live text of every published prompt in the project to one file, keyed by slug,
to pass to get() as its fallback.

  --out <file>     Where to write it. Default: ${DEFAULT_OUT}
  --format <name>  json or ts. Default: from the file's extension.

Reads PROMPTHELM_API_KEY, and PROMPTHELM_BASE_URL when it's set.`;

const TS_HEADER = `// Written by \`npx @prompt-helm/sdk pull\`: the live text of each prompt, to pass to get() as
// its fallback. Run it again to refresh it; edits here are overwritten.
`;

export function parsePullArgs(args: readonly string[]): PullOptions | "help" | { error: string } {
  let out = DEFAULT_OUT;
  let format: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "-h" || arg === "--help") return "help";
    const match = /^--(out|format)(?:=(.*))?$/.exec(arg);
    if (!match) return { error: `Unknown argument: ${arg}` };
    const value = match[2] ?? args[++index];
    if (!value) return { error: `--${match[1]} needs a value` };
    if (match[1] === "out") out = value;
    else format = value;
  }
  format ??= formatFromExtension(out);
  if (format === "json" || format === "ts") return { out, format };
  return format === undefined
    ? { error: `Can't tell the format from "${out}": pass --format json or --format ts` }
    : { error: `Unknown format "${format}": use json or ts` };
}

function formatFromExtension(path: string): FallbackFormat | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") return "ts";
  return undefined;
}

/** Every published prompt of the key's project, from `GET /v1/prompts`. */
export async function fetchLivePrompts(options: {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch | undefined;
}): Promise<PromptPayload[]> {
  const request = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await request(`${options.baseUrl.replace(/\/+$/, "")}/v1/prompts`, {
      headers: { authorization: `Bearer ${options.apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === "TimeoutError") {
      throw new PromptHelmError("timeout", `No response within ${TIMEOUT_MS} ms`);
    }
    throw new PromptHelmError("network", error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) throw await errorFromResponse(response);
  return ((await response.json()) as PromptListPayload).prompts;
}

/** The file's text: sorted by slug, so a refresh only shows in a diff when a prompt changed. */
export function renderFallbacks(prompts: readonly PromptPayload[], format: FallbackFormat): string {
  const sorted = [...prompts].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const json = JSON.stringify(Object.fromEntries(sorted.map((p) => [p.slug, p.content])), null, 2);
  return format === "json"
    ? `${json}\n`
    : `${TS_HEADER}export const fallbacks = ${json} as const;\n`;
}

export interface CliIO {
  env: Record<string, string | undefined>;
  log(message: string): void;
  error(message: string): void;
  write(path: string, text: string): Promise<void>;
  fetch?: typeof globalThis.fetch;
}

const nodeIO = (): CliIO => ({
  env: process.env,
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  write: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  },
});

/** Runs the command line and returns the exit code. */
export async function runCli(argv: readonly string[], io: CliIO = nodeIO()): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "-h" || command === "--help") {
    io.log(USAGE);
    return 0;
  }
  if (command !== "pull") {
    io.error(command ? `Unknown command: ${command}\n\n${USAGE}` : USAGE);
    return 1;
  }

  const parsed = parsePullArgs(rest);
  if (parsed === "help") {
    io.log(USAGE);
    return 0;
  }
  if ("error" in parsed) {
    io.error(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  const apiKey = io.env.PROMPTHELM_API_KEY;
  if (!apiKey) {
    io.error("Set PROMPTHELM_API_KEY to an API key of the project to pull.");
    return 1;
  }

  try {
    const prompts = await fetchLivePrompts({
      apiKey,
      baseUrl: io.env.PROMPTHELM_BASE_URL || DEFAULT_BASE_URL,
      fetch: io.fetch,
    });
    await io.write(parsed.out, renderFallbacks(prompts, parsed.format));
    io.log(
      prompts.length === 0
        ? `No published prompts yet; wrote an empty list to ${parsed.out}.`
        : `Wrote ${prompts.length} ${prompts.length === 1 ? "prompt" : "prompts"} to ${parsed.out}:\n${prompts
            .map((p) => `  ${p.slug} v${p.version}`)
            .join("\n")}`,
    );
    return 0;
  } catch (error) {
    io.error(`PromptHelm: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
