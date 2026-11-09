import { PromptHelmError, type PromptHelmErrorCode } from "./errors";
import { render, type Vars } from "./template";

/** Not exported from the package: shared with the `pull` command. */
export const DEFAULT_BASE_URL = "https://prompthelm.app";

/** Body of `GET /v1/prompts/:slug`. The server types its response with this too. */
export interface PromptPayload {
  slug: string;
  version: number;
  content: string;
  variables: string[];
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
}

export interface GetOptions {
  vars?: Vars;
  /**
   * Served when PromptHelm can't be reached, the prompt doesn't exist, or the live
   * version uses a variable this call doesn't pass. Without it those cases throw.
   */
  fallback?: string;
}

interface Entry {
  content: string;
  etag: string | null;
  fetchedAt: number;
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
  // Per slug, why the live text last couldn't be served, until a request carries it. An object,
  // so a report made while that request is in flight isn't cleared with the one it carried.
  readonly #unreported = new Map<string, { code: PromptHelmErrorCode }>();

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
  }

  /** The live version of a prompt with its variables filled in. */
  async get(slug: string, options: GetOptions = {}): Promise<string> {
    const { vars, fallback } = options;
    try {
      const entry = await this.#entry(slug);
      return render(entry.content, vars);
    } catch (error) {
      const failure = toPromptHelmError(error);
      this.#remember(slug, failure.code);
      if (fallback === undefined) throw failure;
      this.#onError(failure, slug);
      return render(fallback, vars);
    }
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
      content: payload.content,
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
