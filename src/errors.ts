/** Every code a PromptHelmError carries. The server checks fallback reports against this list. */
export const ERROR_CODES = [
  "unauthorized",
  "not_found",
  "missing_variables",
  "timeout",
  "network",
  "server",
] as const;

export type PromptHelmErrorCode = (typeof ERROR_CODES)[number];

export class PromptHelmError extends Error {
  override readonly name = "PromptHelmError";

  constructor(
    readonly code: PromptHelmErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
