import { describe, expect, it } from "vitest";
import { HIGHLIGHT_LANGUAGES, highlight, resolveLanguage } from "./codeHighlight";

/**
 * What the highlighter promises its caller, which is narrow on purpose.
 *
 * There is no DOM here and none is needed: highlight.js is a tokenizer, so the
 * whole feature minus one `dangerouslySetInnerHTML` is a pair of pure functions
 * and is tested as one. What the *render* does with them — the three states in
 * `CodeBlock`, and the memo that keeps a streaming transcript from
 * re-tokenizing itself — is wiring, and it is guarded the way this tree guards
 * the rest of its wiring: by looking at the built interface (P2 §6.1).
 */
describe("highlight", () => {
  it("tokenizes a fence in a language the list has", () => {
    const html = highlight('package main\n\nfunc main() { fmt.Println("hi") }\n', "go");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("hljs-string");
  });

  // The one place a fence could carry markup into the page. The escaping is
  // highlight.js's, but the input is an agent's own output, so the boundary is
  // checked rather than trusted — and the check is the `span`-only guard in
  // `highlight`, whose failing branch is unreachable from out here, which is
  // exactly what this case is asserting. What it holds is the other half: the
  // shapes the emitter really produces do pass that guard.
  it("emits nothing but spans, whatever the code says", () => {
    const hostile = [
      "<script>alert(1)</script>",
      '<img src=x onerror="alert(1)">',
      "&lt;already escaped&gt; &amp; &#65;",
    ].join("\n");
    for (const fence of ["html", "xml", "markdown", "bash", "json"]) {
      const html = highlight(hostile, fence);
      expect(html, fence).not.toBeNull();
      // Every tag in the output is a span around a scope, and that is the whole
      // claim: nothing the fence said reached the page as markup. A substring
      // test on `onerror` would be the wrong assertion — after escaping it is
      // *text*, and text is exactly where it belongs.
      //
      // The class is not always `hljs-*`: a sub-language scope is spelled
      // `class="language-javascript"` by the xml grammar, which is why this
      // asserts the shape rather than the prefix.
      const tags = html!.match(/<[^>]*>/g) ?? [];
      expect(tags.length, fence).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(tag, `${fence}: ${tag}`).toMatch(/^<\/?span( class="[^"]*")?>$/);
      }
      expect(html!.replace(/<[^>]*>/g, ""), fence).not.toContain("<");
    }
    // The text is still *there* — escaping is not dropping it. Read it the way
    // the browser would: with the emitter's own spans taken back out, the fence
    // is a run of entities and never a tag.
    for (const fence of ["html", "json"]) {
      const text = highlight(hostile, fence)!.replace(/<[^>]*>/g, "");
      expect(text, fence).toContain("&lt;script&gt;");
      expect(text, fence).not.toContain("<script");
    }
  });

  // A diff is the one block whose colours a reader reads as content, so this is
  // the assertion behind `design/syntax.css` spending red on nothing else.
  it("marks a diff's added and removed lines apart", () => {
    const html = highlight("@@ -1 +1 @@\n-old name\n+new name\n", "diff");
    expect(html).toContain("hljs-deletion");
    expect(html).toContain("hljs-addition");
  });

  it("declines a fence it has no grammar for, and one with no label", () => {
    expect(highlight("x", "brainfuck")).toBeNull();
    expect(highlight("x", "text")).toBeNull();
    expect(highlight("x", undefined)).toBeNull();
    expect(highlight("x", "")).toBeNull();
  });

  // The label an agent writes is not always just the language. A lookup that
  // failed here would render plain and say nothing, which is the failure mode
  // this whole function exists to avoid.
  it("reads the label the way a fence is actually written", () => {
    for (const label of [
      "ts",
      "TS",
      " ts ",
      'ts title="a.ts"',
      "go:internal/api.go",
      "tsx{1,3}",
      "yaml",
      "sh",
    ]) {
      expect(resolveLanguage(label), label).not.toBeNull();
    }
    expect(resolveLanguage('ts title="a.ts"')).toBe("ts");
    expect(resolveLanguage("go:internal/api.go")).toBe("go");
    expect(resolveLanguage("tsx{1,3}")).toBe("tsx");
  });

  it("knows every language it claims to", () => {
    // A name in the list that registers no grammar is a language every fence in
    // it renders plain — silently, because that is the designed fallback.
    expect(HIGHLIGHT_LANGUAGES.length).toBeGreaterThan(20);
    for (const name of HIGHLIGHT_LANGUAGES) {
      expect(resolveLanguage(name), name).toBe(name);
      expect(highlight("x = 1", name), name).not.toBeNull();
    }
  });

  // The aliases come from the grammars themselves rather than a map here, so
  // this is the case that would catch a grammar dropping one. Every label below
  // is one a chat in this product plausibly writes.
  it("resolves the aliases a chat writes", () => {
    const aliases: Record<string, string> = {
      sh: "bash",
      ts: "typescript",
      tsx: "typescript",
      js: "javascript",
      jsx: "javascript",
      py: "python",
      yml: "yaml",
      rs: "rust",
      md: "markdown",
      patch: "diff",
      golang: "go",
      html: "xml",
      toml: "ini",
      cs: "csharp",
      "c++": "cpp",
      rb: "ruby",
      docker: "dockerfile",
      mk: "makefile",
      kt: "kotlin",
    };
    for (const [alias, canonical] of Object.entries(aliases)) {
      // Both spellings have to work: the alias is what the fence says, and the
      // canonical name is what a grammar's own `aliases` list has to agree with.
      expect(resolveLanguage(alias), alias).toBe(alias);
      expect(resolveLanguage(canonical), canonical).toBe(canonical);
    }
  });
});
