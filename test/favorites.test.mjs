import test from "node:test";
import assert from "node:assert/strict";
import { CookieJar, JSDOM } from "jsdom";
import { createFavoriteStore } from "../public/favorites.js";

const COOKIE_NAME = "h3vrbc_favorites";
const favorite = {
  id: "favorite-1",
  name: "Range rifle",
  weaponId: "Rifle",
  chamberIndex: 0,
  roundId: "556x45mmCartridgeFMJ",
  attachmentIds: ["BarrelExtenderThinLong", "SuppressorMk12", "SuppressorMk12"],
};
const opticFavorite = { ...favorite, id: "favorite-2", name: "Scoped rifle", opticId: "Scope:42",
  opticMountIndex: 1, opticRailPosition: 0.175, zeroModel: "game", zeroRange: 275 };

function browser(t, url = "https://example.test/calculator", cookieJar = new CookieJar()) {
  const dom = new JSDOM("", { url, cookieJar });
  t.after(() => dom.window.close());
  return { document: dom.window.document, cookieJar, store: createFavoriteStore(dom.window.document) };
}

function inject(document, payload) {
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(JSON.stringify(payload))}; Path=/`;
}

test("favorites default to opt-out and reading never writes cookies", (t) => {
  const { store, document, cookieJar } = browser(t);
  assert.equal(store.read(), null);
  assert.equal(document.cookie, "");
  assert.deepEqual(cookieJar.getCookiesSync("https://example.test/"), []);
  store.clear();
  assert.equal(document.cookie, "");
});

test("explicit writes persist consent and ordered attachment IDs across page loads", (t) => {
  const { store, document, cookieJar } = browser(t);
  store.write([favorite]);
  assert.deepEqual(store.read(), [favorite]);
  const payload = JSON.parse(decodeURIComponent(document.cookie.slice(`${COOKIE_NAME}=`.length)));
  assert.deepEqual(payload, { version: 1, consent: true, favorites: [favorite] });
  const next = browser(t, "https://example.test/another/page", cookieJar);
  assert.deepEqual(next.store.read(), [favorite]);
  const result = next.store.read();
  result[0].attachmentIds.push("OtherAttachment");
  assert.deepEqual(store.read(), [favorite], "Returned data cannot mutate saved records");
  next.store.write([]);
  assert.deepEqual(next.store.read(), [], "An empty list still records explicit consent");
});

test("optic favorites round-trip alongside unchanged legacy records without rewriting reads", (t) => {
  const { store, document, cookieJar } = browser(t);
  store.write([favorite, opticFavorite]);
  assert.deepEqual(store.read(), [favorite, opticFavorite]);
  const previous = document.cookie;
  const next = browser(t, "https://example.test/another/page", cookieJar);
  assert.deepEqual(next.store.read(), [favorite, opticFavorite]);
  assert.equal(document.cookie, previous);
  const manual = { ...opticFavorite, opticId: "", opticMountIndex: null, opticRailPosition: null,
    zeroModel: "calculated", zeroRange: 75 };
  store.write([manual]);
  assert.deepEqual(store.read(), [manual]);
});

test("partial or invalid optic/zero settings cannot overwrite existing favorites", (t) => {
  const { store, document } = browser(t);
  store.write([favorite, opticFavorite]);
  const previous = document.cookie;
  const partial = { ...favorite, opticId: "Scope:42" };
  const missingRange = { ...opticFavorite };
  delete missingRange.zeroRange;
  for (const value of [partial, missingRange,
    ...[null, 42, " ", "x".repeat(257)].map((opticId) => ({ ...opticFavorite, opticId })),
    ...[-1, 0.5, "1", Infinity].map((opticMountIndex) => ({ ...opticFavorite, opticMountIndex })),
    ...[-0.1, 1.1, NaN, "0.5"].map((opticRailPosition) => ({ ...opticFavorite, opticRailPosition })),
    ...[0, 5001, 100.5, NaN, "100"].map((zeroRange) => ({ ...opticFavorite, zeroRange })),
    { ...opticFavorite, zeroModel: "unknown" },
    { ...opticFavorite, opticId: "" },
    { ...opticFavorite, opticMountIndex: null },
  ]) {
    assert.throws(() => store.write([value]), /favorite setups are invalid/);
    assert.equal(document.cookie, previous);
  }
  for (const zeroRange of [1, 5000]) {
    const value = { ...opticFavorite, zeroRange };
    store.write([value]);
    assert.deepEqual(store.read(), [value]);
  }
});

test("favorites use a year expiry, root path, strict SameSite, and HTTPS Secure", (t) => {
  const before = Date.now();
  const { store, cookieJar } = browser(t);
  store.write([favorite]);
  const [cookie] = cookieJar.getCookiesSync("https://example.test/");
  assert.equal(cookie.key, COOKIE_NAME);
  assert.equal(cookie.path, "/");
  assert.equal(cookie.sameSite, "strict");
  assert.equal(cookie.secure, true);
  assert.equal(cookie.maxAge, 365 * 86400);
  const expires = cookie.expires.valueOf();
  assert.ok(expires >= before + 365 * 86400000 - 1000);
  assert.ok(expires <= Date.now() + 365 * 86400000);
  assert.deepEqual(cookieJar.getCookiesSync("http://example.test/"), []);
});

test("HTTP development pages omit Secure and can save favorites", (t) => {
  const { store, cookieJar } = browser(t, "http://localhost:3000/calculator");
  store.write([favorite]);
  assert.deepEqual(store.read(), [favorite]);
  const [cookie] = cookieJar.getCookiesSync("http://localhost:3000/");
  assert.equal(cookie.secure, false);
  assert.equal(cookie.sameSite, "strict");
});

test("malformed, unsupported, and non-consenting cookies do not grant consent", (t) => {
  const { store, document } = browser(t);
  for (const raw of ["%", "%7B", "not-json"]) {
    document.cookie = `${COOKIE_NAME}=${raw}; Path=/`;
    assert.equal(store.read(), null);
    assert.equal(document.cookie, `${COOKIE_NAME}=${raw}`, "Reading malformed cookies does not replace them");
  }
  for (const payload of [
    null, [], { version: 1 },
    { version: 2, consent: true, favorites: [favorite] },
    { version: 1, consent: false, favorites: [favorite] },
    { version: 1, consent: "true", favorites: [favorite] },
    { version: 1, consent: true, favorites: {} },
    { version: 1, consent: true, favorites: [null] },
    { version: 1, consent: true, favorites: [{ ...favorite, chamberIndex: -1 }] },
    { version: 1, consent: true, favorites: [{ ...favorite, attachmentIds: [null] }] },
    { version: 1, consent: true, favorites: [favorite, favorite] },
  ]) {
    inject(document, payload);
    assert.equal(store.read(), null, JSON.stringify(payload));
  }
});

test("record validation preserves existing favorites when writes are invalid", (t) => {
  const { store, document } = browser(t);
  store.write([favorite]);
  const previous = document.cookie;
  const invalid = [
    null, {}, [null], new Array(1), [favorite, favorite],
    [{ ...favorite, id: "" }], [{ ...favorite, id: "x".repeat(129) }],
    [{ ...favorite, name: " " }], [{ ...favorite, name: "x".repeat(61) }],
    [{ ...favorite, weaponId: "" }], [{ ...favorite, weaponId: "x".repeat(257) }],
    [{ ...favorite, chamberIndex: 0.5 }], [{ ...favorite, chamberIndex: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...favorite, roundId: 3 }], [{ ...favorite, attachmentIds: "SuppressorMk12" }],
    [{ ...favorite, attachmentIds: [" "] }], [{ ...favorite, attachmentIds: new Array(1) }], [{ ...favorite, unexpected: true }],
    [{ id: "missing-fields" }],
  ];
  for (const value of invalid) {
    assert.throws(() => store.write(value), /favorite setups are invalid/);
    assert.equal(document.cookie, previous);
  }
});

test("opting out immediately deletes the consent and favorites cookie", (t) => {
  const { store, document, cookieJar } = browser(t);
  document.cookie = "unrelated=value; Path=/";
  store.write([favorite]);
  store.clear();
  assert.equal(store.read(), null);
  assert.equal(document.cookie, "unrelated=value");
  assert.equal(cookieJar.getCookiesSync("https://example.test/").length, 1);
  const next = browser(t, "https://example.test/", cookieJar);
  assert.equal(next.store.read(), null);
  next.store.clear();
  inject(document, { version: 9, consent: true });
  store.clear();
  assert.equal(document.cookie, "unrelated=value", "Opt-out also removes malformed cookies");
});

test("capacity failures preserve the previous cookie without truncating favorites", (t) => {
  const { store, document } = browser(t);
  store.write([favorite]);
  const previous = document.cookie;
  const oversized = Array.from({ length: 20 }, (_, index) => ({
    ...favorite,
    id: `favorite-${index}`,
    name: "\u{1F680}".repeat(30),
    attachmentIds: ["x".repeat(256), "y".repeat(256)],
  }));
  assert.throws(() => store.write(oversized), /cookie's storage limit/);
  assert.equal(document.cookie, previous);
  assert.deepEqual(store.read(), [favorite]);
  let stored = [];
  for (let index = 0; index < 100; index++) {
    const next = [...stored, { ...favorite, id: `favorite-${index}` }];
    try {
      store.write(next);
      stored = next;
      assert.ok(document.cookie.length < 3800, "Successful cookies reserve room for attributes");
    } catch (error) {
      assert.match(error.message, /cookie's storage limit/);
      break;
    }
  }
  assert.ok(stored.length > 0 && stored.length < 100);
  assert.deepEqual(store.read(), stored);
});

test("cookie denial reports a readable error without pretending consent persisted", (t) => {
  const { store, document } = browser(t);
  let writes = 0;
  Object.defineProperty(document, "cookie", { configurable: true, get: () => "", set: () => { writes++; } });
  assert.equal(store.read(), null);
  assert.equal(writes, 0);
  assert.throws(() => store.write([favorite]), /browser did not save.*Allow cookies/);
  assert.equal(store.read(), null);
  store.clear();
  assert.equal(writes, 1, "Clearing an absent cookie needs no write");
});

test("failed deletion does not claim that an existing cookie was removed", (t) => {
  const { store, document } = browser(t);
  store.write([favorite]);
  const previous = document.cookie;
  Object.defineProperty(document, "cookie", { configurable: true, get: () => previous, set: () => {} });
  assert.throws(() => store.clear(), /browser did not remove.*browser settings/);
  assert.deepEqual(store.read(), [favorite]);
});

test("unavailable cookie APIs remain opted out and surface write errors", (t) => {
  const { store, document } = browser(t);
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => { throw new Error("Unavailable"); },
    set: () => { throw new Error("Unavailable"); },
  });
  assert.equal(store.read(), null);
  assert.throws(() => store.write([]), /browser did not save/);
  assert.throws(() => store.clear(), /browser did not remove/);
});
