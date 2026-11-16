import { describe, expect, it } from "vitest";
import {
  clientOptions,
  type PromptConfig,
  type Resolved,
  toAnthropic,
  toBedrockConverse,
  toChatCompletions,
  toGemini,
  toOpenAIResponses,
} from "../src";

/** What `resolve` hands back, without a client: messages and the version's settings. */
function resolved(config: PromptConfig, user: string | null = "Ticket: printer jams"): Resolved {
  return {
    text: "Sort the ticket.",
    system: "Sort the ticket.",
    user,
    config,
    version: config.model ? 4 : null,
    api: null,
    ticket: null,
    outcome: () => {},
    usage: () => {},
    failed: () => {},
  };
}

const schema = {
  type: "object",
  properties: { intent: { type: "string", enum: ["billing", "bug"] } },
  required: ["intent"],
  additionalProperties: false,
};
const all: PromptConfig = {
  model: "m-1",
  maxTokens: 500,
  temperature: 0.2,
  stop: ["###"],
  response: { type: "json", name: "classify_ticket", schema },
  timeoutMs: 30_000,
  maxRetries: 1,
  extra: { service_tier: "auto" },
};

describe("toOpenAIResponses", () => {
  it("puts the version's messages and settings where the Responses API wants them", () => {
    const base = { model: "gpt-default", input: "my own message", text: { verbosity: "low" } };
    expect(toOpenAIResponses(resolved(all), base)).toEqual({
      params: {
        model: "m-1",
        instructions: "Sort the ticket.",
        input: "Ticket: printer jams",
        max_output_tokens: 500,
        temperature: 0.2,
        text: {
          verbosity: "low",
          format: { type: "json_schema", name: "classify_ticket", schema, strict: true },
        },
        service_tier: "auto",
      },
      options: { timeout: 30_000, maxRetries: 1 },
    });
  });

  it("keeps your message when the version has none, and your history before its own", () => {
    expect(toOpenAIResponses(resolved({}, null), { model: "g", input: "mine" }).params).toEqual({
      model: "g",
      instructions: "Sort the ticket.",
      input: "mine",
    });
    const history = [{ role: "assistant", content: "Hi" }];
    expect(toOpenAIResponses(resolved({}), { model: "g", input: history }).params.input).toEqual([
      ...history,
      { role: "user", content: "Ticket: printer jams" },
    ]);
  });
});

describe("toChatCompletions", () => {
  it("replaces your system message, keeps your history and names the limit as the host does", () => {
    const base = {
      model: "gpt-default",
      messages: [
        { role: "system", content: "old" },
        { role: "user", content: "earlier" },
        { role: "assistant", content: "ok" },
      ],
    };
    const { params, options } = toChatCompletions(resolved({ ...all, provider: "openai" }), base);
    expect(params).toEqual({
      model: "m-1",
      messages: [
        { role: "system", content: "Sort the ticket." },
        { role: "user", content: "earlier" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "Ticket: printer jams" },
      ],
      max_completion_tokens: 500,
      temperature: 0.2,
      stop: ["###"],
      response_format: {
        type: "json_schema",
        json_schema: { name: "classify_ticket", schema, strict: true },
      },
      service_tier: "auto",
    });
    expect(options).toEqual({ timeout: 30_000, maxRetries: 1 });
    const mistral = toChatCompletions(resolved({ maxTokens: 500, provider: "mistral" }), base);
    expect(mistral.params).toMatchObject({ max_tokens: 500 });
    expect(mistral.params).not.toHaveProperty("max_completion_tokens");
  });
});

describe("toAnthropic", () => {
  it("sends the schema without a name and leaves unset settings yours", () => {
    const base = { model: "claude-default", max_tokens: 1024, messages: [] };
    const { params } = toAnthropic(
      resolved({
        model: "claude-sonnet-5-5",
        stop: ["###"],
        response: { type: "json", name: "classify_ticket", schema },
      }),
      base,
    );
    expect(params).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 1024,
      system: "Sort the ticket.",
      messages: [{ role: "user", content: "Ticket: printer jams" }],
      stop_sequences: ["###"],
      output_config: { format: { type: "json_schema", schema } },
    });
    expect(params).not.toHaveProperty("temperature");
  });
});

