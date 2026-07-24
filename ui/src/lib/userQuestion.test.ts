import { describe, expect, it } from "vitest";
import { parseUserQuestionPayload } from "../api/client";

describe("parseUserQuestionPayload", () => {
  it("parses structured payload", () => {
    const got = parseUserQuestionPayload({
      question: "Which auth?",
      header: "Auth",
      multi_select: true,
      options: [
        { label: "JWT", description: "stateless" },
        { label: "Session" },
        { label: "" }, // dropped
      ],
    });
    expect(got.question).toBe("Which auth?");
    expect(got.header).toBe("Auth");
    expect(got.multi_select).toBe(true);
    expect(got.options).toEqual([
      { label: "JWT", description: "stateless" },
      { label: "Session", description: undefined },
    ]);
  });

  it("accepts multiSelect camelCase and empty input", () => {
    const empty = parseUserQuestionPayload(null);
    expect(empty.question).toBe("");
    expect(empty.options).toEqual([]);
    expect(empty.multi_select).toBe(false);

    const camel = parseUserQuestionPayload({
      question: "Q?",
      multiSelect: true,
      options: [{ label: "A" }, { label: "B" }],
    });
    expect(camel.multi_select).toBe(true);
    expect(camel.options.map((o) => o.label)).toEqual(["A", "B"]);
  });

  it("coerces non-string fields", () => {
    const got = parseUserQuestionPayload({
      question: 42,
      header: 7,
      options: [{ label: 1, description: 2 }, "skip-me"],
    });
    expect(got.question).toBe("42");
    expect(got.header).toBe("7");
    expect(got.options).toEqual([{ label: "1", description: "2" }]);
  });
});
