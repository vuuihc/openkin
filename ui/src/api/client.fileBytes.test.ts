import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchFileBytes, setToken } from "./client";

/**
 * A preview image is bytes, not JSON, and the console fetches it with the token
 * in a header so it never has to be in a URL. A refusal has to arrive as the
 * daemon's own sentence: an <img src> would show a broken picture, and a plain
 * link would save the error page under the file's name.
 */

const fetchMock = vi.fn<typeof fetch>();
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchFileBytes", () => {
  it("sends the bearer token in a header and returns the body as a blob", async () => {
    setToken("tok-1");
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
    fetchMock.mockResolvedValue(new Response(png, { status: 200 }));

    const blob = await fetchFileBytes("/api/tasks/t/source/file?path=shot.png&raw=1");

    expect(blob.size).toBe(4);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/tasks/t/source/file?path=shot.png&raw=1");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok-1");
    // The JSON default would be a lie about what this route answers with.
    expect(headers.get("Accept")).toBeNull();
  });

  it("refuses a 200 page or JSON envelope instead of saving it", async () => {
    // A proxy or an older daemon can answer 200 with something that is not the
    // file. The whole bug this route fixes was saving that under the name.
    // A fresh response each time: a body can only be read once, and reusing
    // one would test the second call against an empty stream.
    for (const type of ["text/html; charset=utf-8", "text/plain", "application/json"]) {
      fetchMock.mockResolvedValueOnce(
        new Response("<html>sign in</html>", {
          status: 200,
          headers: { "Content-Type": type },
        }),
      );
      await expect(fetchFileBytes("/x")).rejects.toBeInstanceOf(ApiError);
    }
  });

  it("throws the daemon's refusal as an ApiError", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "file exceeds 4194304 bytes" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchFileBytes("/x")).rejects.toMatchObject({
      status: 400,
      message: "file exceeds 4194304 bytes",
    });
    await expect(fetchFileBytes("/x")).rejects.toBeInstanceOf(ApiError);
  });
});
