import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearNotificationRoute,
  consumeNativeNotificationRoute,
  consumeNotificationRoute,
  installForegroundNotifications,
  installNotificationRouting,
  parseForegroundNotification,
  parseNotificationRoute,
  queueNotificationRoute,
} from "./notificationRoute";

// KIN-NOTIFY-001: a notification is a path into the console, never a URL to open.

const ORIGIN = "https://kin.example.com";

beforeEach(() => {
  clearNotificationRoute();
});

describe("parseNotificationRoute", () => {
  it("lands on the inbox and names the item", () => {
    const route = parseNotificationRoute("/inbox?focus=appr-1", ORIGIN);
    expect(route).toEqual({ path: "/inbox?focus=appr-1", focus: "appr-1", fallback: false });
  });

  it("takes the path out of an absolute URL on the node's own origin", () => {
    // The node writes ui.base_url, which is the Hub URL even when this console
    // was opened at a LAN address or localhost. Comparing origins would send
    // every tap on a phone to the inbox instead of the item it named.
    const route = parseNotificationRoute("https://kin.example.com/tasks/task-1", ORIGIN);
    expect(route).toEqual({ path: "/tasks/task-1", focus: null, fallback: false });
  });

  it("keeps a routine report's machine task link", () => {
    // A routine run on a paired Node is opened at /machines/<device>/tasks/<id>,
    // which is a known route even though it is not a local /tasks/:id.
    const route = parseNotificationRoute("/machines/dev-1/tasks/task-9", ORIGIN);
    expect(route).toEqual({ path: "/machines/dev-1/tasks/task-9", focus: null, fallback: false });
  });

  it("keeps the device a disabled-routine alert names", () => {
    const route = parseNotificationRoute("/routines?device=dev-1", ORIGIN);
    expect(route).toEqual({ path: "/routines?device=dev-1", focus: null, fallback: false });
    // An unrelated query is dropped, never folded into the navigation.
    expect(parseNotificationRoute("/routines?utm=push", ORIGIN).path).toBe("/routines");
  });

  it("keeps the path but never the host of an absolute link", () => {
    expect(parseNotificationRoute("https://evil.example/inbox?focus=a1", ORIGIN)).toEqual({
      path: "/inbox?focus=a1",
      focus: "a1",
      fallback: false,
    });
  });

  it("still refuses an absolute link whose path is not a console route", () => {
    expect(parseNotificationRoute("https://evil.example/admin/delete?focus=a1", ORIGIN)).toEqual({
      path: "/inbox",
      focus: null,
      fallback: true,
    });
  });

  it("drops the origin and query it does not understand", () => {
    const route = parseNotificationRoute("/tasks/task-1?utm=push", ORIGIN);
    expect(route.path).toBe("/tasks/task-1");
    expect(route.fallback).toBe(false);
  });

  it("falls back for javascript: and file: links", () => {
    for (const href of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"]) {
      const route = parseNotificationRoute(href, ORIGIN);
      expect(route.path).toBe("/inbox");
      expect(route.fallback).toBe(true);
    }
  });

  it("falls back for an unknown same-origin path", () => {
    expect(parseNotificationRoute("/admin/delete?focus=a1", ORIGIN)).toEqual({
      path: "/inbox",
      focus: null,
      fallback: true,
    });
  });

  it("falls back for an empty or malformed link", () => {
    expect(parseNotificationRoute("", ORIGIN).fallback).toBe(true);
    expect(parseNotificationRoute("http://[::1", ORIGIN).fallback).toBe(true);
  });
});

describe("consumeNotificationRoute", () => {
  it("consumes a cold-start link exactly once", () => {
    queueNotificationRoute("/inbox?focus=a1");
    expect(consumeNotificationRoute(ORIGIN)?.focus).toBe("a1");
    expect(consumeNotificationRoute(ORIGIN)).toBeNull();
  });

  it("replaces a queued link rather than replaying both", () => {
    queueNotificationRoute("/inbox?focus=a1");
    queueNotificationRoute("/tasks/task-2");
    expect(consumeNotificationRoute(ORIGIN)?.path).toBe("/tasks/task-2");
    expect(consumeNotificationRoute(ORIGIN)).toBeNull();
  });
});

