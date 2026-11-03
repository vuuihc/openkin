// KIN-NOTIFY-001: Web Push is gone, including the worker older builds left behind.
import { describe, expect, it, vi } from "vitest";
import { cleanupLegacyWebPush } from "./legacyWebPush";

describe("cleanupLegacyWebPush", () => {
  it("unsubscribes and unregisters what an older console installed", async () => {
    const order: string[] = [];
    const unsubscribe = vi.fn(async () => {
      order.push("unsubscribe");
      return true;
    });
    const unregister = vi.fn(async () => {
      order.push("unregister");
      return true;
    });

    await cleanupLegacyWebPush({
      getRegistrations: async () => [
        {
          active: { scriptURL: "http://127.0.0.1:7777/sw.js" },
          pushManager: { getSubscription: async () => ({ unsubscribe }) },
          unregister,
        },
      ],
    });

    expect(order).toEqual(["unsubscribe", "unregister"]);
  });

  it("leaves a service worker that is not the old Kin push worker", async () => {
    const unsubscribe = vi.fn(async () => true);
    const unregister = vi.fn(async () => true);

    await cleanupLegacyWebPush({
      getRegistrations: async () => [
        {
          active: { scriptURL: "http://127.0.0.1:7777/another-app/sw.js" },
          pushManager: { getSubscription: async () => ({ unsubscribe }) },
          unregister,
        },
        // A registration whose worker may still be installing or waiting is
        // still Kin's, and still has to go.
        {
          waiting: { scriptURL: "https://kin.example.com/sw.js?v=2" },
          unregister,
        },
      ],
    });

    expect(unsubscribe).not.toHaveBeenCalled();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("is silent in a browser with no service worker, or when a call fails", async () => {
    await expect(cleanupLegacyWebPush(null)).resolves.toBeUndefined();

    await expect(
      cleanupLegacyWebPush({
        getRegistrations: async () => {
          throw new Error("denied");
        },
      }),
    ).resolves.toBeUndefined();

    await expect(
      cleanupLegacyWebPush({
        getRegistrations: async () => [
          {
            active: { scriptURL: "http://127.0.0.1:7777/sw.js" },
            pushManager: {
              getSubscription: async () => {
                throw new Error("gone");
              },
            },
            unregister: async () => {
              throw new Error("gone");
            },
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });
});
