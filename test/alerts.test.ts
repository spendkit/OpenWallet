import { test } from "node:test";
import assert from "node:assert/strict";
import { Alerter } from "../src/lib/services/Alerter.js";

function make(failHook = false) {
  const logs: string[] = [];
  const hooks: string[] = [];
  let t = 1_000;
  const fetchFn = (async (_u: string, init: RequestInit) => {
    if (failHook) throw new Error("hook down");
    hooks.push(JSON.parse(init.body as string).text);
    return new Response("ok");
  }) as unknown as typeof fetch;
  const a = new Alerter({ log: (s) => logs.push(s), webhookUrl: "https://hook.test/x", fetch: fetchFn, repeatMs: 60_000, now: () => t });
  return { a, logs, hooks, advance: (ms: number) => (t += ms) };
}

test("a raised key alerts once, repeats only after the interval, and says when recovered", async () => {
  const { a, hooks, advance } = make();
  await a.raise("k", "bad");
  await a.raise("k", "bad");
  assert.deepEqual(hooks, ["ALERT bad"]);
  advance(61_000);
  await a.raise("k", "bad");
  assert.equal(hooks.length, 2);
  await a.clear("k", "fine");
  await a.clear("k", "fine"); // second clear is silent
  assert.deepEqual(hooks.slice(2), ["RECOVERED fine"]);
  await a.raise("k", "bad again"); // alerts straight away after a recovery
  assert.equal(hooks.length, 4);
});

test("clearing a key that never alerted says nothing, and keys are independent", async () => {
  const { a, hooks } = make();
  await a.clear("never", "x");
  await a.raise("a", "one");
  await a.raise("b", "two");
  assert.deepEqual(hooks, ["ALERT one", "ALERT two"]);
});

test("a dead alert webhook is logged, never thrown", async () => {
  const { a, logs } = make(true);
  await a.raise("k", "bad");
  assert.ok(logs.some((l) => /ALERT webhook failed: hook down/.test(l)));
});
