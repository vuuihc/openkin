/**
 * Fenced code, tokenized: a curated grammar set behind one dynamic import.
 *
 * §3.7's decision was **not Monaco**, and the build says why: the workspace's
 * editor is already a lazy 3.3MB chunk (`CodeViewer-*.js`), and a fenced block in
 * a chat is *read*, not edited. What a block needs is a tokenizer and a colour
 * table, which is what highlight.js's core is and, near enough, all it is. The
 * grammars are a hand-picked list on top, and the whole thing is reachable only
 * through `CodeBlock`'s dynamic import — so a session with no code in it never
 * fetches any of this. Measured chunk sizes are in the plan's §8.
 *
 * Four decisions are written here rather than derived, and each has a failure
 * mode worth knowing before editing this file:
 *
 * - **The grammar list is curated, not complete.** The package ships 386
 *   grammars. A fence in a language that is not on the list renders as plain
 *   code — exactly what it was before this file existed — so the list is a
 *   quality decision, not a correctness one. It covers what a fence in this
 *   product is actually labelled with; see the groups on `GRAMMARS` below.
 * - **There is no auto-detection.** `highlightAuto` needs every grammar loaded
 *   (most of the 2.7MB on disk) and its answer is a *guess*; a block coloured by
 *   the wrong rules is worse to read than an uncoloured one, and an unlabelled
 *   fence is uncoloured here for that reason.
 * - **An unknown language is `null`, never an exception.** highlight.js *throws*
 *   on an unregistered name, so the caller must ask before it calls. `highlight`
 *   is the only way in, and it answers `null` for every way the question can
 *   fail — no label, a label with no grammar, a grammar that throws on the
 *   input. A block that cannot be coloured is a block drawn the old way.
 * - **The chunk loads for any labelled fence, even a label we do not know.**
 *   The alternative is a second list of language names in the *entry* chunk to
 *   answer "is this worth loading?" before loading — and that list would be a
 *   copy of aliases the grammars already declare, the same duplication the
 *   colour vocabulary is read out of the Tailwind config to avoid. A list that
 *   drifts from the grammars is the more expensive mistake; one lazy fetch on
 *   the first labelled fence is the cheaper one.
 *
 * The colours are not here: `design/syntax.css` maps the `.hljs-*` scopes onto
 * the ink tokens, and `tokens.test.ts` measures them on the backdrop a code
 * block actually paints.
 */
import type { LanguageFn } from "highlight.js";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * Canonical name → grammar. The name is the key the fence has to reach (after
 * its aliases, which each grammar declares itself and this file does not
 * repeat), so the two halves of a language's identity stay in one place.
 *
 * Read the three groups as the answer to "why is this one here": the list is
 * short enough that a reader should be able to check it rather than trust it.
 * The tail of the language world — swift, scala, lua, perl, r, and the rest — is
 * deliberately absent: one import and one line each, the day a fence asks.
 */
const GRAMMARS: Record<string, LanguageFn> = {
  // What a command printed, and what changed. These two carry the most meaning
  // per byte in a coding chat, and `diff` is the only grammar here whose colours
  // a reader reads as *content* rather than as decoration: an addition and a
  // deletion are the answer to "what did the agent do".
  bash,
  diff,
  // What a tool returned: the shapes a machine prints in.
  json,
  yaml,
  // Config files, including `toml` — which is not its own grammar: highlight.js
  // declares it as an alias of `ini`, so a ```toml fence resolves there.
  ini,
  xml,
  sql,
  // Files a repo is named after rather than written in.
  dockerfile,
  makefile,
  // The languages an agent is asked to write in, and the ones a reader is most
  // likely to be reading a diff of.
  typescript,
  javascript,
  go,
  python,
  rust,
  java,
  c,
  cpp,
  csharp,
  ruby,
  php,
  kotlin,
  // Markup and prose: a chat quotes both.
  css,
  markdown,
};

for (const [name, grammar] of Object.entries(GRAMMARS)) {
  hljs.registerLanguage(name, grammar);
}

/**
 * The canonical names, for the guard that holds this list to its own claim: a
 * grammar that is named here and registers nothing would leave every fence in
 * that language silently plain.
 */
export const HIGHLIGHT_LANGUAGES: readonly string[] = Object.keys(GRAMMARS);

/**
 * The fence label reduced to a grammar this module has, or `null`.
 *
 * The label is not always one word. Agents write the file after the language —
 * ```ts title="a.ts", ```go:internal/api.go, ```tsx{1,3} — and a lookup that
 * failed on those would render plain and say nothing, which is the failure this
 * function exists to prevent rather than to commit. None of the three separators
 * is legal in a language name, so cutting at the first one is safe: `c++` and
 * `objective-c` survive it, and nothing else in the grammar set contains one.
 */
export function resolveLanguage(fence?: string): string | null {
  if (!fence) return null;
  const [word] = fence
    .trim()
    .toLowerCase()
    .split(/[\s{:]/);
  return word && hljs.getLanguage(word) ? word : null;
}

/**
 * `code` as HTML, or `null` when it cannot be coloured.
 *
 * The result is injected as HTML by the caller, so the escaping is the whole
 * contract: highlight.js escapes the *source* before it emits anything, and the
 * only markup it then writes is a `<span>` around a scope it chose — no part of
 * the input reaches the output as markup. That is an upstream property, and the
 * one place it could fail is at a boundary where the input is an agent's own
 * output, so it is checked here rather than assumed: anything outside the one
 * shape the emitter can produce returns `null`, and the caller draws the block
 * the way it drew it before this file existed.
 */
export function highlight(code: string, fence?: string): string | null {
  const language = resolveLanguage(fence);
  if (!language) return null;
  try {
    const { value } = hljs.highlight(code, { language, ignoreIllegals: true });
    return SPAN_ONLY.test(value) ? value : null;
  } catch {
    // A grammar that throws — an upstream bug, a pathological input — is not
    // allowed to take the message with it. This is decoration on top of a chat.
    return null;
  }
}

/**
 * The whole of the output, as text and spans — nothing else, anywhere.
 *
 * The class is not always `hljs-*`: a sub-language scope is spelled
 * `class="language-javascript"` by the xml grammar, so the check is the shape
 * rather than the prefix. A value that fails this is not coloured, which is the
 * safe direction and a visible one.
 */
const SPAN_ONLY = /^(?:[^<]|<\/?span(?: class="[^"]*")?>)*$/;