describe("installNotificationRouting", () => {
  it("delivers every tap and leaves dedupe to the router-aware component", () => {
    const handlers = new Map<string, (event: Event) => void>();
    const scope = {
      __kinPendingNotification: "/inbox?focus=a1",
      addEventListener: (type: string, listener: (event: Event) => void) => {
        handlers.set(type, listener);
      },
      removeEventListener: (type: string) => {
        handlers.delete(type);
      },
    };
    const onRoute = vi.fn();
    const stop = installNotificationRouting(onRoute, scope);

    expect(onRoute).toHaveBeenCalledWith({ path: "/inbox?focus=a1", focus: "a1", fallback: false });

    // The same target again is delivered: it may be a second, genuine tap
    // after the reader left the item. `NotificationTaps` knows the current
    // route and suppresses it only while the target is already on screen.
    handlers.get("kin:notification")?.(
      new CustomEvent("kin:notification", { detail: { url: "/inbox?focus=a1" } }),
    );
    expect(onRoute).toHaveBeenCalledTimes(2);

    // A different target is a real tap and is delivered.
    handlers.get("kin:notification")?.(
      new CustomEvent("kin:notification", { detail: { url: "/tasks/task-1" } }),
    );
    expect(onRoute).toHaveBeenCalledWith({ path: "/tasks/task-1", focus: null, fallback: false });

    stop();
    expect(handlers.has("kin:notification")).toBe(false);
  });
});

describe("consumeNativeNotificationRoute", () => {
  it("drains the tap the iPhone shell held during launch", async () => {
    const takePendingURL = vi.fn(async () => ({ url: "/inbox?focus=appr-1" }));
    await expect(consumeNativeNotificationRoute({ takePendingURL }, ORIGIN)).resolves.toEqual({
      path: "/inbox?focus=appr-1",
      focus: "appr-1",
      fallback: false,
    });
    expect(takePendingURL).toHaveBeenCalledTimes(1);
  });

  it("still validates what the shell held", async () => {
    const source = { takePendingURL: vi.fn(async () => ({ url: "javascript:alert(1)" })) };
    await expect(consumeNativeNotificationRoute(source, ORIGIN)).resolves.toEqual({
      path: "/inbox",
      focus: null,
      fallback: true,
    });
  });

  it("returns nothing when there is no tap, no plugin, or the bridge fails", async () => {
    await expect(consumeNativeNotificationRoute(null, ORIGIN)).resolves.toBeNull();
    await expect(consumeNativeNotificationRoute({}, ORIGIN)).resolves.toBeNull();
    await expect(
      consumeNativeNotificationRoute({ takePendingURL: async () => null }, ORIGIN),
    ).resolves.toBeNull();
    await expect(
      consumeNativeNotificationRoute(
        {
          takePendingURL: async () => {
            throw new Error("bridge unavailable");
          },
        },
        ORIGIN,
      ),
    ).resolves.toBeNull();
  });
});

describe("a notification that arrives in the foreground", () => {
  it("keeps the title, body, and item the shell sent", () => {
    expect(
      parseForegroundNotification({
        title: "Fix the login bug",
        body: "Task 01ABC is succeeded",
        kind: "task",
        id: "01ABC",
        url: "https://kin.example.com/tasks/01ABC",
      }),
    ).toEqual({
      title: "Fix the login bug",
      body: "Task 01ABC is succeeded",
      kind: "task",
      id: "01ABC",
      url: "https://kin.example.com/tasks/01ABC",
    });
  });

  it("refuses a payload with nothing to say and clips long text", () => {
    expect(parseForegroundNotification(null)).toBeNull();
    expect(parseForegroundNotification({ title: "", body: "" })).toBeNull();
    expect(parseForegroundNotification({ title: 42, body: [] })).toBeNull();
    const parsed = parseForegroundNotification({
      title: "t".repeat(1000),
      body: "b".repeat(5000),
      kind: "approval",
    });
    expect(parsed?.title.length).toBe(200);
    expect(parsed?.body.length).toBe(600);
  });

  it("delivers every arrival to the console and stops on unsubscribe", () => {
    const handlers = new Map<string, (event: Event) => void>();
    const scope = {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        handlers.set(type, listener);
      },
      removeEventListener: (type: string) => {
        handlers.delete(type);
      },
    };
    const onNotify = vi.fn();
    const stop = installForegroundNotifications(onNotify, scope);

    handlers.get("kin:notification-received")?.(
      new CustomEvent("kin:notification-received", {
        detail: { title: "Approval needed", body: "", kind: "approval", id: "a1" },
      }),
    );
    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "approval", id: "a1", title: "Approval needed" }),
    );

    stop();
    expect(handlers.has("kin:notification-received")).toBe(false);
  });
});
