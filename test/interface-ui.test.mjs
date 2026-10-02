import test from "node:test";
import assert from "node:assert/strict";
import { CookieJar } from "jsdom";
import { MODEL } from "../public/physics.js";
import { mount, waitFor } from "./helpers/app.mjs";

const curve = (value) => ({ keys: [{ time: 0, value, inSlope: 0, outSlope: 0 }] });
const pose = (position = [0, 0, 0]) => ({ position, scale: [1, 1, 1], forward: [0, 0, 1], up: [0, 1, 0] });
const mountProfile = (position) => ({ front: position, rear: [...position], pose: pose(position), parentPose: pose(), parentToThis: false, scaleModifier: 1 });
const source = { bundle: "fixture", assetName: "interface", pathId: "1" };
const chamber = (caliberId, barrelLength) => ({ name: `Chamber ${caliberId}`, caliberId, barrelLength, multiplier: 1.2, position: [0, 0, 0] });
const rifle = { id: "Rifle", hashId: "M4Carbine", name: "Test Rifle", caliberId: 13, accuracyClass: 33,
  chambers: [chamber(13, 0.4)], muzzlePose: pose([0, 0, 0.4]), muzzleMounts: [mountProfile([0, 0, 0.4])],
  shotRule: { kind: "constant", value: 1 }, source };
const suppressor = { id: "Suppressor", hashId: "SuppressorMk12", name: "Test Suppressor", kind: "suppressor", componentClass: "Suppressor", accuracyClass: 100,
  rootPose: pose(), muzzleOffset: [0, 0, 0.18], muzzleForward: [0, 0, 1], muzzleUp: [0, 1, 0],
  canScaleToMount: true, bidirectional: false, muzzleMounts: [], source };
const dataset = {
  schemaVersion: 2, model: MODEL, source: { unityVersion: "5.6", assemblySha256: "test", inputs: [] },
  settings: { fixedDeltaTime: 0.01, dragCurve: curve(0), gravityModes: [{ name: "Realistic", value: 9.81 }, { name: "Lunar", value: 1.62 }],
    accuracyClasses: [{ id: 33, name: "AutoRifleModern", dropMult: 0.9, driftMult: 2 },
      { id: 100, name: "SuppressorPrecision", dropMult: 1.1, driftMult: 2 },
      { id: 122, name: "BarrelExtensionLong", dropMult: 1.3, driftMult: 1.2 }] },
  calibers: [13, 8].map((id) => ({ id, name: `Caliber ${id}`, barrelCurve: curve(1), opticDropCurve: curve(0) })),
  weapons: [rifle, { ...rifle, id: "Combo", name: "Combination Gun", chambers: [chamber(13, 0.4), chamber(8, 0.25)], shotRule: { kind: "sticky", bonus: 2 } }],
  muzzleDevices: [suppressor,
    { ...suppressor, id: "Extender", hashId: "BarrelExtenderThinLong", name: "Test Extender", kind: "device", componentClass: "MuzzleDevice", accuracyClass: 122,
      muzzleOffset: [0, 0, 0.2], muzzleMounts: [{ ...mountProfile([0, 0, 0.2]), followsRootParent: true }] },
    { ...suppressor, id: "Reversible", name: "Reversible Suppressor", bidirectional: true }],
  scenes: [{ file: "level0", name: "IndoorRange", maxRange: 1000, catchHeight: -50 },
    { file: "level1", name: "OutdoorRange", maxRange: 2000, catchHeight: -75 }],
  rounds: [["556x45mmCartridgeFMJ", 13, "Rifle FMJ", "FMJ"], ["Round8", 8, "Round 8 FMJ", "FMJ"], ["Round8SP", 8, "Soft Point 8", "SP"]]
    .map(([id, caliberId, name, roundClass]) => ({ id, caliberId, name, roundClass, numProjectiles: 1,
      mass: 0.01, diameter: 0.01, muzzleVelocity: 800, flightVelocityMultiplier: 1, airDragMultiplier: 1,
      gravityMultiplier: 1, maxRange: 5000, maxRangeRandom: 0, deletesOnStraightDown: true, source })),
  excluded: [],
};
const sectionIds = ["favorites-section", "simulation-section", "simulation-timing", "weapon-section", "projectile-data",
  "muzzle-section", "sight-section", "overrides-section", "methodology-section", "excluded-section"];
