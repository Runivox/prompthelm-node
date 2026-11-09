import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_HEADER,
  LATENCY_BUCKETS,
  latencyBucket,
  type PromptExperiment,
  PromptHelm,
  PromptHelmError,
  type ReportPayload,
  type ResolveEvent,
} from "../src";
import { bucket, fnv1a32 } from "../src/experiment";

const KEY = "ph_test";
const TTL = 60_000;

/** Stands in for the API: one prompt, "greeting", with ETag support. */
function fakeApi() {
  let live = { version: 1, content: "Hello {{name}}" };
  let experiment: PromptExperiment | undefined;
  let down = false;
  let reportStatus = 204;
  const reports: ReportPayload[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    if (down) throw new TypeError("fetch failed");
    if (headers.authorization !== `Bearer ${KEY}`) {
      return Response.json(
        { error: { code: "unauthorized", message: "Invalid API key" } },
        { status: 401 },
      );
    }
    if (String(input).endsWith("/v1/reports")) {
      if (reportStatus < 300) reports.push(JSON.parse(String(init?.body)) as ReportPayload);
      return new Response(null, { status: reportStatus });
    }
    if (!String(input).endsWith("/v1/prompts/greeting")) {
      return Response.json(
        { error: { code: "not_found", message: "Prompt not found" } },
        { status: 404 },
      );
    }
    const etag = experiment
      ? `"v${live.version}-${experiment.id}-${experiment.weight}"`
      : `"v${live.version}"`;
    if (headers["if-none-match"] === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return Response.json(
      { slug: "greeting", version: live.version, content: live.content, variables: [], experiment },
      { headers: { etag } },
    );
  });
  return {
    fetch,
    /** The reports PromptHelm accepted, in order. */
    reports,
    /** How PromptHelm answers a report: 204, or an error status. */
    answerReports(status: number) {
      reportStatus = status;
    },
    publish(content: string) {
      live = { version: live.version + 1, content };
    },
    /** Runs an A/B test with `content` as the next version, or ends it. */
    experiment(test: { id?: string; weight: number; content: string } | undefined) {
      experiment = test && {
        id: test.id ?? "exp-1",
        weight: test.weight,
        variant: { version: live.version + 1, content: test.content, variables: [] },
      };
    },
    setDown(value: boolean) {
      down = value;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("PromptHelm.get", () => {
  let api: ReturnType<typeof fakeApi>;
  let onError: ReturnType<typeof vi.fn<(error: PromptHelmError, slug: string) => void>>;
  let ph: PromptHelm;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    api = fakeApi();
    onError = vi.fn();
    ph = new PromptHelm({
      apiKey: KEY,
      baseUrl: "https://ph.test/",
      ttl: TTL,
      fetch: api.fetch,
      onError,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the live version with variables filled in", async () => {
    await expect(ph.get("greeting", { vars: { name: "Ayşe" } })).resolves.toBe("Hello Ayşe");
    expect(api.fetch).toHaveBeenCalledWith(
      "https://ph.test/v1/prompts/greeting",
      expect.anything(),
    );
  });

  it("serves from cache within the ttl", async () => {
    await ph.get("greeting", { vars: { name: "a" } });
    vi.advanceTimersByTime(TTL - 1);
    await ph.get("greeting", { vars: { name: "b" } });
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });

  it("after the ttl, answers from cache and picks up a new version in the background", async () => {
    await ph.get("greeting", { vars: { name: "Ayşe" } });
    api.publish("Merhaba {{name}}");
    vi.advanceTimersByTime(TTL);

    await expect(ph.get("greeting", { vars: { name: "Ayşe" } })).resolves.toBe("Hello Ayşe");
    await settle();
    await expect(ph.get("greeting", { vars: { name: "Ayşe" } })).resolves.toBe("Merhaba Ayşe");
  });

  it("revalidates with the ETag and keeps the prompt on 304", async () => {
    await ph.get("greeting", { vars: { name: "Ayşe" } });
    vi.advanceTimersByTime(TTL);
    await ph.get("greeting", { vars: { name: "Ayşe" } });
    await settle();

    const revalidation = api.fetch.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(revalidation["if-none-match"]).toBe('"v1"');
    await expect(ph.get("greeting", { vars: { name: "Ayşe" } })).resolves.toBe("Hello Ayşe");
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent first requests into one", async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() => ph.get("greeting", { vars: { name: "x" } })),
    );
    expect(results).toEqual(["Hello x", "Hello x", "Hello x"]);
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the fallback when PromptHelm is unreachable, and reports it", async () => {
    api.setDown(true);
    await expect(
      ph.get("greeting", { vars: { name: "Ayşe" }, fallback: "Hi {{name}}" }),
    ).resolves.toBe("Hi Ayşe");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "network" }), "greeting");
  });

  it("throws when PromptHelm is unreachable and there is no fallback", async () => {
    api.setDown(true);
    await expect(ph.get("greeting", { vars: { name: "Ayşe" } })).rejects.toMatchObject({
      code: "network",
    });
  });

  it("keeps serving the cached prompt through an outage and retries once per ttl", async () => {
    await ph.get("greeting", { vars: { name: "Ayşe" } });
    api.setDown(true);
    vi.advanceTimersByTime(TTL);

    await expect(ph.get("greeting", { vars: { name: "Ayşe" } })).resolves.toBe("Hello Ayşe");
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);

    await ph.get("greeting", { vars: { name: "Ayşe" } });
    await settle();
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });

  it("falls back when the live version needs a variable the code doesn't pass", async () => {
    api.publish("Hello {{name}} from {{city}}");
    await expect(
      ph.get("greeting", { vars: { name: "Ayşe" }, fallback: "Hello {{name}}" }),
    ).resolves.toBe("Hello Ayşe");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "missing_variables" }),
      "greeting",
    );
  });

  it("reports an unknown slug as not_found", async () => {
    await expect(ph.get("nope")).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("reports a bad key as unauthorized", async () => {
    const wrong = new PromptHelm({
      apiKey: "ph_wrong",
      baseUrl: "https://ph.test",
      fetch: api.fetch,
    });
    await expect(wrong.get("greeting")).rejects.toMatchObject({
      code: "unauthorized",
      message: "Invalid API key",
    });
  });

  it("gives up after the timeout", async () => {
    const hanging = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const slow = new PromptHelm({ apiKey: KEY, timeout: 10, fetch: hanging });
    await expect(slow.get("greeting")).rejects.toBeInstanceOf(PromptHelmError);
    await expect(slow.get("greeting")).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("PromptHelm configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the key and base URL from the environment", async () => {
    vi.stubEnv("PROMPTHELM_API_KEY", KEY);
    vi.stubEnv("PROMPTHELM_BASE_URL", "http://localhost:3000/");
    const api = fakeApi();
    const ph = new PromptHelm({ fetch: api.fetch });
    await expect(ph.get("greeting", { vars: { name: "Ayşe" } })).resolves.toBe("Hello Ayşe");
    expect(api.fetch).toHaveBeenCalledWith(
      "http://localhost:3000/v1/prompts/greeting",
      expect.anything(),
    );
  });

  it("prefers options over the environment", async () => {
    vi.stubEnv("PROMPTHELM_API_KEY", "ph_from_env");
    const api = fakeApi();
    const ph = new PromptHelm({ apiKey: KEY, baseUrl: "https://ph.test", fetch: api.fetch });
    await expect(ph.get("greeting", { vars: { name: "x" } })).resolves.toBe("Hello x");
  });

  it("explains a missing key", () => {
    vi.stubEnv("PROMPTHELM_API_KEY", "");
    expect(() => new PromptHelm()).toThrow("pass apiKey or set PROMPTHELM_API_KEY");
  });
});

describe("reporting fallbacks", () => {
  /** The fallback report each request carried, in order. */
  const reports = (api: ReturnType<typeof fakeApi>) =>
    api.fetch.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>)[FALLBACK_HEADER] ?? null,
    );
  const client = (api: ReturnType<typeof fakeApi>, options: { reportFallbacks?: boolean } = {}) =>
    new PromptHelm({
      apiKey: KEY,
      baseUrl: "https://ph.test",
      ttl: TTL,
      fetch: api.fetch,
      onError: () => {},
      ...options,
    });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says why the live text wasn't served, on the next request, until the code is fixed", async () => {
    const api = fakeApi();
    api.publish("Hello {{name}} from {{city}}");
    const ph = client(api);
    const get = async (vars: Record<string, string>) => {
      await ph.get("greeting", { vars, fallback: "Hi" });
      await settle();
      vi.advanceTimersByTime(TTL);
    };

    await get({ name: "Ayşe" }); // the live version needs {{city}}: fallback
    await get({ name: "Ayşe" }); // still failing while its refresh carries the first report
    await get({ name: "Ayşe", city: "İzmir" }); // fixed; this refresh carries the second
    await get({ name: "Ayşe", city: "İzmir" });
    expect(reports(api)).toEqual([null, "missing_variables", "missing_variables", null]);
  });

  it("reports an outage once PromptHelm answers again", async () => {
    const api = fakeApi();
    const ph = client(api);
    const get = async () => {
      await ph.get("greeting", { vars: { name: "Ayşe" } });
      await settle();
      vi.advanceTimersByTime(TTL);
    };

    await get();
    api.setDown(true);
    await get(); // the refresh fails and the cached text is served
    api.setDown(false);
    await get();
    await get();
    expect(reports(api)).toEqual([null, null, "network", null]);
  });

  it("sends nothing when told not to", async () => {
    const api = fakeApi();
    api.publish("Hello {{name}} from {{city}}");
    const ph = client(api, { reportFallbacks: false });
    for (let i = 0; i < 3; i++) {
      await ph.get("greeting", { vars: { name: "Ayşe" }, fallback: "Hi" });
      await settle();
      vi.advanceTimersByTime(TTL);
    }
    expect(reports(api)).toEqual([null, null, null]);
  });
});

