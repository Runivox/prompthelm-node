import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_HEADER, PromptHelm, PromptHelmError } from "../src";

const KEY = "ph_test";
const TTL = 60_000;

/** Stands in for the API: one prompt, "greeting", with ETag support. */
function fakeApi() {
  let live = { version: 1, content: "Hello {{name}}" };
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
    const etag = `"v${live.version}"`;
    if (headers["if-none-match"] === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return Response.json(
      { slug: "greeting", version: live.version, content: live.content, variables: [] },
      { headers: { etag } },
    );
  });
  return {
    fetch,
    publish(content: string) {
      live = { version: live.version + 1, content };
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
