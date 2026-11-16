/**
 * The stylesheet of an exported transcript.
 *
 * Not tokens, and the reason is that this is not our document: `formatSharedHTML`
 * builds a file that is downloaded, opened from the file system and mailed
 * around, with the console's CSS nowhere in sight, so it has to carry its own
 * values and it has to be readable on its own. It is fixed to the light scheme
 * (`color-scheme: light`) for the same reason — the export has no theme
 * attribute to switch on, and a shared transcript that renders dark for one
 * reader and light for another is not a document.
 *
 * It lives under `design/` because that is the one directory allowed to spell a
 * colour — see `theme.css`'s header. The string is interpolated into the
 * `</style>` block verbatim, so its whitespace is part of the output;
 * `shareExport.test.ts` holds the document it produces.
 */
export const EXPORT_STYLESHEET = `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f6f7fb; color: #1c1c1e; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(780px, calc(100% - 32px)); margin: 48px auto; }
    h1 { margin: 0 0 24px; font-size: 26px; letter-spacing: -.02em; }
    .message { margin: 16px 0; padding: 16px 18px; border: 1px solid #e3e4ea; border-radius: 16px; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / 3%); }
    .message.user { margin-left: 9%; background: #eef5ff; border-color: #d9e8ff; }
    .role { margin-bottom: 7px; color: #61636b; font-size: 12px; font-weight: 650; }
    .content { white-space: pre-wrap; overflow-wrap: anywhere; }
`;
