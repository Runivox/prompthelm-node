import { describe, expect, it } from "vitest";
import { extractVariables, PromptHelmError, render } from "../src";

describe("extractVariables", () => {
  it("lists each variable once, in order of first appearance", () => {
    expect(extractVariables("{{b}} {{ a }} {{b}} {{a_1}}")).toEqual(["b", "a", "a_1"]);
  });

  it("ignores braces that aren't a variable", () => {
    expect(extractVariables("{{}} {{1a}} {{ two words }} {single}")).toEqual([]);
  });
});

describe("render", () => {
  it("fills variables, tolerating spaces inside the braces", () => {
    expect(render("Hi {{ name }}, you have {{count}} items", { name: "Ayşe", count: 3 })).toBe(
      "Hi Ayşe, you have 3 items",
    );
  });

  it("throws missing_variables instead of leaving a placeholder", () => {
    expect(() => render("Hi {{name}} from {{city}}", { name: "Ayşe" })).toThrowError(
      expect.objectContaining({ code: "missing_variables", message: "Missing variables: city" }),
    );
  });

  it("doesn't take inherited object properties as variables", () => {
    expect(() => render("{{constructor}}", {})).toThrow(PromptHelmError);
  });
});