describe("A/B tests", () => {
  const units = Array.from({ length: 10_000 }, (_, i) => `user-${i}`);
  const onVariant = (unit: string, weight = 20) => bucket("exp-1", unit) < weight;
  const client = (
    api: ReturnType<typeof fakeApi>,
    options: ConstructorParameters<typeof PromptHelm>[0] = {},
  ) =>
    new PromptHelm({
      apiKey: KEY,
      baseUrl: "https://ph.test",
      ttl: TTL,
      fetch: api.fetch,
      onError: () => {},
      ...options,
    });
  /** One field of what PromptHelm received for a version, summed over every report. */
  const received = (
    api: ReturnType<typeof fakeApi>,
    version: number,
    field: Exclude<keyof ReportPayload["experiments"][number]["versions"][string], "latency">,
    { id = "exp-1", weight = 20 } = {},
  ) =>
    api.reports
      .flatMap((report) => report.experiments)
      .filter((experiment) => experiment.id === id && experiment.weight === weight)
      .reduce((sum, experiment) => sum + (experiment.versions[version]?.[field] ?? 0), 0);
  /** One call, its background refresh settled, then the ttl passes. */
  const call = async (ph: PromptHelm, unit: string) => {
    await ph.get("greeting", { vars: { name: "x" }, unit });
    await settle();
    vi.advanceTimersByTime(TTL);
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("picks buckets as every PromptHelm SDK must: FNV-1a over the UTF-8 bytes", () => {
    // Computed independently of this code.
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
    expect(fnv1a32("ş")).toBe(0x708f5f4d);
    expect(bucket("exp-1", "user-1")).toBe(33);
    expect(bucket("9b2e7c1e-8d4f-4a57-9b0e-3f1d2c4a5b6c", 42)).toBe(66);
  });

  it("files durations in latency buckets that end at 50·2^(i/2) ms", () => {
    expect(latencyBucket(0)).toBe(0);
    expect(latencyBucket(49.9)).toBe(0);
    for (let i = 1; i < LATENCY_BUCKETS; i++) {
      const upTo = 50 * 2 ** (i / 2);
      expect(latencyBucket(upTo * 0.999)).toBe(i);
      if (i < LATENCY_BUCKETS - 1) expect(latencyBucket(upTo * 1.001)).toBe(i + 1);
    }
    expect(latencyBucket(10 ** 9)).toBe(LATENCY_BUCKETS - 1);
  });

  it("serves the live version and reports nothing when nothing is being tested", async () => {
    const api = fakeApi();
    const ph = client(api);
    const resolved = await ph.resolve("greeting", { vars: { name: "Ayşe" }, unit: "user-1" });
    expect(resolved).toMatchObject({ text: "Hello Ayşe", version: 1, ticket: null });
    resolved.outcome(true);
    resolved.usage({ input_tokens: 10 });
    await ph.flush();
    expect(api.reports).toEqual([]);
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });

  it("gives a unit the same version every time, and the variant about its share", async () => {
    const api = fakeApi();
    api.experiment({ weight: 20, content: "Hi {{name}}" });
    const ph = client(api);

    let variant = 0;
    for (const unit of units) {
      const { text, version } = await ph.resolve("greeting", { vars: { name: "x" }, unit });
      expect([text, version]).toEqual(onVariant(unit) ? ["Hi x", 2] : ["Hello x", 1]);
      if (version === 2) variant++;
    }
    expect(variant / units.length).toBeGreaterThan(0.18);
    expect(variant / units.length).toBeLessThan(0.22);
    // user-1 is in bucket 33: the live version at 20%, every time.
    for (let i = 0; i < 3; i++) {
      await expect(
        ph.resolve("greeting", { vars: { name: "x" }, unit: "user-1" }),
      ).resolves.toMatchObject({ text: "Hello x", version: 1 });
    }

    await ph.flush();
    expect(received(api, 1, "served") + received(api, 2, "served")).toBe(units.length + 3);
    expect(received(api, 2, "served")).toBe(variant);
  });

  it("moves units only from the live version to the variant when its share grows", async () => {
    const api = fakeApi();
    api.experiment({ weight: 20, content: "Hi {{name}}" });
    const ph = client(api);
    const assign = async () => {
      const versions = new Map<string, number | null>();
      for (const unit of units.slice(0, 2_000)) {
        versions.set(unit, (await ph.resolve("greeting", { vars: { name: "x" }, unit })).version);
      }
      return versions;
    };

    const before = await assign();
    api.experiment({ weight: 30, content: "Hi {{name}}" });
    vi.advanceTimersByTime(TTL);
    await call(ph, "user-1");
    const after = await assign();

    const left = [...before].filter(([unit, version]) => version === 2 && after.get(unit) !== 2);
    expect(left).toEqual([]);
    const onB = (versions: Map<string, number | null>) =>
      [...versions.values()].filter((version) => version === 2).length;
    expect(onB(after)).toBeGreaterThan(onB(before));
  });

  it("counts calls under each share apart, so a changed share doesn't mix them", async () => {
    const api = fakeApi();
    api.experiment({ weight: 20, content: "Hi {{name}}" });
    const ph = client(api);
    await call(ph, "user-1");
    api.experiment({ weight: 30, content: "Hi {{name}}" });
    await call(ph, "user-2"); // still served under 20%; its refresh brings 30%
    await call(ph, "user-3");
    await ph.flush();

    const at = (weight: number) =>
      received(api, 1, "served", { weight }) + received(api, 2, "served", { weight });
    expect([at(20), at(30)]).toEqual([2, 1]);
  });

  it("serves the live version, not the fallback, when the variant needs a variable the call doesn't pass", async () => {
    const api = fakeApi();
    api.experiment({ weight: 99, content: "Hi {{name}} from {{city}}" });
    const onError = vi.fn();
    const ph = client(api, { onError });

    await expect(
      ph.resolve("greeting", { vars: { name: "Ayşe" }, unit: "user-1", fallback: "Hey" }),
    ).resolves.toMatchObject({ text: "Hello Ayşe", version: 1 });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "missing_variables" }),
      "greeting",
    );

    vi.advanceTimersByTime(TTL);
    await call(ph, "user-1");
    const refresh = api.fetch.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(refresh[FALLBACK_HEADER]).toBeUndefined(); // the app got its prompt: no fallback
    await ph.flush();
    const at = { weight: 99 };
    expect([received(api, 1, "served", at), received(api, 2, "skipped", at)]).toEqual([2, 2]);
    expect(received(api, 2, "served", at)).toBe(0);
  });

  it("serves the fallback when the live version can't be filled in either", async () => {
    const api = fakeApi();
    api.publish("Hello {{name}} from {{city}}");
    api.experiment({ weight: 99, content: "Hi {{name}} in {{city}}" });
    const ph = client(api);

    const resolved = await ph.resolve("greeting", {
      vars: { name: "Ayşe" },
      unit: "user-1",
      fallback: "Hey {{name}}",
    });
    expect(resolved).toMatchObject({ text: "Hey Ayşe", version: null, ticket: null });
    vi.advanceTimersByTime(TTL);
    await ph.get("greeting", { vars: { name: "Ayşe" }, unit: "user-1", fallback: "Hey" });
    await settle();
    await ph.flush();

    const refresh = api.fetch.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(refresh[FALLBACK_HEADER]).toBe("missing_variables");
    expect(api.reports).toEqual([]);
  });

  it("reports what it counted within a ttl, once, without keeping the process alive", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const api = fakeApi();
    api.experiment({ weight: 20, content: "Hi {{name}}" });
    const ph = client(api);
    for (const unit of units.slice(0, 50)) await ph.get("greeting", { vars: { name: "x" }, unit });
    expect(api.reports).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(TTL);
    expect(api.reports).toHaveLength(1);
    expect(received(api, 1, "served") + received(api, 2, "served")).toBe(50);
    await vi.advanceTimersByTimeAsync(TTL * 3);
    expect(api.reports).toHaveLength(1);
  });

  it("keeps what a failed report carried and sends it with the next; drops what's refused", async () => {
    const api = fakeApi();
    api.experiment({ weight: 20, content: "Hi {{name}}" });
    const ph = client(api);
    const served = () => received(api, 1, "served") + received(api, 2, "served");

    await ph.get("greeting", { vars: { name: "x" }, unit: "user-1" });
    api.setDown(true);
    await ph.flush(); // unreachable
    api.setDown(false);
    api.answerReports(503);
    await ph.get("greeting", { vars: { name: "x" }, unit: "user-2" });
    await ph.flush(); // a server error
    api.answerReports(204);
    await ph.get("greeting", { vars: { name: "x" }, unit: "user-3" });
    await ph.flush();
    expect(served()).toBe(3);

    api.answerReports(400);
    await ph.get("greeting", { vars: { name: "x" }, unit: "user-4" });
    await ph.flush(); // refused: it wouldn't succeed later either
    api.answerReports(204);
    await ph.flush();
    expect(served()).toBe(3);
  });

  it("reports outcomes as scores, once per call, and ignores what isn't one", async () => {
    const api = fakeApi();
    api.experiment({ weight: 1, content: "Hi {{name}}" });
    const ph = client(api);
    const live = () => ph.resolve("greeting", { vars: { name: "x" }, unit: "user-1" });

    const first = await live();
    first.outcome(true);
    first.outcome(false); // the first report counts
    (await live()).outcome(0.25);
    (await live()).outcome(2);
    (await live()).outcome(Number.NaN);
    (await live()).outcome(false);
    await ph.flush();

    const at = { weight: 1 };
    expect(received(api, 1, "outcomes", at)).toBe(3);
    expect(received(api, 1, "scoreSum", at)).toBe(1.25);
    expect(received(api, 1, "scoreSqSum", at)).toBe(1.0625);
  });

  it("reads tokens from the major providers' usage objects and times the call", async () => {
    const api = fakeApi();
    api.experiment({ weight: 1, content: "Hi {{name}}" });
    const ph = client(api);
    const live = () => ph.resolve("greeting", { vars: { name: "x" }, unit: "user-1" });

    (await live()).usage({ prompt_tokens: 10, completion_tokens: 5 }, 40); // OpenAI Chat Completions
    (await live()).usage({ input_tokens: 7, output_tokens: 3 }, 100); // OpenAI Responses, Anthropic
    (await live()).usage({ inputTokens: 2, outputTokens: 1 }, 100); // Vercel AI SDK
    (await live()).usage({ promptTokenCount: 4, candidatesTokenCount: 6 }, 1_000); // Gemini
    const timed = await live();
    vi.advanceTimersByTime(250);
    timed.usage(undefined); // no tokens; timed since resolve
    timed.usage({ input_tokens: 99 }, 1); // the first report counts
    await ph.flush();

    const at = { weight: 1 };
    expect(received(api, 1, "usage", at)).toBe(5);
    expect(received(api, 1, "tokensIn", at)).toBe(23);
    expect(received(api, 1, "tokensOut", at)).toBe(15);
    expect(received(api, 1, "latencyMs", at)).toBe(1_490);
    const latency = api.reports[0]?.experiments[0]?.versions[1]?.latency ?? [];
    expect(latency).toHaveLength(LATENCY_BUCKETS);
    expect(latency[latencyBucket(40)]).toBe(1);
    expect(latency[latencyBucket(100)]).toBe(2);
    expect(latency[latencyBucket(250)]).toBe(1);
    expect(latency[latencyBucket(1_000)]).toBe(1);
  });

  it("takes an outcome later, from any process, by the call's ticket", async () => {
    const api = fakeApi();
    api.experiment({ weight: 20, content: "Hi {{name}}" });
    const resolved = await client(api).resolve("greeting", { vars: { name: "x" }, unit: "user-1" });
    expect(resolved.ticket).toBe("exp-1.1.20");

    const worker = client(api); // say, the process that handles the order days later
    worker.outcome(resolved.ticket ?? "", true);
    for (const ticket of ["nonsense", "exp-1.x.20", "exp-1.1.0", ".1.20"]) {
      worker.outcome(ticket, true);
    }
    await worker.flush();
    expect(received(api, 1, "outcomes")).toBe(1);
    expect(api.reports).toHaveLength(1);
  });

  it("serves a forced side without counting it, and tells onResolve which side every call got", async () => {
    const api = fakeApi();
    api.experiment({ weight: 20, content: "Hi {{name}}" });
    const events: ResolveEvent[] = [];
    const ph = client(api, { onResolve: (event) => events.push(event) });

    const team = await ph.resolve("greeting", { vars: { name: "x" }, force: "variant" });
    expect(team).toMatchObject({ text: "Hi x", version: 2, ticket: null });
    team.outcome(true);
    team.usage({ input_tokens: 5 });
    await expect(
      ph.resolve("greeting", { vars: { name: "x" }, unit: "user-0", force: "control" }),
    ).resolves.toMatchObject({ version: 1 });
    await ph.flush();
    expect(api.reports).toEqual([]);

    await ph.resolve("greeting", { vars: { name: "x" }, unit: "user-0" }); // bucket 14: variant
    expect(events).toEqual([
      { slug: "greeting", version: 2, experiment: "exp-1", variant: true },
      { slug: "greeting", version: 1, experiment: "exp-1", variant: false },
      { slug: "greeting", version: 2, experiment: "exp-1", variant: true },
    ]);
  });

  it("never lets a failing onResolve fail the call", async () => {
    const api = fakeApi();
    const ph = client(api, {
      onResolve: () => {
        throw new Error("analytics down");
      },
    });
    await expect(ph.get("greeting", { vars: { name: "x" } })).resolves.toBe("Hello x");
  });

  it("keeps an ended test's counts until they're sent", async () => {
    const api = fakeApi();
    api.experiment({ weight: 20, content: "Hi {{name}}" });
    const ph = client(api);
    await call(ph, "user-1");
    api.experiment({ id: "exp-2", weight: 20, content: "Hi {{name}}" });
    await call(ph, "user-2"); // still exp-1; its refresh brings exp-2
    await call(ph, "user-3");
    await ph.flush();

    const tested = (id: string) =>
      received(api, 1, "served", { id }) + received(api, 2, "served", { id });
    expect([tested("exp-1"), tested("exp-2")]).toEqual([2, 1]);
  });

  it.each([
    [{ reportResults: false }, false],
    [{ reportFallbacks: false }, false],
    [{ reportFallbacks: false, reportResults: true }, true],
  ])("with %o, reports: %s", async (options, sends) => {
    const api = fakeApi();
    api.experiment({ weight: 20, content: "Hi {{name}}" });
    const ph = client(api, options);
    const resolved = await ph.resolve("greeting", { vars: { name: "x" }, unit: "user-1" });
    resolved.outcome(true);
    await ph.flush();
    expect(api.reports.length > 0).toBe(sends);
  });
});
