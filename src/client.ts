import { PromptHelmError, type PromptHelmErrorCode } from "./errors";
import { bucket } from "./experiment";
import { render, type Vars } from "./template";

/** Not exported from the package: shared with the `pull` command. */
export const DEFAULT_BASE_URL = "https://prompthelm.app";

/** Body of `GET /v1/prompts/:slug`. The server types its response with this too. */
export interface PromptPayload {
  slug: string;
  version: number;
  content: string;
  variables: string[];
  /** An A/B test running on the prompt: the live version above is its control. */
  experiment?: PromptExperiment;
}

export interface PromptExperiment {
  id: string;
  /** The variant's share of calls, in percent (1–99). */
  weight: number;
  variant: { version: number; content: string; variables: string[] };
}

/**
 * Sent with the next request for a slug after `get()` couldn't serve its live text: the error's
 * code alone, never any text or variable value. The server records it for the prompt page.
 */
export const FALLBACK_HEADER = "x-prompthelm-fallback";

/**
 * Sent with the next request for a slug while an experiment runs: how many times each version was
 * served, as `<experiment id>;<version>=<served>,<skipped>` for each version (`skipped`: picked
 * for the variant, served the live version because a variable wasn't passed). Counts only, never
 * any text, variable value or unit.
 */
export const RESULTS_HEADER = "x-prompthelm-results";

/** Body of `GET /v1/prompts`: every published prompt of the key's project, by slug. */
export interface PromptListPayload {
  prompts: PromptPayload[];
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
   * Whether to tell PromptHelm, as counts only, how often each version of a prompt under an A/B
   * test was served, so the prompt's page shows the variant reaching your app. Defaults to
   * `reportFallbacks`.
   */
  reportResults?: boolean;
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
}

export interface Resolved {
  text: string;
  /** The version served, or null when the fallback was. */
  version: number | null;
}

interface Entry {
  version: number;
  content: string;
  experiment: PromptExperiment | undefined;
  etag: string | null;
  fetchedAt: number;
}

/**
 * One experiment's counts not yet sent: `[served, skipped]` for the live version (whose skipped
 * stays 0), then for the variant.
 */
interface Results {
  id: string;
  versions: [live: number, variant: number];
  counts: number[];
}

export class PromptHelm {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #ttl: number;
  readonly #timeout: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #onError: (error: PromptHelmError, slug: string) => void;
  readonly #cache = new Map<string, Entry>();
  readonly #inflight = new Map<string, Promise<Entry>>();
  readonly #reportFallbacks: boolean;
  readonly #reportResults: boolean;
  // Per slug, why the live text last couldn't be served, until a request carries it. An object,
  // so a report made while that request is in flight isn't cleared with the one it carried.
  readonly #unreported = new Map<string, { code: PromptHelmErrorCode }>();
  // Per slug, the running experiment's counts until a request carries them. A request takes them
  // out and puts them back if it fails, so counts made while it is in flight are kept.
  readonly #results = new Map<string, Results>();

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
    this.#reportFallbacks = options.reportFallbacks ?? true;
    this.#reportResults = options.reportResults ?? this.#reportFallbacks;
  }

  /** The live version of a prompt with its variables filled in. */
  async get(slug: string, options: GetOptions = {}): Promise<string> {
    return (await this.resolve(slug, options)).text;
  }

  /** Like `get`, and says which version was served, so you can tag your logs or traces with it. */
  async resolve(slug: string, options: GetOptions = {}): Promise<Resolved> {
    const { vars, fallback, unit } = options;
    try {
      return this.#pick(slug, await this.#entry(slug), vars, unit);
    } catch (error) {
      const failure = toPromptHelmError(error);
      this.#remember(slug, failure.code);
      if (fallback === undefined) throw failure;
      this.#onError(failure, slug);
      return { text: render(fallback, vars), version: null };
    }
  }

  #pick(slug: string, entry: Entry, vars?: Vars, unit?: string | number): Resolved {
    const { experiment } = entry;
    let skipped: PromptHelmError | undefined;
    if (experiment && bucket(experiment.id, unit) < experiment.weight) {
      const { version, content } = experiment.variant;
      try {
        const text = render(content, vars);
        this.#count(slug, entry, 2);
        return { text, version };
      } catch (error) {
        skipped = toPromptHelmError(error);
      }
    }
    // The live version is what the app was built for. If it can't be filled in either, the
    // caller serves the fallback and reports that instead.
    const text = render(entry.content, vars);
    if (skipped) {
      // Not a fallback, so not reported as one: the call got the live version.
      this.#onError(skipped, slug);
      this.#count(slug, entry, 3);
    }
    this.#count(slug, entry, 0);
    return { text, version: entry.version };
  }

  /** Adds one to a running experiment's count at `index` (see `Results`). */
  #count(slug: string, { version, experiment }: Entry, index: number): void {
    if (!experiment || !this.#reportResults) return;
    let results = this.#results.get(slug);
    if (results?.id !== experiment.id) {
      // A new experiment: an ended one's unsent counts are dropped.
      results = {
        id: experiment.id,
        versions: [version, experiment.variant.version],
        counts: [0, 0, 0, 0],
      };
      this.#results.set(slug, results);
    }
    results.counts[index] = (results.counts[index] ?? 0) + 1;
  }

  /** Puts back the counts a failed request carried, adding any made meanwhile. */
  #restore(slug: string, sent: Results): void {
    const pending = this.#results.get(slug);
    if (pending && pending.id !== sent.id) return;
    pending?.counts.forEach((count, index) => {
      sent.counts[index] = (sent.counts[index] ?? 0) + count;
    });
    this.#results.set(slug, sent);
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
    const results = this.#results.get(slug);
    if (results) {
      this.#results.delete(slug);
      const { id, versions, counts } = results;
      headers[RESULTS_HEADER] =
        `${id};${versions[0]}=${counts.slice(0, 2).join(",")};${versions[1]}=${counts.slice(2).join(",")}`;
    }

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/v1/prompts/${encodeURIComponent(slug)}`, {
        headers,
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch (error) {
      if (results) this.#restore(slug, results);
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
    if (!response.ok) {
      if (results) this.#restore(slug, results);
      throw await errorFromResponse(response);
    }

    const payload = (await response.json()) as PromptPayload;
    const entry = {
      version: payload.version,
      content: payload.content,
      experiment: payload.experiment,
      etag: response.headers.get("etag"),
      fetchedAt: Date.now(),
    };
    this.#cache.set(slug, entry);
    return entry;
  }
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
