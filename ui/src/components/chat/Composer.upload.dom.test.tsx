// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import { ApiError, type Upload } from "../../api/client";
import Composer from "./Composer";

/**
 * The composer's attachment strip while an upload is happening: a placeholder
 * in the final slot before the first await, an honest percentage, an in-place
 * swap, and a pending item that never reaches the prompt or the draft.
 */
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  uploadFileWithProgress: vi.fn(),
}));

import { uploadFileWithProgress } from "../../api/client";

const mockedUpload = vi.mocked(uploadFileWithProgress);
const createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`);
const revokeObjectURL = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function file(name: string, type = "image/png"): File {
  return new File(["kin"], name, { type });
}

function upload(name: string, mime = "image/png"): Upload {
  return {
    id: `id-${name}`,
    name,
    mime,
    size: 3,
    url: `/api/uploads/${name}`,
    path: `/Users/me/.kin/uploads/${name}`,
  };
}

function setup() {
  const onSubmit = vi.fn();
  const onAttachmentsChange = vi.fn();
  render(<Composer onSubmit={onSubmit} onAttachmentsChange={onAttachmentsChange} />);
  return { onSubmit, onAttachmentsChange, box: screen.getByRole("textbox") };
}

function pick(files: File[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

beforeEach(() => {
  setLocale("en");
  mockedUpload.mockReset();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  useAppStore.setState({ toasts: [] });
  window.history.replaceState({ idx: 0 }, "", "/tasks/t1");
});

describe("Composer upload placeholders", () => {
  it("shows a local placeholder for each picked file before the upload resolves", async () => {
    setup();
    const first = deferred<Upload>();
    const second = deferred<Upload>();
    mockedUpload
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    pick([file("a.png"), file("b.png")]);

    // Both slots exist in the pick's tick; only the first request has started.
    const tiles = screen.getAllByTestId("composer-attachment");
    expect(tiles).toHaveLength(2);
    expect(tiles[0]?.getAttribute("data-pending")).toBe("true");
    expect((screen.getByAltText("a.png") as HTMLImageElement).getAttribute("src")).toBe(
      "blob:a.png",
    );
    // The queued picture says so in its accessible name and its overlay.
    expect(screen.getByRole("button", { name: /View b\.png · Waiting to upload…/ })).toBeTruthy();
    expect(screen.getAllByTestId("composer-upload-progress").map((el) => el.textContent)).toEqual([
      "0%",
      "…",
    ]);
  });

  it("updates the placeholder percentage as progress arrives", async () => {
    setup();
    const pending = deferred<Upload>();
    let report: ((percent: number) => void) | undefined;
    mockedUpload.mockImplementationOnce((_file, onProgress) => {
      report = onProgress;
      return pending.promise;
    });

    pick([file("a.png")]);
    await waitFor(() => expect(report).toBeTruthy());

    act(() => report?.(42));

    expect(screen.getByTestId("composer-upload-progress").textContent).toBe("42%");
    expect(screen.getByRole("button", { name: /Uploading · 42%/ })).toBeTruthy();
  });

  it("replaces the placeholder in place when the upload lands and keeps the preview", async () => {
    const { onAttachmentsChange } = setup();
    const first = deferred<Upload>();
    const second = deferred<Upload>();
    mockedUpload
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    pick([file("a.png"), file("b.png")]);
    await act(async () => first.resolve(upload("a.png")));

    const tiles = screen.getAllByTestId("composer-attachment");
    expect(tiles).toHaveLength(2);
    // The finished file kept slot one; the queued one did not move up.
    expect(tiles[0]?.getAttribute("data-pending")).toBeNull();
    expect(tiles[0]?.getAttribute("title")).toContain("a.png");
    expect(tiles[1]?.getAttribute("data-pending")).toBe("true");
    // The local blob is still the thumbnail after the swap.
    expect((screen.getByAltText("a.png") as HTMLImageElement).getAttribute("src")).toBe(
      "blob:a.png",
    );
    expect(onAttachmentsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "id-a.png", name: "a.png" }),
    ]);
  });

  it("keeps pending items out of the prompt and the persisted draft", async () => {
    const user = userEvent.setup();
    const { onSubmit, onAttachmentsChange, box } = setup();
    const pending = deferred<Upload>();
    mockedUpload.mockImplementationOnce(() => pending.promise);

    pick([file("a.png")]);
    await user.type(box, "hello");

    // Mid-upload there is a visible file but nothing sendable.
    fireEvent.submit(screen.getByRole("button", { name: "Send" }).closest("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => pending.resolve(upload("a.png")));
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenCalledWith(
      "hello\n\nAttached image:\n- a.png: /Users/me/.kin/uploads/a.png",
      undefined,
    );
    const persisted = onAttachmentsChange.mock.calls.flatMap(
      (call) => call[0] as { id: string }[],
    );
    expect(persisted.every((item) => !item.id.startsWith("pending-"))).toBe(true);
  });

  it("removes or marks one failed file without dropping its siblings", async () => {
    const { onAttachmentsChange } = setup();
    const failed = deferred<Upload>();
    const kept = deferred<Upload>();
    mockedUpload
      .mockImplementationOnce(() => failed.promise)
      .mockImplementationOnce(() => kept.promise);

    pick([file("bad.png"), file("good.png")]);
    await act(async () => failed.reject(new ApiError(500, "disk full")));
    await act(async () => kept.resolve(upload("good.png")));

    await waitFor(() =>
      expect(screen.getAllByTestId("composer-attachment")).toHaveLength(1),
    );
    expect(screen.getByAltText("good.png")).toBeTruthy();
    expect(screen.queryByAltText("bad.png")).toBeNull();
    expect(onAttachmentsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: "good.png" }),
    ]);
    expect(useAppStore.getState().toasts.map((toast) => toast.message)).toContain("disk full");
  });

  it("revokes the object URL when an attachment is removed", async () => {
    const user = userEvent.setup();
    setup();
    mockedUpload.mockImplementationOnce(() => new Promise<Upload>(() => undefined));

    pick([file("a.png")]);
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:a.png");
    expect(screen.queryByTestId("composer-attachment")).toBeNull();
  });

  it("opens the shared viewer from a composer thumbnail", async () => {
    const user = userEvent.setup();
    setup();
    mockedUpload.mockResolvedValueOnce(upload("a.png"));

    pick([file("a.png")]);
    const thumb = await screen.findByRole("button", { name: "View a.png" });

    await user.click(thumb);

    const dialog = await screen.findByRole("dialog", { name: "a.png" });
    expect(within(dialog).getByRole("img", { name: "a.png" })).toBeTruthy();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(thumb);
  });

  it("does not open the viewer when the remove control is pressed", async () => {
    const user = userEvent.setup();
    setup();
    mockedUpload.mockResolvedValueOnce(upload("a.png"));

    pick([file("a.png")]);
    await screen.findByRole("button", { name: "View a.png" });

    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
