import type { PromptConfig, Resolved } from "./client";

// Request builders, one per API a version can be called with. Each takes what `resolve` returned
// and your own request (your model, your history, your tools…), and returns that request with
// the version's messages and settings put where that API wants them. They import no provider
// package and call nothing: the result goes to your provider's own SDK, with your keys.
// What the dashboard left unset stays yours; what it set wins, then its extra parameters, then
// yours. A fallback carries no settings, so it leaves your request as it was, messages aside.

/** The second argument of `create()` in the OpenAI and Anthropic SDKs. */
export interface RequestOptions {
  /** In ms. */
  timeout?: number;
  maxRetries?: number;
}

export interface ModelRequest<T> {
  /** Your request with the version's messages and settings in. */
  params: T;
  /** Empty unless the dashboard set a timeout or retries. */
  options: RequestOptions;
}

type Obj = Record<string, unknown>;

const obj = (value: unknown): Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};

/** The dashboard's numbers, as the OpenAI and Anthropic SDKs take them per request. */
function requestOptions(c: PromptConfig): RequestOptions {
  const options: RequestOptions = {};
  if (c.timeoutMs !== undefined) options.timeout = c.timeoutMs;
  if (c.maxRetries !== undefined) options.maxRetries = c.maxRetries;
  return options;
}

/** Sets each defined value, so an unset setting leaves yours. */
function put(target: Obj, values: Obj): Obj {
  for (const [key, value] of Object.entries(values)) if (value !== undefined) target[key] = value;
  return target;
}

/**
 * Your messages as history, the version's user message after them. A string of yours is your own
 * user message, which the version's replaces; with no user message in the version, yours stays.
 */
function turns(yours: unknown, user: string | null, wrap: (text: string) => unknown): unknown {
  if (user === null) return yours;
  return Array.isArray(yours) ? [...yours, wrap(user)] : [wrap(user)];
}

/** OpenAI's Responses API (`client.responses.create`). It takes no stop sequences. */
export function toOpenAIResponses<T extends object>(r: Resolved, base: T): ModelRequest<T> {
  const c = r.config;
  const yours = base as Obj;
  const params = put(
    { ...yours, ...c.extra },
    {
      model: c.model,
      instructions: r.system,
      // Input as text stays text; a list of items is history the user message follows.
      input:
        r.user !== null && !Array.isArray(yours.input)
          ? r.user
          : turns(yours.input, r.user, userMessage),
      max_output_tokens: c.maxTokens,
      temperature: c.temperature,
      text: c.response && {
        ...obj(yours.text),
        format: {
          type: "json_schema",
          name: c.response.name,
          schema: c.response.schema,
          strict: true,
        },
      },
    },
  );
  return { params: params as T, options: requestOptions(c) };
}

/**
 * Chat Completions (`client.chat.completions.create`), OpenAI's and every compatible host's. Your
 * own system message gives way to the version's.
 */
export function toChatCompletions<T extends object>(r: Resolved, base: T): ModelRequest<T> {
  const c = r.config;
  const yours = base as Obj;
  const history = (Array.isArray(yours.messages) ? yours.messages : []).filter((m) => {
    const role = obj(m).role;
    return role !== "system" && role !== "developer";
  });
  // OpenAI and Azure took `max_completion_tokens` in place of `max_tokens`; the other hosts
  // still read `max_tokens`.
  const own = c.provider === "openai" || c.provider === "azure";
  const params = put(
    { ...yours, ...c.extra },
    {
      model: c.model,
      messages: [
        { role: "system", content: r.system },
        ...(turns(history, r.user, userMessage) as unknown[]),
      ],
      [own ? "max_completion_tokens" : "max_tokens"]: c.maxTokens,
      temperature: c.temperature,
      stop: c.stop,
      response_format: c.response && {
        type: "json_schema",
        json_schema: { name: c.response.name, schema: c.response.schema, strict: true },
      },
    },
  );
  return { params: params as T, options: requestOptions(c) };
}

/** Anthropic's Messages API (`client.messages.create`), on Anthropic or a cloud. */
export function toAnthropic<T extends object>(r: Resolved, base: T): ModelRequest<T> {
  const c = r.config;
  const yours = base as Obj;
  const params = put(
    { ...yours, ...c.extra },
    {
      model: c.model,
      system: r.system,
      messages: turns(yours.messages, r.user, userMessage),
      max_tokens: c.maxTokens,
      temperature: c.temperature,
      stop_sequences: c.stop,
      output_config: c.response && {
        ...obj(yours.output_config),
        format: { type: "json_schema", schema: c.response.schema },
      },
    },
  );
  return { params: params as T, options: requestOptions(c) };
}

/**
 * Gemini's `generateContent` (`ai.models.generateContent`, `@google/genai`), on the Gemini API or
 * Vertex AI. Everything goes in the request, timeout and extra parameters too; retries are the
 * client's (`clientOptions`).
 */