const favorite = { id: "saved-rifle", name: "Saved rifle", weaponId: "Rifle", chamberIndex: 0,
  roundId: "556x45mmCartridgeFMJ", attachmentIds: ["Extender", "Suppressor"] };
const consentPayload = (favorites = []) => ({ version: 1, consent: true, favorites });

function cookies(initial = {}) {
  const cookieJar = new CookieJar();
  cookieJar.setCookieSync("unrelated=keep; Path=/", "http://localhost/");
  for (const [name, value] of Object.entries(initial))
    cookieJar.setCookieSync(`${name}=${typeof value === "string" ? value : encodeURIComponent(JSON.stringify(value))}; Path=/`, "http://localhost/");
  const writes = [];
  const original = cookieJar.setCookieSync.bind(cookieJar);
  cookieJar.setCookieSync = (...args) => {
    writes.push(args[0]);
    return original(...args);
  };
  const stored = (name = "h3vrbc_interface") => {
    const cookie = cookieJar.getCookiesSync("http://localhost/").find((item) => item.key === name);
    return cookie ? JSON.parse(decodeURIComponent(cookie.value)) : null;
  };
  return { cookieJar, writes, stored };
}

async function controls(name, t, jar = cookies()) {
  const { dom, close } = await mount(dataset, name, { cookieJar: jar.cookieJar });
  // jsdom has no page layout, so model its scroll position explicitly.
  dom.window.scrollTo = (x, y) => { dom.window.scrollX = x; dom.window.scrollY = y; };
  let closed = false;
  const stop = () => { if (!closed) { closed = true; close(); } };
  t.after(stop);
  const $ = (id) => dom.window.document.getElementById(id);
  await waitFor(() => !$("workspace").hidden || !$("load-error").hidden);
  await new Promise((resolve) => dom.window.requestAnimationFrame(() =>
    dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(resolve))));
  assert.equal($("load-error").hidden, true, $("load-error").textContent);
  const set = (id, value, type = "input") => {
    $(id).value = value;
    $(id).dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  };
  const check = (id, checked) => {
    $(id).checked = checked;
    $(id).dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    $(id).dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const add = (id) => { set("muzzle-device", id, "change"); $("add-muzzle-device").click(); };
  const flush = () => dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  const recalculate = async () => {
    $("setup-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => !$("setup-form").querySelector('button[type="submit"]').disabled);
    assert.equal($("solution").hidden, false, $("calculation-error").textContent);
  };
  const values = () => Object.fromEntries([...$("setup-form").querySelectorAll("input[id], select[id]")]
    .filter((item) => item.id !== "favorites-consent")
    .map((item) => [item.id, item.type === "checkbox" ? item.checked : item.value]));
  const sections = () => Object.fromEntries(sectionIds.map((id) => [id, $(id).open]));
  const loadout = () => [...$("muzzle-loadout").children].map((item) => item.querySelector("span").textContent);
  return { $, dom, set, check, add, flush, recalculate, values, sections, loadout, close: stop, ...jar };
}

test("interface cookies require opt-in, and opting out cancels pending saves without clearing the active result", async (t) => {
  const app = await controls("interface-consent", t);
  const { $, dom, set, check, flush, stored, writes, cookieJar } = app;
  assert.equal($("favorites-consent").checked, false);
  set("target-range", "225");
  $("simulation-section").open = false;
  $("simulation-section").dispatchEvent(new dom.window.Event("toggle"));
  flush();
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.deepEqual(writes, []);
  assert.equal(stored(), null);
  await app.recalculate();
  check("favorites-consent", true);
  flush();
  assert.equal(stored().state.values["target-range"], "225");
  assert.equal(stored().state.calculated, true);
  set("favorite-name", "Pending edit");
  const before = $("target-label").textContent;
  check("favorites-consent", false);
  const afterOptOut = writes.length;
  flush();
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(writes.length, afterOptOut, "A previously scheduled save cannot recreate cookies after opt-out");
  assert.equal(stored(), null);
  assert.equal(stored("h3vrbc_favorites"), null);
  assert.equal(cookieJar.getCookieStringSync("http://localhost/"), "unrelated=keep");
  assert.equal($("target-range").value, "225");
  assert.equal($("target-label").textContent, before);
  assert.equal($("solution").hidden, false);
  assert.equal($("export-csv").disabled, false);
});

test("refresh restores the complete calculated interface, ordered devices, manual measurements, filters and disclosure state", async (t) => {
  const jar = cookies();
  const app = await controls("interface-full-save", t, jar);
  const { $, dom, set, check, add } = app;
  check("favorites-consent", true);
  set("weapon", "Combo", "change");
  set("weapon-chamber", "1", "change");
  set("shot-charge", "42.5");
  set("ammunition", "Round8SP", "change");
  add("Extender");
  add("Suppressor");
  add("Extender");
  $("muzzle-loadout").querySelector('[data-index="2"][data-action="earlier"]').click();
  set("muzzle-geometry-mode", "manual", "change");
  for (const [id, value] of Object.entries({ "barrel-length": "0.93", "muzzle-forward-shift": "14.2", "muzzle-up-shift": "1.3",
    "chamber-multiplier": "1.17", "velocity-multiplier": "1.4", "scene-limit": "1500", "fixed-step": "12", "first-step": "3",
    "world-height": "4.25", "zero-range": "75", "sight-height": "7.5", "sight-setback": "2", "firing-angle": "3.5",
    "target-range": "280", "range-step": "50" })) set(id, value);
  set("scene", "level1", "change");
  set("scene-limit", "1500");
  set("gravity", "1.62", "change");
  set("zero-model", "calculated", "change");
  check("confirm-muzzle-geometry", true);
  set("favorite-name", "My sticky setup");
  $("save-favorite").click();
  set("weapon-search", "Combination");
  set("ammo-search", "soft");
  set("muzzle-search", "Extender");
  set("muzzle-kind", "device", "change");
  await app.recalculate();
  sectionIds.forEach((id, index) => {
    $(id).open = index % 2 === 1;
    $(id).dispatchEvent(new dom.window.Event("toggle"));
  });
  const setupScroll = dom.window.document.querySelector(".setup-scroll");
  const tableScroll = dom.window.document.querySelector(".table-scroll");
  setupScroll.scrollTop = 321;
  tableScroll.scrollLeft = 86;
  tableScroll.scrollTop = 123;
  dom.window.scrollTo(17, 444);
  dom.window.dispatchEvent(new dom.window.Event("scroll"));
  setupScroll.dispatchEvent(new dom.window.Event("scroll"));
  tableScroll.dispatchEvent(new dom.window.Event("scroll"));
  const expected = { values: app.values(), sections: app.sections(), loadout: app.loadout(),
    metrics: [$("hold-value").textContent, $("windage-value").textContent, $("muzzle-speed").textContent], rows: $("range-rows").textContent };
  app.flush();
  assert.deepEqual(jar.stored().state.attachmentIds, ["Extender", "Extender", "Suppressor"]);
  assert.equal(jar.stored().state.calculated, true);
  app.close();
  jar.writes.length = 0;
  const restored = await controls("interface-full-reload", t, jar);
  assert.equal(restored.$("favorites-consent").checked, true);
  assert.deepEqual(restored.values(), expected.values);
  assert.deepEqual(restored.sections(), expected.sections);
  assert.deepEqual(restored.loadout(), expected.loadout);
  assert.equal(restored.$("weapon-chamber-group").hidden, false);
  assert.equal(restored.$("shot-charge-group").hidden, false);
  assert.equal(restored.$("manual-muzzle-geometry").hidden, false);
  assert.equal(restored.$("confirm-muzzle-geometry").checked, true);
  assert.equal(restored.$("solution").hidden, false);
  assert.equal(restored.$("export-csv").disabled, false);
  assert.deepEqual([restored.$("hold-value").textContent, restored.$("windage-value").textContent, restored.$("muzzle-speed").textContent], expected.metrics);
  assert.equal(restored.$("range-rows").textContent, expected.rows);
  assert.equal(restored.dom.window.document.querySelector(".setup-scroll").scrollTop, 321);
  assert.equal(restored.dom.window.document.querySelector(".table-scroll").scrollLeft, 86);
  assert.equal(restored.dom.window.document.querySelector(".table-scroll").scrollTop, 123);
  assert.equal(restored.dom.window.scrollX, 17);
  assert.equal(restored.dom.window.scrollY, 444);
  await new Promise((resolve) => setTimeout(resolve, 180));
  restored.flush();
  assert.deepEqual(jar.writes, [], "Reading and re-rendering an unchanged snapshot does not refresh cookies");
});

test("pending edits preserve blank and invalid raw fields across refresh without calculating", async (t) => {
  const jar = cookies();
  const app = await controls("interface-pending-save", t, jar);
  app.check("favorites-consent", true);
  app.set("weapon", "Combo", "change");
  app.set("weapon-chamber", "1", "change");
  app.set("ammunition", "Round8SP", "change");
  app.add("Reversible");
  app.set("muzzle-geometry-mode", "manual", "change");
  for (const [id, value] of Object.entries({ "shot-charge": "", "target-range": "-2", "scene-limit": "", "barrel-length": "",
    "muzzle-forward-shift": "", "muzzle-up-shift": "-99", "sight-height": "", "fixed-step": "0", "first-step": "" })) app.set(id, value);
  app.set("favorite-name", "An unfinished setup");
  app.flush();
  const expected = app.values();
  assert.equal(jar.stored().state.calculated, false);
  app.close();
  jar.writes.length = 0;
  const restored = await controls("interface-pending-reload", t, jar);
  assert.deepEqual(restored.values(), expected);
  assert.deepEqual(restored.loadout(), ["Reversible Suppressor"]);
  assert.equal(restored.$("manual-muzzle-geometry").hidden, false);
  assert.equal(restored.$("confirm-muzzle-geometry").checked, false);
  assert.equal(restored.$("solution").hidden, true);
  assert.equal(restored.$("export-csv").disabled, true);
  assert.equal(restored.$("calculation-error").hidden, false);
  restored.flush();
  assert.deepEqual(jar.writes, []);
});

test("a saved ammunition search with no matches keeps the saved round available on refresh", async (t) => {
  const jar = cookies();
  const app = await controls("interface-no-match-save", t, jar);
  app.check("favorites-consent", true);
  app.set("weapon", "Combo", "change");
  app.set("weapon-chamber", "1", "change");
  app.set("ammunition", "Round8SP", "change");
  app.flush();
  const saved = jar.stored();
  app.close();
  saved.state.values["ammo-search"] = "No matching ammunition";
  saved.state.calculated = false;
  const restoredJar = cookies({ h3vrbc_favorites: consentPayload(), h3vrbc_interface: saved });
  const restored = await controls("interface-no-match-reload", t, restoredJar);
  assert.equal(restored.$("ammo-search").value, "No matching ammunition");
  assert.equal(restored.$("ammunition").value, "Round8SP");
  assert.equal(restored.$("ammunition").options.length, 1);
  assert.equal(restored.$("solution").hidden, true);
  assert.equal(restored.$("export-csv").disabled, true);
  restored.flush();
  assert.deepEqual(restoredJar.writes, []);
});

test("loading favorites and changing device order autosave the new active setup", async (t) => {
  const jar = cookies({ h3vrbc_favorites: consentPayload([favorite]) });
  const app = await controls("interface-favorite-action-save", t, jar);
  app.set("favorite-select", favorite.id, "change");
  app.$("load-favorite").click();
  app.$("muzzle-loadout").querySelector('[data-index="1"][data-action="earlier"]').click();
  await waitFor(() => jar.stored()?.state.attachmentIds.join(",") === "Suppressor,Extender");
  assert.equal(jar.stored().state.values.weapon, "Rifle");
  assert.equal(jar.stored().state.values.ammunition, "556x45mmCartridgeFMJ");
  assert.equal(jar.stored().state.calculated, false);
  app.close();
  const restored = await controls("interface-favorite-action-reload", t, jar);
  assert.equal(restored.$("favorite-select").value, favorite.id);
  assert.deepEqual(restored.loadout(), ["Test Suppressor", "Test Extender"]);
  assert.equal(restored.$("solution").hidden, true);
  restored.$("clear-muzzle-devices").click();
  restored.flush();
  assert.deepEqual(jar.stored().state.attachmentIds, []);
});

test("favorite management and catalog browsing retain the current calculation across refresh", async (t) => {
  const jar = cookies();
  const app = await controls("interface-management-save", t, jar);
  app.check("favorites-consent", true);
  app.set("weapon", "Rifle", "change");
  await app.recalculate();
  app.set("favorite-name", "Current rifle");
  app.$("save-favorite").click();
  app.set("weapon-search", "Rifle");
  app.set("muzzle-search", "precision");
  assert.equal(app.$("solution").hidden, false);
  app.flush();
  assert.equal(jar.stored().state.calculated, true);
  const expected = app.$("hold-value").textContent;
  app.close();
  const restored = await controls("interface-management-reload", t, jar);
  assert.equal(restored.$("solution").hidden, false);
  assert.equal(restored.$("hold-value").textContent, expected);
  assert.equal(restored.$("favorite-name").value, "Current rifle");
  assert.equal(restored.$("weapon-search").value, "Rifle");
  assert.equal(restored.$("muzzle-search").value, "precision");
});

test("stale active setup references reject the entire snapshot while keeping favorites and consent", async (t) => {
  const sourceJar = cookies();
  const app = await controls("interface-stale-source", t, sourceJar);
  app.check("favorites-consent", true);
  app.set("weapon", "Combo", "change");
  app.set("weapon-chamber", "1", "change");
  app.set("ammunition", "Round8SP", "change");
  app.add("Extender");
  app.set("target-range", "222");
  app.flush();
  const snapshot = sourceJar.stored();
  app.close();
  const mutations = [
    (state) => { state.values.weapon = "RemovedWeapon"; },
    (state) => { state.values["weapon-chamber"] = "9"; },
    (state) => { state.values.ammunition = "RemovedRound"; },
    (state) => { state.values.ammunition = "556x45mmCartridgeFMJ"; },
    (state) => { state.attachmentIds.push("RemovedAttachment"); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    await t.test(`stale reference ${index + 1}`, async (t) => {
      const saved = structuredClone(snapshot);
      mutate(saved.state);
      const jar = cookies({ h3vrbc_favorites: consentPayload([favorite]), h3vrbc_interface: saved });
      const restored = await controls(`interface-stale-${index}`, t, jar);
      assert.equal(restored.$("favorites-consent").checked, true);
      assert.equal(restored.$("favorite-select").options.length, 2);
      assert.equal(restored.$("weapon").value, "");
      assert.equal(restored.$("ammunition").value, "556x45mmCartridgeFMJ");
      assert.notEqual(restored.$("target-range").value, "222", "The remainder of a stale setup is not partially applied");
      assert.deepEqual(restored.loadout(), []);
      assert.match((restored.$("interface-status") ?? restored.$("favorite-status")).textContent,
        /unavailable|cannot|could not|no longer|restore|saved/i);
      assert.equal(restored.$("solution").hidden, false);
      await new Promise((resolve) => setTimeout(resolve, 180));
      assert.deepEqual(jar.writes, []);
      restored.close();
    });
  }
});

test("malformed and orphaned interface cookies do not grant consent or overwrite browser cookies", async (t) => {
  const cases = [
    { name: "bad-encoding", value: "%E0%A4%A", consent: false },
    { name: "bad-json", value: "not-json", consent: true },
    { name: "bad-version", value: { version: 2, state: {} }, consent: true },
    { name: "bad-state", value: { version: 1, state: { values: null, attachmentIds: [] } }, consent: true },
    { name: "orphan", value: { version: 1, state: { values: { weapon: "Rifle", ammunition: "556x45mmCartridgeFMJ", "target-range": "222" },
      attachmentIds: [], sections: {}, scroll: { pageX: 0, pageY: 0, setupTop: 0, tableLeft: 0 }, calculated: false } }, consent: false },
  ];
  for (const item of cases) {
    await t.test(item.name, async (t) => {
      const jar = cookies({ h3vrbc_interface: item.value, ...(item.consent ? { h3vrbc_favorites: consentPayload([favorite]) } : {}) });
      const app = await controls(`interface-malformed-${item.name}`, t, jar);
      assert.equal(app.$("favorites-consent").checked, item.consent);
      assert.equal(app.$("weapon").value, "");
      assert.notEqual(app.$("target-range").value, "222");
      assert.equal(app.$("solution").hidden, false);
      await new Promise((resolve) => setTimeout(resolve, 180));
      assert.deepEqual(jar.writes, []);
      assert.ok(jar.cookieJar.getCookieStringSync("http://localhost/").includes("unrelated=keep"));
      app.close();
    });
  }
});
