import test from "node:test";
import assert from "node:assert/strict";
import { CookieJar, JSDOM } from "jsdom";
import { createInterfaceStore } from "../public/interface-state.js";

const COOKIE_NAME = "h3vrbc_interface";
const state = {
  values: { weapon: "Rifle", chamber: "0", round: "556x45mmCartridgeFMJ", "show-drift": true, distance: "100" },
  attachmentIds: ["BarrelExtenderThinLong", "SuppressorMk12", "SuppressorMk12"],
  sections: { "weapon-section": true, "target-section": false },
  scroll: { pageX: 0, pageY: 21, setupTop: 110, tableLeft: 20.5, tableTop: 90 },
  calculated: true,
};

function browser(t, url = "https://example.test/calculator", cookieJar = new CookieJar()) {
  const dom = new JSDOM("", { url, cookieJar });
  t.after(() => dom.window.close());
  return { document: dom.window.document, cookieJar, store: createInterfaceStore(dom.window.document) };
}

function inject(document, payload) {
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(JSON.stringify(payload))}; Path=/`;
}

test("interface storage construction and reads leave an absent cookie untouched", (t) => {
  const { store, document, cookieJar } = browser(t);
  assert.equal(store.read(), null);
  assert.equal(document.cookie, "");
  assert.deepEqual(cookieJar.getCookiesSync("https://example.test/"), []);
  store.clear();
  assert.equal(document.cookie, "");
});

test("interface storage round-trips controls, duplicate ordered attachments, sections, scroll, and calculation state", (t) => {
  const { store, document, cookieJar } = browser(t);
  document.cookie = "unrelated=value; Path=/";
  store.write(state);
  assert.deepEqual(store.read(), state);
  const cookie = document.cookie.split("; ").find((part) => part.startsWith(`${COOKIE_NAME}=`));
  assert.deepEqual(JSON.parse(decodeURIComponent(cookie.slice(`${COOKIE_NAME}=`.length))), { version: 1, state });
  const next = browser(t, "https://example.test/another/page", cookieJar);
  assert.deepEqual(next.store.read(), state);
  const loaded = next.store.read();
  loaded.values.weapon = "Other weapon";
  loaded.attachmentIds.push("Other attachment");
  loaded.sections["weapon-section"] = false;
  assert.deepEqual(store.read(), state, "Returned data cannot mutate the saved state");
  store.write({ values: {}, attachmentIds: [], sections: {}, scroll: { pageX: 0, pageY: 0, setupTop: 0, tableLeft: 0 }, calculated: false });
  assert.equal(store.read().calculated, false);
  assert.ok(document.cookie.includes("unrelated=value"));
});

test("version 1 interface cookies without tableTop remain readable and writable", (t) => {
  const { store, document } = browser(t);
  const legacy = { ...state, scroll: { pageX: 0, pageY: 21, setupTop: 110, tableLeft: 20.5 } };
  inject(document, { version: 1, state: legacy });
  assert.deepEqual(store.read(), legacy);
  store.write(legacy);
  assert.deepEqual(store.read(), legacy);
  assert.equal(Object.hasOwn(store.read().scroll, "tableTop"), false);
});

test("interface cookies use a year expiry, root path, strict SameSite, and Secure on HTTPS", (t) => {
  const before = Date.now();
  const { store, cookieJar } = browser(t);
  store.write(state);
  const [cookie] = cookieJar.getCookiesSync("https://example.test/");
  assert.equal(cookie.key, COOKIE_NAME);
  assert.equal(cookie.path, "/");
  assert.equal(cookie.sameSite, "strict");
  assert.equal(cookie.secure, true);
  assert.equal(cookie.maxAge, 365 * 86400);
  assert.ok(cookie.expires.valueOf() >= before + 365 * 86400000 - 1000);
  assert.ok(cookie.expires.valueOf() <= Date.now() + 365 * 86400000);
  assert.deepEqual(cookieJar.getCookiesSync("http://example.test/"), []);
  const local = browser(t, "http://localhost:3000/calculator");
  local.store.write(state);
  assert.deepEqual(local.store.read(), state);
  assert.equal(local.cookieJar.getCookiesSync("http://localhost:3000/")[0].secure, false);
});

test("malformed and unsupported interface cookies are ignored without replacement", (t) => {
  const { store, document } = browser(t);
  for (const raw of ["%", "%7B", "not-json"]) {
    document.cookie = `${COOKIE_NAME}=${raw}; Path=/`;
    const previous = document.cookie;
    assert.equal(store.read(), null);
    assert.equal(document.cookie, previous);
  }
  for (const payload of [null, [], {}, { version: 1 }, { version: 2, state }, { version: "1", state }, { version: 1, state, consent: true }, { version: 1, state: { ...state, calculated: "true" } }]) {
    inject(document, payload);
    const previous = document.cookie;
    assert.equal(store.read(), null, JSON.stringify(payload));
    assert.equal(document.cookie, previous);
  }
});

test("invalid interface fields are rejected on writes and reads while preserving previous cookies", (t) => {
  const { store, document } = browser(t);
  store.write(state);
  const previous = document.cookie;
  const invalid = [
    null, [], {}, { ...state, unexpected: true },
    { ...state, values: [] }, { ...state, values: new Date() }, { ...state, values: { weapon: 1 } }, { ...state, values: { weapon: null } },
    { ...state, values: { "Uppercase": true } }, { ...state, values: { "bad_id": true } }, { ...state, values: { "bad key": true } },
    { ...state, values: { ["a".repeat(65)]: true } }, { ...state, values: { weapon: "a".repeat(513) } },
    { ...state, values: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`control-${index}`, false])) },
    { ...state, attachmentIds: {} }, { ...state, attachmentIds: new Array(1) }, { ...state, attachmentIds: [null] },
    { ...state, attachmentIds: [""] }, { ...state, attachmentIds: [" "] }, { ...state, attachmentIds: ["a".repeat(257)] },
    { ...state, attachmentIds: Array(33).fill("attachment") },
    { ...state, sections: [] }, { ...state, sections: { "weapon-section": "true" } }, { ...state, sections: { "invalid_id": true } },
    { ...state, sections: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`section-${index}`, false])) },
    { ...state, scroll: {} }, { ...state, scroll: { ...state.scroll, extra: 0 } }, { ...state, scroll: { ...state.scroll, pageY: "1" } },
    { ...state, scroll: { ...state.scroll, pageY: -1 } }, { ...state, scroll: { ...state.scroll, pageY: Infinity } },
    { ...state, scroll: { ...state.scroll, pageY: NaN } }, { ...state, scroll: { ...state.scroll, pageY: 10000001 } },
    { ...state, scroll: { ...state.scroll, tableTop: "1" } }, { ...state, scroll: { ...state.scroll, tableTop: -1 } },
    { ...state, scroll: { ...state.scroll, tableTop: Infinity } }, { ...state, scroll: { ...state.scroll, tableTop: NaN } },
    { ...state, scroll: { ...state.scroll, tableTop: 10000001 } },
    { ...state, calculated: 1 },
  ];
  for (const value of invalid) {
    assert.throws(() => store.write(value), /^Error: Interface changes could not be saved.*invalid/);
    assert.equal(document.cookie, previous);
  }
  for (const value of invalid) {
    inject(document, { version: 1, state: value });
    assert.equal(store.read(), null, JSON.stringify(value));
  }
});

test("interface field boundaries allow all documented values", (t) => {
  const { store } = browser(t);
  const boundary = {
    values: { ["a".repeat(64)]: "a".repeat(512), empty: "", enabled: false },
    attachmentIds: Array(32).fill("a"),
    sections: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`section-${index}`, false])),
    scroll: { pageX: 10000000, pageY: 0, setupTop: 10000000, tableLeft: 0.5, tableTop: 10000000 },
    calculated: false,
  };
  store.write(boundary);
  assert.deepEqual(store.read(), boundary);
  store.write({ ...state, attachmentIds: ["a".repeat(256)] });
  assert.equal(store.read().attachmentIds[0].length, 256);
  store.write({ ...state, values: Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`control-${index}`, false])) });
  assert.equal(Object.keys(store.read().values).length, 50);
});

test("interface capacity failures preserve the previous state without truncation", (t) => {
  const { store, document } = browser(t);
  store.write(state);
  const previous = document.cookie;
  const oversized = { ...state, values: { weapon: "\u{1F680}".repeat(256), round: "\u{1F680}".repeat(256) } };
  assert.throws(() => store.write(oversized), /Interface changes could not be saved.*cookie's storage limit/);
  assert.equal(document.cookie, previous);
  assert.deepEqual(store.read(), state);
  const assignments = [];
  let saved = "";
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => saved,
    set: (cookie) => { assignments.push(cookie); saved = cookie.split(";")[0]; },
  });
  store.write(state);
  assert.ok(assignments[0].length <= 3800, "Successful writes include all attributes within the limit");
  assert.throws(() => store.write(oversized), /storage limit/);
  assert.equal(assignments.length, 1, "An oversized assignment is never sent to the browser");
});

test("clearing interface state deletes only its own cookie, including malformed state", (t) => {
  const { store, document, cookieJar } = browser(t);
  document.cookie = "unrelated=value; Path=/";
  document.cookie = "h3vrbc_favorites=consent-and-favorites; Path=/";
  store.write(state);
  store.clear();
  assert.equal(store.read(), null);
  assert.equal(document.cookie, "unrelated=value; h3vrbc_favorites=consent-and-favorites");
  assert.equal(cookieJar.getCookiesSync("https://example.test/").length, 2);
  const next = browser(t, "https://example.test/", cookieJar);
  assert.equal(next.store.read(), null);
  inject(document, { version: 9, state: null });
  store.clear();
  assert.equal(document.cookie, "unrelated=value; h3vrbc_favorites=consent-and-favorites");
});

test("blocked interface writes preserve the last saved state and return a readable error", (t) => {
  const { store, document } = browser(t);
  store.write(state);
  const previous = document.cookie;
  let writes = 0;
  Object.defineProperty(document, "cookie", { configurable: true, get: () => previous, set: () => { writes++; } });
  assert.deepEqual(store.read(), state);
  assert.equal(writes, 0);
  assert.throws(() => store.write({ ...state, calculated: false }), /Interface changes could not be saved.*Allow cookies/);
  assert.deepEqual(store.read(), state);
  assert.equal(writes, 1);
  assert.throws(() => store.clear(), /could not be removed.*browser settings/);
  assert.deepEqual(store.read(), state);
});

test("unavailable cookie APIs return no state and report write and deletion failures", (t) => {
  const { store, document } = browser(t);
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => { throw new Error("Unavailable"); },
    set: () => { throw new Error("Unavailable"); },
  });
  assert.equal(store.read(), null);
  assert.throws(() => store.write(state), /Interface changes could not be saved.*Allow cookies/);
  assert.throws(() => store.clear(), /could not be removed.*browser settings/);
});
