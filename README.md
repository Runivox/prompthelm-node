# @prompt-helm/sdk

Prompt management for LLM apps: fetch your [PromptHelm](https://prompthelm.app) prompts at
runtime, so changing a prompt needs no rebuild and no redeploy.

You edit and publish a prompt in the PromptHelm dashboard. Your app asks for it by name, fills
in its variables and passes the text to whichever model it already calls. Every publish is a
version that never changes, and rolling back is one click; your app follows either on its next
refresh, 60 seconds by default.

- **Never takes your app down.** With a `fallback`, every failure (timeout, network, bad key,
  missing prompt, missing variable) returns your fallback and reports through `onError`.
- **Fast after the first call.** Prompts are served from memory and refreshed in the background;
  a refresh that finds nothing new is an empty `304`.
- **Your data stays with you.** Variables are filled in on your server. PromptHelm never sees
  their values, your provider keys or your LLM traffic.
- **Model settings travel with the text.** A version can carry its model, temperature and
  output limit, so moving to a cheaper model is a publish you can roll back or A/B test.
- **No dependencies.** ESM and CommonJS, Node.js 18 and later.

## Install

```sh
npm install @prompt-helm/sdk
```

Create an API key in the dashboard and put it in your server's environment:

```sh
PROMPTHELM_API_KEY=ph_…
```

## Use

```ts
import { PromptHelm } from "@prompt-helm/sdk";

// One client for the whole app: it holds the cache.
export const ph = new PromptHelm();

const system = await ph.get("support-reply", {
  vars: { company: "Acme", customer_name: user.name },
  fallback: SUPPORT_REPLY, // the prompt you had hard-coded
});

// Pass `system` to your model exactly as you did before.
```

The stored prompt marks each variable in double braces, such as `{{customer_name}}`. If the live
version uses a variable the call doesn't pass, `get` doesn't send a half-filled prompt: it
returns the fallback (or, without one, throws `missing_variables`).

## Options

All optional when the environment variables are set.

| Option    | Default                                           | What it does                                                         |
| --------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| `apiKey`  | `PROMPTHELM_API_KEY`                              | Your project's API key. Keep it on the server.                       |
| `baseUrl` | `PROMPTHELM_BASE_URL`, then `https://prompthelm.app` | Where prompts are fetched from.                                   |
| `ttl`     | `60000`                                           | How long, in ms, a prompt is served before checking for a newer one. |
| `timeout` | `3000`                                            | How long, in ms, one request may take.                               |
| `onError` | `console.warn`                                    | Called with the error and the slug when a fallback or a cached prompt was served instead of failing. |
| `reportFallbacks` | `true`                                  | Tells PromptHelm, by error code only, when a fallback or a cached prompt was served, so the prompt's page shows which app fell back and why. |
| `reportResults` | `reportFallbacks`                           | During an [A/B test](#ab-tests), sends PromptHelm totals only: calls served per version, and the outcomes and usage you report. |
| `onResolve` | none                                              | Called on every `get` and `resolve` with the version served, for your analytics or traces. |
| `fetch`   | global `fetch`                                    | Your own fetch, for tests or a proxy.                                |

## Errors

Failures are `PromptHelmError`s with a `code`, a `message` and, for HTTP errors, a `status`.
Without a `fallback`, `get` throws them; with one, `onError` receives them.

| Code                | When                                                       |
| ------------------- | ---------------------------------------------------------- |
| `unauthorized`      | The API key is missing, wrong or revoked.                  |
| `not_found`         | The project has no published prompt with that slug.        |
| `missing_variables` | The live version uses a variable the call doesn't pass.    |
| `timeout`           | No response within the timeout.                            |
| `network`           | PromptHelm couldn't be reached.                            |
| `server`            | Anything else, such as a 5xx response.                     |

After the first successful fetch, a failed background refresh keeps serving the cached prompt
and tries again after one ttl.

When a fallback or a cached prompt was served, the next request for that slug carries the error's
code (`x-prompthelm-fallback: missing_variables`), so the prompt's page in the dashboard shows
which key fell back and why. Only the code is sent, never the text or a variable's value; pass
`reportFallbacks: false` to send nothing.

## Keep fallbacks current

A fallback is only as good as its text, and a copy kept in your code drifts from what you
publish. `pull` writes every published prompt of the project to one file, keyed by slug:

```sh
npx @prompt-helm/sdk pull --out src/prompthelm.fallbacks.ts
```

```ts
import { fallbacks } from "./prompthelm.fallbacks";

const system = await ph.get("support-reply", {
  vars: { company: "Acme", customer_name: user.name },
  fallback: fallbacks["support-reply"],
});
```

Run it in CI before the build, so every deploy carries the text that was live then. It reads
`PROMPTHELM_API_KEY` (and `PROMPTHELM_BASE_URL`), and writes JSON for a `.json` path or with
`--format json`. A prompt appears in the file once it's published.

## Model settings

A version can carry the model to call it with, its temperature and its output limit, set next to
the text in the dashboard. Moving to a cheaper model is then a publish like any other: one click
rolls it back, and an A/B test can tell whether it does as well. `resolve` hands them over with
the text:

```ts
const r = await ph.resolve("support-reply", {
  vars: { company: "Acme", customer_name: user.name },
  fallback: SUPPORT_REPLY,
});

const reply = await openai.responses.create({
  model: r.config.model ?? "gpt-5",
  temperature: r.config.temperature,
  max_output_tokens: r.config.maxTokens,
  input: r.text,
});
```

`config` holds only the settings set in the dashboard (`model`, `temperature`, `maxTokens`), so
keep your defaults in the code; when the fallback is served it is empty. PromptHelm doesn't check
a model name with your provider, and a name your provider doesn't know fails your calls: try a new
model in an A/B test first. Apps on SDK versions before 1.4 ignore the settings.

## A/B tests

On the Pro plan, a prompt's page can run an experiment: the live version keeps most calls and a
variant gets the share you pick. The SDK picks the version for each call on your server. Pass a
`unit`, such as a user or conversation id, and that unit gets the same version every time;
without one, each call is picked at random. Use `resolve` to learn which version a call got, and
tell PromptHelm how it went:

```ts
const r = await ph.resolve("support-reply", {
  vars: { company: "Acme", customer_name: user.name },
  fallback: SUPPORT_REPLY,
  unit: user.id,
});

const reply = await openai.responses.create({ model: r.config.model ?? "gpt-5", input: r.text });
r.usage(reply.usage); // tokens, and how long the call took since resolve
r.outcome(userKeptTheReply); // true or false, or a score from 0 to 1
```

The prompt's page then compares the two versions: how often each succeeded, with a range that
stays honest however often you look, and their tokens and latency per call. It says when there's
an answer; shipping the variant stays your call. Each version brings its own
[model settings](#model-settings), so a test can compare two models as well as two texts.

- **Outcomes that come later.** A purchase days later, in another service: keep `r.ticket` with
  your own record, then call `ph.outcome(ticket, true)` from any process. The ticket names the
  test and the version, not the user.
- **Your own analytics.** `onResolve` is called on every `get` and `resolve` with the slug, the
  version, the test and whether the call got the variant, so your events or traces can carry it:
  `new PromptHelm({ onResolve: (e) => posthog.capture("prompt_served", e) })`.
- **Your team first.** `force: "variant"` (or `"control"`) serves that side to a call, such as
  to your own staff. Forced calls are never counted.
- **Serverless.** Counts are sent within a ttl. A function that freezes after its response
  should `await ph.flush()` first (with `waitUntil`, where the platform has it).
- **Usage objects** from OpenAI (Responses and Chat Completions), Anthropic, the Vercel AI SDK
  and Gemini are read as they are. `r.usage(null, ms)` reports a duration alone.

Only totals reach PromptHelm: how many calls each version served, the outcomes, tokens and
durations you report. Never the text, a variable's value or the unit. Counts a process holds
when it exits are lost, so read them as a sample. `reportResults: false` sends none; unless you
set it, it follows `reportFallbacks`.

If the variant uses a variable the call doesn't pass, that call gets the live version and
`onError` receives `missing_variables`; it isn't reported as a fallback. Growing the variant's
share only moves units from the live version to the variant, never back. Apps on SDK versions
before 1.3 ignore experiments and serve the live version to every call.

To split calls the same way from another language: during an experiment the response carries
`experiment: { id, weight, variant: { version, content, variables, config } }`. A unit's bucket is the
32-bit FNV-1a hash of the UTF-8 bytes of `<experiment id>:<unit>`, modulo 100; buckets below
`weight` get the variant.

## Other languages

Any language can fetch the live version with one request:

```sh
curl https://prompthelm.app/v1/prompts/support-reply \
  -H "Authorization: Bearer $PROMPTHELM_API_KEY"
```

The response carries the live version's `content`, its `variables` and its model settings as
`config` (only the ones set). `GET /v1/prompts` returns every published prompt of the key's
project at once, as `{ "prompts": [ … ] }`.

## Links

- [Quickstart](https://prompthelm.app/quickstart)
- [Changing a prompt without a redeploy](https://prompthelm.app/guides/change-prompts-without-redeploying)
- [Prompt versioning and rollback](https://prompthelm.app/guides/prompt-versioning)
- [Pricing](https://prompthelm.app/pricing)

## License

MIT