describe("toGemini", () => {
  it("puts settings, timeout and extra parameters in the request's config", () => {
    const base = { model: "gemini-default", config: { candidateCount: 1 } };
    expect(toGemini(resolved(all), base)).toEqual({
      params: {
        model: "m-1",
        contents: [{ role: "user", parts: [{ text: "Ticket: printer jams" }] }],
        config: {
          candidateCount: 1,
          systemInstruction: "Sort the ticket.",
          maxOutputTokens: 500,
          temperature: 0.2,
          stopSequences: ["###"],
          responseMimeType: "application/json",
          responseJsonSchema: schema,
          httpOptions: { timeout: 30_000, extraBody: { service_tier: "auto" } },
        },
      },
      options: {},
    });
  });
});

describe("toBedrockConverse", () => {
  it("sends the schema as text and extra parameters as additional model fields", () => {
    const { params } = toBedrockConverse(resolved(all), { modelId: "default", messages: [] });
    expect(params).toEqual({
      modelId: "m-1",
      system: [{ text: "Sort the ticket." }],
      messages: [{ role: "user", content: [{ text: "Ticket: printer jams" }] }],
      inferenceConfig: { maxTokens: 500, temperature: 0.2, stopSequences: ["###"] },
      outputConfig: {
        textFormat: {
          type: "json_schema",
          structure: { jsonSchema: { name: "classify_ticket", schema: JSON.stringify(schema) } },
        },
      },
      additionalModelRequestFields: { service_tier: "auto" },
    });
  });
});

it("leaves a fallback's request as yours, messages aside", () => {
  const base = { model: "claude-default", max_tokens: 1024, temperature: 0.5, messages: [] };
  expect(toAnthropic(resolved({}, null), base)).toEqual({
    params: { ...base, system: "Sort the ticket." },
    options: {},
  });
});

describe("clientOptions", () => {
  const options = (config: PromptConfig) => clientOptions(resolved(config), { apiKey: "own" });

  it("reaches Foundry's OpenAI and Claude endpoints from the resource's address", () => {
    const foundry = { endpointUrl: "https://acme.services.ai.azure.com/" };
    expect(options({ provider: "azure", apis: ["chat-completions"], connection: foundry })).toEqual(
      {
        apiKey: "own",
        baseURL: "https://acme.services.ai.azure.com/openai/v1/",
      },
    );
    expect(
      options({
        provider: "azure",
        apis: ["anthropic-messages"],
        connection: foundry,
        timeoutMs: 5,
      }),
    ).toEqual({
      apiKey: "own",
      baseURL: "https://acme.services.ai.azure.com/anthropic/",
      timeout: 5,
    });
    // An address that already has its path is taken as it is.
    expect(
      options({
        provider: "azure",
        apis: ["openai-responses"],
        connection: { endpointUrl: "https://acme.openai.azure.com/openai/v1" },
      }),
    ).toMatchObject({ baseURL: "https://acme.openai.azure.com/openai/v1" });
  });

  it("builds for the API the call named, among the ones the model takes", () => {
    const r = {
      ...resolved({
        provider: "azure",
        apis: ["openai-responses", "chat-completions", "anthropic-messages"],
        connection: { endpointUrl: "https://acme.services.ai.azure.com" },
      }),
      api: "anthropic-messages" as const,
    };
    expect(clientOptions(r, {})).toEqual({
      baseURL: "https://acme.services.ai.azure.com/anthropic/",
    });
  });

  it("names each SDK's options its own way", () => {
    expect(
      options({
        provider: "databricks",
        apis: ["chat-completions"],
        connection: { workspaceUrl: "https://w.cloud.databricks.com" },
      }),
    ).toEqual({ apiKey: "own", baseURL: "https://w.cloud.databricks.com/serving-endpoints" });
    expect(
      options({
        provider: "google-vertex",
        apis: ["anthropic-messages"],
        connection: { location: "global" },
      }),
    ).toEqual({ apiKey: "own", region: "global" });
    expect(
      options({
        provider: "google-vertex",
        apis: ["gemini"],
        connection: { location: "us-central1" },
        maxRetries: 2,
      }),
    ).toEqual({
      apiKey: "own",
      vertexai: true,
      location: "us-central1",
      httpOptions: { retryOptions: { attempts: 3 } },
    });
    expect(
      options({
        provider: "amazon-bedrock",
        apis: ["bedrock-converse"],
        connection: { region: "eu-central-1", endpointUrl: "https://vpce.example" },
        timeoutMs: 120_000,
        maxRetries: 2,
      }),
    ).toEqual({
      apiKey: "own",
      region: "eu-central-1",
      endpoint: "https://vpce.example",
      maxAttempts: 3,
      requestHandler: { requestTimeout: 120_000, throwOnRequestTimeout: true },
    });
    expect(options({ model: "x" })).toEqual({ apiKey: "own" });
  });
});