export function toGemini<T extends object>(r: Resolved, base: T): ModelRequest<T> {
  const c = r.config;
  const yours = base as Obj;
  const config = obj(yours.config);
  const http = obj(config.httpOptions);
  const params = put(
    { ...yours },
    {
      model: c.model,
      contents: turns(yours.contents, r.user, (text) => ({ role: "user", parts: [{ text }] })),
      config: put(
        { ...config },
        {
          systemInstruction: r.system,
          maxOutputTokens: c.maxTokens,
          temperature: c.temperature,
          stopSequences: c.stop,
          responseMimeType: c.response && "application/json",
          responseJsonSchema: c.response?.schema,
          httpOptions:
            c.timeoutMs !== undefined || c.extra
              ? put(
                  { ...http },
                  {
                    timeout: c.timeoutMs,
                    extraBody: c.extra && { ...obj(http.extraBody), ...c.extra },
                  },
                )
              : undefined,
        },
      ),
    },
  );
  return { params: params as T, options: {} };
}

/**
 * Bedrock's Converse API: the input of `new ConverseCommand(…)`. The schema goes as text, as
 * Converse takes it; extra parameters go in `additionalModelRequestFields`. Timeout and retries
 * are the client's (`clientOptions`).
 */
export function toBedrockConverse<T extends object>(r: Resolved, base: T): ModelRequest<T> {
  const c = r.config;
  const yours = base as Obj;
  const inference = obj(yours.inferenceConfig);
  const params = put(
    { ...yours },
    {
      modelId: c.model,
      system: [{ text: r.system }],
      messages: turns(yours.messages, r.user, (text) => ({ role: "user", content: [{ text }] })),
      inferenceConfig:
        c.maxTokens !== undefined || c.temperature !== undefined || c.stop
          ? put(
              { ...inference },
              { maxTokens: c.maxTokens, temperature: c.temperature, stopSequences: c.stop },
            )
          : undefined,
      outputConfig: c.response && {
        ...obj(yours.outputConfig),
        textFormat: {
          type: "json_schema",
          structure: {
            jsonSchema: { name: c.response.name, schema: JSON.stringify(c.response.schema) },
          },
        },
      },
      additionalModelRequestFields: c.extra && {
        ...obj(yours.additionalModelRequestFields),
        ...c.extra,
      },
    },
  );
  return { params: params as T, options: {} };
}

/**
 * Your client's options with what the dashboard set for reaching the provider: its address,
 * Region or location, timeout and retries, in the names that API's official SDK uses. Keys stay
 * yours. It builds for the API the call named (`resolve`'s `api`), else the first the version's
 * model takes. Build a client from it when the version's `config.connection` changes.
 */
export function clientOptions<T extends object>(r: Resolved, base: T): T {
  const c = r.config;
  const to = c.connection ?? {};
  const out: Obj = { ...(base as Obj) };
  const trimmed = (url: string) => url.replace(/\/+$/, "");
  // The API the call asked for, else the first the version's model takes.
  switch (r.api ?? c.apis?.[0]) {
    case "openai-responses":
    case "chat-completions": {
      // Foundry's OpenAI models are under its resource's /openai/v1; Databricks' under
      // /serving-endpoints.
      const baseURL =
        to.baseUrl ??
        (c.provider === "azure" && to.endpointUrl
          ? withPath(trimmed(to.endpointUrl), "/openai/v1/")
          : c.provider === "databricks" && to.workspaceUrl
            ? withPath(trimmed(to.workspaceUrl), "/serving-endpoints")
            : undefined);
      return put(out, { baseURL, ...requestOptions(c) }) as T;
    }
    case "anthropic-messages": {
      const baseURL =
        to.baseUrl ??
        (c.provider === "azure" && to.endpointUrl
          ? withPath(trimmed(to.endpointUrl), "/anthropic/")
          : undefined);
      // Anthropic's Vertex client takes the location as `region`.
      const region = c.provider === "google-vertex" ? to.location : undefined;
      return put(out, { baseURL, region, ...requestOptions(c) }) as T;
    }
    case "gemini": {
      const http = obj(out.httpOptions);
      const httpOptions =
        to.baseUrl !== undefined || c.timeoutMs !== undefined || c.maxRetries !== undefined
          ? put(
              { ...http },
              {
                baseUrl: to.baseUrl,
                timeout: c.timeoutMs,
                retryOptions:
                  c.maxRetries !== undefined
                    ? { ...obj(http.retryOptions), attempts: c.maxRetries + 1 }
                    : undefined,
              },
            )
          : undefined;
      const vertex = c.provider === "google-vertex";
      return put(out, {
        vertexai: vertex || undefined,
        location: vertex ? to.location : undefined,
        httpOptions,
      }) as T;
    }
    case "bedrock-converse": {
      // Without throwOnRequestTimeout the AWS SDK only warns when the time is up.
      const handler = obj(out.requestHandler);
      return put(out, {
        region: to.region,
        endpoint: to.endpointUrl,
        maxAttempts: c.maxRetries !== undefined ? c.maxRetries + 1 : undefined,
        requestHandler:
          c.timeoutMs !== undefined
            ? { ...handler, requestTimeout: c.timeoutMs, throwOnRequestTimeout: true }
            : undefined,
      }) as T;
    }
    default:
      return out as T;
  }
}

/** A resource's address with the API's path, unless the address already has one. */
function withPath(url: string, path: string): string {
  return /^https?:\/\/[^/]+\/./.test(url) ? url : `${url}${path}`;
}

function userMessage(text: string) {
  return { role: "user", content: text };
}
