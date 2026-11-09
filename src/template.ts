import { PromptHelmError } from "./errors";

const VARIABLE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export type Vars = Readonly<Record<string, string | number | boolean>>;

/** The `{{variables}}` a template uses, in order of first appearance. */
export function extractVariables(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(VARIABLE)) {
    names.add(match[1] as string);
  }
  return [...names];
}

/**
 * Fills in every `{{variable}}`. Throws `missing_variables` rather than leaving a
 * placeholder in the text, because a half-filled prompt reaches the model silently.
 */
export function render(template: string, vars: Vars = {}): string {
  const missing = extractVariables(template).filter((name) => !Object.hasOwn(vars, name));
  if (missing.length > 0) {
    throw new PromptHelmError("missing_variables", `Missing variables: ${missing.join(", ")}`);
  }
  return template.replace(VARIABLE, (_, name: string) => String(vars[name]));
}
