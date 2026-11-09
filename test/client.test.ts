import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_HEADER,
  type PromptExperiment,
  PromptHelm,
  PromptHelmError,
  RESULTS_HEADER,
} from "../src";
import { bucket, fnv1a32 } from "../src/experiment";

const KEY = "ph_test";
const TTL = 60_000;

/** Stands in for the API: one prompt, "greeting", with ETag support. */
function fakeApi() {
  let live = { version: 1, content: "Hello {{name}}" };
  let experiment: PromptExperiment | undefined;
  let down = false;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    if (down) throw new TypeError("fetch failed");
    if (headers.authorization !== `Bearer ${KEY}`) {
      return Response.json(
        { error: { code: "unauthorized", message: "Invalid API key" } },
        { status: 401 },
      );
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
  /** The counts a request should carry for calls with these units, under exp-1 at 20%. */
  const counted = (calls: string[]) => {
    const variant = calls.filter((unit) => onVariant(unit)).length;
    return `exp-1;1=${calls.length - variant},0;2=${variant},0`;
  };
  /** The results header each request carried, in order. */
  const results = (api: ReturnType<typeof fakeApi>) =>
    api.fetch.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>)[RESULTS_HEADER] ?? null,
    );
  const client = (
    api: ReturnType<typeof fakeApi>,
    options: { reportFallbacks?: boolean; reportResults?: boolean; onError?: () => void } = {},
  ) =>
    new PromptHelm({
      apiKey: KEY,
      baseUrl: "https://ph.test",
      ttl: TTL,
      fetch: api.fetch,
      onError: () => {},
      ...options,
    });
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

  it("serves the live version and sends no counts when nothing is being tested", async () => {
    const api = fakeApi();
    const ph = client(api);
    await expect(
      ph.resolve("greeting", { vars: { name: "Ayşe" }, unit: "user-1" }),
    ).resolves.toEqual({ text: "Hello Ayşe", version: 1 });
    vi.advanceTimersByTime(TTL);
    await call(ph, "user-1");
    expect(results(api)).toEqual([null, null]);
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
      ).resolves.toEqual({ text: "Hello x", version: 1 });
    }
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

  it("serves the live version, not the fallback, when the variant needs a variable the call doesn't pass", async () => {
    const api = fakeApi();
    api.experiment({ weight: 99, content: "Hi {{name}} from {{city}}" });
    const onError = vi.fn();
    const ph = client(api, { onError });

    await expect(
      ph.resolve("greeting", { vars: { name: "Ayşe" }, unit: "user-1", fallback: "Hey" }),
    ).resolves.toEqual({ text: "Hello Ayşe", version: 1 });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "missing_variables" }),
      "greeting",
    );

    vi.advanceTimersByTime(TTL);
    await call(ph, "user-1");
    const refresh = api.fetch.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(refresh[FALLBACK_HEADER]).toBeUndefined(); // the app got its prompt: no fallback
    expect(refresh[RESULTS_HEADER]).toBe("exp-1;1=1,0;2=0,1");
  });

  it("serves the fallback when the live version can't be filled in either", async () => {
    const api = fakeApi();
    api.publish("Hello {{name}} from {{city}}");
    api.experiment({ weight: 99, content: "Hi {{name}} in {{city}}" });
    const ph = client(api);

    await expect(
      ph.resolve("greeting", { vars: { name: "Ayşe" }, unit: "user-1", fallback: "Hey {{name}}" }),
    ).resolves.toEqual({ text: "Hey Ayşe", version: null });
    vi.advanceTimersByTime(TTL);
    await ph.get("greeting", { vars: { name: "Ayşe" }, unit: "user-1", fallback: "Hey" });
    await settle();

    const refresh = api.fetch.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(refresh[FALLBACK_HEADER]).toBe("missing_variables");
    expect(refresh[RESULTS_HEADER]).toBeUndefined();
  });

  it("sends the counts with the next request for the slug, once", async () => {
    const api = fakeApi();
    api.experiment({ weight: 20, content: "Hi {{name}}" });
    const ph = client(api);
    const batch = units.slice(0, 50);
    for (const unit of batch) await ph.get("greeting", { vars: { name: "x" }, unit });
    vi.advanceTimersByTime(TTL);

    await call(ph, "user-0"); // its refresh carries the 50; its own count waits for the next
    await call(ph, "user-0");
    expect(results(api)).toEqual([null, counted(batch), counted(["user-0"])]);
  });

  it("keeps the counts when the request carrying them fails", async () => {
    const api = fakeApi();
    api.experiment({ weight: 20, content: "Hi {{name}}" });
    const ph = client(api);

    await call(ph, "user-1");
    api.setDown(true);
    await call(ph, "user-2"); // its refresh fails with user-1's count
    api.setDown(false);
    await call(ph, "user-3");
    expect(results(api)).toEqual([null, counted(["user-1"]), counted(["user-1", "user-2"])]);
  });

  it("drops an ended experiment's unsent counts once another one is served", async () => {
    const api = fakeApi();
    api.experiment({ weight: 20, content: "Hi {{name}}" });
    const ph = client(api);

    await call(ph, "user-1");
    api.experiment({ id: "exp-2", weight: 20, content: "Hi {{name}}" });
    // Its refresh carries user-1 and brings exp-2; user-2 itself is counted for exp-1.
    await ph.get("greeting", { vars: { name: "x" }, unit: "user-2" });
    await settle();
    // Within the ttl, under exp-2: user-2's unsent count is dropped.
    await ph.get("greeting", { vars: { name: "x" }, unit: "user-3" });
    vi.advanceTimersByTime(TTL);
    await call(ph, "user-4");

    const exp2 = bucket("exp-2", "user-3") < 20 ? "1=0,0;2=1,0" : "1=1,0;2=0,0";
    expect(results(api)).toEqual([null, counted(["user-1"]), `exp-2;${exp2}`]);
  });

  it.each([
    [{ reportResults: false }, false],
    [{ reportFallbacks: false }, false],
    [{ reportFallbacks: false, reportResults: true }, true],
  ])("with %o, sends counts: %s", async (options, sends) => {
    const api = fakeApi();
    api.experiment({ weight: 20, content: "Hi {{name}}" });
    const ph = client(api, options);
    await call(ph, "user-1");
    await call(ph, "user-1");
    expect(results(api)).toEqual([null, sends ? counted(["user-1"]) : null]);
  });
});
