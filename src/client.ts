import { PromptHelmError, type PromptHelmErrorCode } from "./errors";
import { bucket, LATENCY_BUCKETS, latencyBucket } from "./experiment";
import { render, type Vars } from "./template";

/** Not exported from the package: shared with the `pull` command. */
export const DEFAULT_BASE_URL = "https://prompthelm.app";

/** Body of `GET /v1/prompts/:slug`. The server types its response with this too. */
export interface PromptPayload {
  slug: string;
  version: number;
  content: string;
  variables: string[];
  /** The version's model settings; servers before SDK 1.4 send none. */
  config?: PromptConfig;
  /** An A/B test running on the prompt: the live version above is its control. */
  experiment?: PromptExperiment;
}

/**
 * Model settings published with a version, for your model call. Only the ones set in the
 * dashboard are present; for the rest, your code's defaults apply.
 */
export interface PromptConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface PromptExperiment {
  id: string;
  /** The variant's share of calls, in percent (1–99). */
  weight: number;
  variant: { version: number; content: string; variables: string[]; config?: PromptConfig };
}

/**
 * Sent with the next request for a slug after `get()` couldn't serve its live text: the error's
 * code alone, never any text or variable value. The server records it for the prompt page.
 */
export const FALLBACK_HEADER = "x-prompthelm-fallback";

/** Body of `GET /v1/prompts`: every published prompt of the key's project, by slug. */
export interface PromptListPayload {
  prompts: PromptPayload[];
}

/**
 * Body of `POST /v1/reports`: what an app counted under running A/B tests since its last report.
 * Numbers only, never any text, variable value or unit.
 */
export interface ReportPayload {
  experiments: {
    id: string;
    /** The variant's share when these calls were assigned. */
    weight: number;
    /** By version number. */
    versions: Record<string, ReportCounts>;
  }[];
}

export interface ReportCounts {
  served: number;
  /** Picked for the variant, served the live version because a variable wasn't passed. */
  skipped: number;
  outcomes: number;
  /** The outcomes' scores (true = 1, false = 0), summed, and their squares summed. */
  scoreSum: number;
  scoreSqSum: number;
  /** Calls whose model usage was reported, their tokens and their durations in ms, summed. */
  usage: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  /** Those calls per latency bucket (`latencyBucket`). */
  latency: number[];
}

export interface PromptHelmOptions {
  /** Defaults to the PROMPTHELM_API_KEY environment variable. */
  apiKey?: string;
  /** Defaults to PROMPTHELM_BASE_URL, then https://prompthelm.app. */
  baseUrl?: string;
  /** How long a fetched prompt is served before checking for a newer version, in ms. */
  ttl?: number;
  /** Per-request timeout in ms. */
  timeout?: number;
  fetch?: typeof globalThis.fetch;
  /** Told whenever a fallback or a stale prompt was served instead of failing. */
  onError?: (error: PromptHelmError, slug: string) => void;
  /**
   * Whether to tell PromptHelm, by error code only, when the live text couldn't be served, so the
   * prompt's page shows it. Defaults to true.
   */
  reportFallbacks?: boolean;
  /**
   * Whether to send PromptHelm, as totals only, what happened under an A/B test: how often each
   * version was served, the outcomes and the model usage you report. Defaults to
   * `reportFallbacks`.
   */
  reportResults?: boolean;
  /** Called on every `get` and `resolve`, so your analytics or traces can carry the version. */
  onResolve?: (event: ResolveEvent) => void;
}

export interface GetOptions {
  vars?: Vars;
  /**
   * Served when PromptHelm can't be reached, the prompt doesn't exist, or the live
   * version uses a variable this call doesn't pass. Without it those cases throw.
   */
  fallback?: string;
  /**
   * Who the call is for, such as a user or conversation id: during an A/B test the same unit
   * always gets the same version. Never sent to PromptHelm.
   */
  unit?: string | number;
  /** During an A/B test, serves this side, such as the variant to your own team. Never counted. */
  force?: "control" | "variant";
}

export interface ResolveEvent {
  slug: string;
  /** The version served, or null when the fallback was. */
  version: number | null;
  /** The A/B test running on the prompt, if any. */
  experiment: string | null;
  /** Whether the call got the test's variant. */
  variant: boolean;
}

