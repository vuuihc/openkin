import test from "node:test";
import assert from "node:assert/strict";
import { RelayRoom } from "./relay.js";

test("relay module parses and exports Durable Object", () => {
  assert.equal(typeof RelayRoom, "function");
});

test("invalid room requests fail before Durable Object lookup", async () => {
  const env = { RELAY_ROOM: { idFromName() { throw new Error("must not be called"); } } };
  const response = await (await import("./relay.js")).default.fetch(
    new Request("https://relay.example.test/"),
    env,
  );
  assert.equal(response.status, 400);
});
