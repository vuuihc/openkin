/**
 * What a publish sheet may send, and why it may not send it.
 *
 * Both rules are the wire's own — `worker.ValidatePRWords` in Go, which the
 * machine checks again on its side — mirrored here rather than invented, because
 * the sheet must not offer an action the Hub will refuse. That is not tidiness:
 * the way out of a default-branch refusal starts a branch *and then* publishes, so
 * a refusal that arrives after the branch has moved is a promise this side broke.
 *
 * The two bounds are counted differently on purpose. A title is characters, which
 * is GitHub's own unit and what the wire counts, so a title written in Chinese is
 * not refused for its length in bytes. A description is bytes, which is what a
 * `gh` invocation can carry. Both are the numbers in `internal/remote/worker`
 * (`MaxPRTitle`, `MaxPRBody`); a change there is a change here.
 */
export const MAX_TITLE_CHARS = 256;
export const MAX_BODY_BYTES = 64 * 1024;

export type PublishWords = {
  title: string;
  body: string;
};

/** The i18n key for why these words cannot be sent, or "" when they can. */
export function publishWordsRefusal(words: PublishWords): string {
  if (words.title.trim().length === 0) return "publish.needsTitle";
  if (bodyBytes(words.body) > MAX_BODY_BYTES) return "publish.bodyTooLong";
  return "";
}

/**
 * The body's size on the wire, in bytes.
 *
 * A body of 40,000 Chinese characters is 40,000 UTF-16 units and 120,000 bytes,
 * so a length check would let through exactly the text this is here to stop.
 */
export function bodyBytes(body: string): number {
  return new TextEncoder().encode(body).length;
}