export interface Resolved {
  text: string;
  /**
   * The served version's model settings, such as `model`. Empty when the fallback was served,
   * so your code's defaults apply.
   */
  config: PromptConfig;
  /** The version served, or null when the fallback was. */
  version: number | null;
  /**
   * During an A/B test, names the test and the version this call got, so its outcome can be
   * reported later from any process: `ph.outcome(ticket, true)`. No user in it. Null otherwise.
   */
  ticket: string | null;
  /** How the call went: true or false, or a score from 0 to 1. The first report counts. */
  outcome(value: boolean | number): void;
  /**
   * The model call's tokens, from your provider's `usage` object, and how long it took: `ms`,
   * else the time since `resolve` returned. The first report counts.
   */
  usage(usage: object | null | undefined, ms?: number): void;
}

interface Entry {
  version: number;
  content: string;
  config: PromptConfig;
  experiment: PromptExperiment | undefined;
  etag: string | null;
  fetchedAt: number;
}

/** An A/B test as its calls were assigned: under this share. */
interface Test {
  id: string;
  weight: number;
}

// A version's counts are kept as numbers in this order, then one per latency bucket.
const FIELDS = [
  "served",
  "skipped",
  "outcomes",
  "scoreSum",
  "scoreSqSum",
  "usage",
  "tokensIn",
  "tokensOut",
  "latencyMs",
] as const;
const SERVED = 0;
const SKIPPED = 1;
const OUTCOMES = 2;
const SCORE = 3;
const SCORE_SQ = 4;
const USAGE = 5;
const TOKENS_IN = 6;
const TOKENS_OUT = 7;
const LATENCY = 8;
const BUCKETS = FIELDS.length;

/** Counts not yet sent, by test and share, then by version. */
type Pending = Map<string, Test & { versions: Map<number, number[]> }>;

