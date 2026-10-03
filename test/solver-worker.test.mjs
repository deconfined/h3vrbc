import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const data = JSON.parse(await readFile(new URL("../public/data/h3vr.json", import.meta.url), "utf8"));

// The worker host cannot be exercised under jsdom, so drive the module's own
// message wiring with a stand-in worker scope.
test("the solver worker answers each message with the same payload solve() returns", async (t) => {
  const posted = [];
  const listeners = [];
  class FakeWorkerGlobalScope {
    addEventListener(type, handler) { listeners.push([type, handler]); }
    postMessage(data) { posted.push(data); }
  }
  const previous = { scope: globalThis.WorkerGlobalScope, self: globalThis.self };
  globalThis.WorkerGlobalScope = FakeWorkerGlobalScope;
  globalThis.self = new FakeWorkerGlobalScope();
  t.after(() => {
    if (previous.scope === undefined) delete globalThis.WorkerGlobalScope;
    else globalThis.WorkerGlobalScope = previous.scope;
    if (previous.self === undefined) delete globalThis.self;
    else globalThis.self = previous.self;
  });
  const { solve } = await import(`../public/solver-worker.js?wire=${Date.now()}`);

  assert.deepEqual(listeners.map(([type]) => type), ["message"],
    "the module must attach exactly one message listener inside a worker scope");

  const round = data.rounds.find((item) => item.id === "338LapuaCartridgeAP");
  const weapon = data.weapons.find((item) => item.id === "MRAD");
  const caliber = data.calibers.find((item) => item.id === round.caliberId);
  const request = {
    profile: round,
    settings: data.settings,
    options: {
      weapon, attachments: [], caliber,
      zeroModel: "game", zeroRange: 1000, barrelLength: 0.6,
      chamberMultiplier: 1, velocityMultiplier: 1,
      sightHeight: 0.075, sightSetback: 0.6, inclinationDegrees: 0,
      targetRange: 800, rangeStep: 200, gravity: 9.8100004196167,
      fixedStep: data.settings.fixedDeltaTime, firstStep: data.settings.fixedDeltaTime,
      sceneLimit: 5000, worldHeight: 1.6, catchHeight: -50,
    },
  };
  const handler = listeners.at(-1)[1];
  handler({ data: request });
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0], solve(request));
  assert.equal(posted[0].ok, true);
  assert.ok(posted[0].solution.targetSpread.boundRadius > 0);
  // Nothing in the payload may be a function or a live object, or the real
  // structured clone across the worker boundary would throw. structuredClone is
  // what postMessage performs, and unlike JSON it preserves -0.
  assert.deepEqual(structuredClone(posted[0]), posted[0]);
});

test("importing the solver outside a worker scope registers no listener", async () => {
  const previous = globalThis.WorkerGlobalScope;
  delete globalThis.WorkerGlobalScope;
  try {
    const module = await import(`../public/solver-worker.js?noworker=${Date.now()}`);
    assert.equal(typeof module.solve, "function");
  } finally {
    if (previous !== undefined) globalThis.WorkerGlobalScope = previous;
  }
});