export class PromptHelm {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #ttl: number;
  readonly #timeout: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #onError: (error: PromptHelmError, slug: string) => void;
  readonly #onResolve: ((event: ResolveEvent) => void) | undefined;
  readonly #cache = new Map<string, Entry>();
  readonly #inflight = new Map<string, Promise<Entry>>();
  readonly #reportFallbacks: boolean;
  readonly #reportResults: boolean;
  // Per slug, why the live text last couldn't be served, until a request carries it. An object,
  // so a report made while that request is in flight isn't cleared with the one it carried.
  readonly #unreported = new Map<string, { code: PromptHelmErrorCode }>();
  #pending: Pending = new Map();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: PromptHelmOptions = {}) {
    const apiKey = options.apiKey ?? env("PROMPTHELM_API_KEY");
    if (!apiKey) throw new Error("PromptHelm: pass apiKey or set PROMPTHELM_API_KEY");
    this.#apiKey = apiKey;
    const baseUrl = options.baseUrl ?? env("PROMPTHELM_BASE_URL") ?? DEFAULT_BASE_URL;
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#ttl = options.ttl ?? 60_000;
    this.#timeout = options.timeout ?? 3_000;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#onError =
      options.onError ?? ((error, slug) => console.warn(`[PromptHelm] ${slug}: ${error.message}`));
    this.#onResolve = options.onResolve;
    this.#reportFallbacks = options.reportFallbacks ?? true;
    this.#reportResults = options.reportResults ?? this.#reportFallbacks;
  }

  /** The live version of a prompt with its variables filled in. */
  async get(slug: string, options: GetOptions = {}): Promise<string> {
    return (await this.resolve(slug, options)).text;
  }

  /** Like `get`, and says which version was served, so you can tag your logs or traces with it. */
  async resolve(slug: string, options: GetOptions = {}): Promise<Resolved> {
    const { vars, fallback } = options;
    try {
      return this.#pick(slug, await this.#entry(slug), options);
    } catch (error) {
      const failure = toPromptHelmError(error);
      this.#remember(slug, failure.code);
      if (fallback === undefined) throw failure;
      this.#onError(failure, slug);
      return this.#served(slug, render(fallback, vars), {}, null);
    }
  }

  /** Reports the outcome of a call made earlier, by its `ticket`. Ignores anything else. */
  outcome(ticket: string, value: boolean | number): void {
    const [id = "", version, weight] = ticket.split(".");
    const test = { id, weight: Number(weight) };
    if (id && test.weight > 0) this.#outcome(test, Number(version), value);
  }

  /**
   * Sends what was counted for A/B tests now, instead of within a ttl: call it before a
   * serverless function freezes. Never throws; what can't be sent is kept for the next try.
   */
  async flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const sent = this.#pending;
    if (sent.size === 0) return;
    this.#pending = new Map();
    const body: ReportPayload = {
      experiments: [...sent.values()].map(({ id, weight, versions }) => ({
        id,
        weight,
        versions: Object.fromEntries(
          [...versions].map(([version, counts]) => [
            version,
            {
              ...Object.fromEntries(FIELDS.map((field, i) => [field, counts[i]])),
              latency: counts.slice(BUCKETS),
            } as ReportCounts,
          ]),
        ),
      })),
    };
    try {
      const response = await this.#fetch(`${this.#baseUrl}/v1/reports`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeout),
      });
      // Refused (a revoked key, a test that's gone) won't succeed later either.
      if (response.status < 500) return;
    } catch {
      // Unreachable: kept below for the next try.
    }
    // Put back what didn't arrive, adding it to anything counted meanwhile.
    for (const { id, weight, versions } of sent.values()) {
      for (const [version, counts] of versions) {
        const total = this.#counts({ id, weight }, version);
        counts.forEach((n, i) => {
          add(total, i, n);
        });
      }
    }
  }

  #pick(slug: string, entry: Entry, options: GetOptions): Resolved {
    const { vars, unit, force } = options;
    const { experiment } = entry;
    // Calls forced to a side aren't part of the test, so they aren't counted.
    const test =
      experiment && !force ? { id: experiment.id, weight: experiment.weight } : undefined;
    let skipped: PromptHelmError | undefined;
    if (
      experiment &&
      (force ? force === "variant" : bucket(experiment.id, unit) < experiment.weight)
    ) {
      const { version, content, config = {} } = experiment.variant;
      try {
        return this.#served(
          slug,
          render(content, vars),
          config,
          version,
          experiment.id,
          test,
          true,
        );
      } catch (error) {
        skipped = toPromptHelmError(error);
      }
    }
    // The live version is what the app was built for. If it can't be filled in either, the
    // caller serves the fallback and reports that instead.
    const text = render(entry.content, vars);
    if (skipped && experiment) {
      // Not a fallback, so not reported as one: the call got the live version.
      this.#onError(skipped, slug);
      if (test) add(this.#counts(test, experiment.variant.version), SKIPPED, 1);
    }
    return this.#served(slug, text, entry.config, entry.version, experiment?.id, test);
  }

  /** Counts the call, tells `onResolve`, and hands the caller its text, settings and what to report. */
  #served(
    slug: string,
    text: string,
    config: PromptConfig,
    version: number | null,
    experiment?: string,
    test?: Test,
    variant = false,
  ): Resolved {
    if (test && version !== null) add(this.#counts(test, version), SERVED, 1);
    try {
      this.#onResolve?.({ slug, version, experiment: experiment ?? null, variant });
    } catch {
      // The app's own hook: its failure is never the call's.
    }
    const started = Date.now();
    let reported = 0;
    return {
      text,
      // A copy: the cached one serves every later call.
      config: { ...config },
      version,
      ticket: test && version !== null ? `${test.id}.${version}.${test.weight}` : null,
      outcome: (value) => {
        if (!test || version === null || reported & 1) return;
        reported |= 1;
        this.#outcome(test, version, value);
      },
      usage: (usage, ms = Date.now() - started) => {
        if (!test || version === null || reported & 2) return;
        reported |= 2;
        const counts = this.#counts(test, version);
        const fields = (usage ?? {}) as Record<string, unknown>;
        add(counts, USAGE, 1);
        add(counts, TOKENS_IN, tokens(fields, IN));
        add(counts, TOKENS_OUT, tokens(fields, OUT));
        add(counts, LATENCY, Math.max(0, ms));
        add(counts, BUCKETS + latencyBucket(ms), 1);
      },
    };
  }

  #outcome(test: Test, version: number, value: boolean | number): void {
    const score = value === true ? 1 : value === false ? 0 : value;
    if (!Number.isInteger(version) || !(score >= 0 && score <= 1)) return;
    const counts = this.#counts(test, version);
    add(counts, OUTCOMES, 1);
    add(counts, SCORE, score);
    add(counts, SCORE_SQ, score * score);
  }

  /** The counts to add a call to, kept until the next report; none when reporting is off. */
  #counts(test: Test, version: number): number[] | undefined {
    if (!this.#reportResults) return;
    const key = `${test.id}.${test.weight}`;
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = { ...test, versions: new Map() };
      this.#pending.set(key, pending);
    }
    let counts = pending.versions.get(version);
    if (!counts) {
      counts = new Array<number>(BUCKETS + LATENCY_BUCKETS).fill(0);
      pending.versions.set(version, counts);
    }
    this.#schedule();
    return counts;
  }

  /** Reports within a ttl of the first count, without keeping the process alive for it. */
  #schedule(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => this.flush(), this.#ttl);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  #entry(slug: string): Promise<Entry> {
    const cached = this.#cache.get(slug);
    if (!cached) return this.#load(slug);
    if (Date.now() - cached.fetchedAt >= this.#ttl) {
      // Serve the cached prompt now and refresh behind it. A failed refresh keeps it
      // and waits a full ttl before retrying, so an outage doesn't turn into a retry loop.
      this.#load(slug).catch((error: unknown) => {
        cached.fetchedAt = Date.now();
        const failure = toPromptHelmError(error);
        this.#remember(slug, failure.code);
        this.#onError(failure, slug);
      });
    }
    return Promise.resolve(cached);
  }

  #remember(slug: string, code: PromptHelmErrorCode): void {
    if (this.#reportFallbacks) this.#unreported.set(slug, { code });
  }

  #load(slug: string): Promise<Entry> {
    let pending = this.#inflight.get(slug);
    if (!pending) {
      pending = this.#request(slug).finally(() => this.#inflight.delete(slug));
      this.#inflight.set(slug, pending);
    }
    return pending;
  }

  async #request(slug: string): Promise<Entry> {
    const cached = this.#cache.get(slug);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      accept: "application/json",
    };
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    const report = this.#unreported.get(slug);
    if (report) headers[FALLBACK_HEADER] = report.code;

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/v1/prompts/${encodeURIComponent(slug)}`, {
        headers,
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name === "TimeoutError") {
        throw new PromptHelmError("timeout", `No response within ${this.#timeout} ms`);
      }
      throw new PromptHelmError("network", error instanceof Error ? error.message : String(error));
    }

    // PromptHelm has the report once it answers; a failed request carries it again next time.
    if (
      report &&
      (response.ok || response.status === 304) &&
      this.#unreported.get(slug) === report
    ) {
      this.#unreported.delete(slug);
    }

    if (response.status === 304 && cached) {
      const entry = { ...cached, fetchedAt: Date.now() };
      this.#cache.set(slug, entry);
      return entry;
    }
    if (!response.ok) throw await errorFromResponse(response);

    const payload = (await response.json()) as PromptPayload;
    const entry = {
      version: payload.version,
      content: payload.content,
      config: payload.config ?? {},
      experiment: payload.experiment,
      etag: response.headers.get("etag"),
      fetchedAt: Date.now(),
    };
    this.#cache.set(slug, entry);
    return entry;
  }
}

// Where the major providers' `usage` objects keep their tokens: OpenAI's Responses and
// Anthropic, OpenAI's Chat Completions, the Vercel AI SDK (5 and later) and Gemini.
const IN = ["input_tokens", "prompt_tokens", "inputTokens", "promptTokenCount"];
const OUT = ["output_tokens", "completion_tokens", "outputTokens", "candidatesTokenCount"];

function tokens(usage: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && value >= 0 && Number.isFinite(value)) return value;
  }
  return 0;
}

function add(counts: number[] | undefined, index: number, amount: number): void {
  if (counts) counts[index] = (counts[index] ?? 0) + amount;
}

export async function errorFromResponse(response: Response): Promise<PromptHelmError> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  const message = body?.error?.message ?? `HTTP ${response.status}`;
  const code =
    response.status === 401 || response.status === 403
      ? "unauthorized"
      : response.status === 404
        ? "not_found"
        : "server";
  return new PromptHelmError(code, message, response.status);
}

/** `process` doesn't exist in every runtime the SDK may be bundled for. */
function env(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env[name] || undefined;
}

function toPromptHelmError(error: unknown): PromptHelmError {
  if (error instanceof PromptHelmError) return error;
  return new PromptHelmError("server", error instanceof Error ? error.message : String(error));
}
