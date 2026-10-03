import test from "node:test";
import assert from "node:assert/strict";
import { CookieJar } from "jsdom";
import { MODEL } from "../public/physics.js";
import { mount, waitFor } from "./helpers/app.mjs";

const curve = (value) => ({ keys: [{ time: 0, value, inSlope: 0, outSlope: 0 }] });
const pose = (position = [0, 0, 0]) => ({ position, scale: [1, 1, 1], forward: [0, 0, 1], up: [0, 1, 0] });
const mountProfile = (position) => ({ front: position, rear: [...position], pose: pose(position), parentPose: pose(), parentToThis: false, scaleModifier: 1 });
const source = { bundle: "fixture", assetName: "favorites", pathId: "1" };
const chamber = (caliberId, barrelLength) => ({ name: `Chamber ${caliberId}`, caliberId, barrelLength, multiplier: 1.2, position: [0, 0, 0] });
const rifle = { id: "Rifle", hashId: "M4Carbine", name: "Test Rifle", caliberId: 13, accuracyClass: 33,
  chambers: [chamber(13, 0.4)], muzzlePose: pose([0, 0, 0.4]), muzzleMounts: [mountProfile([0, 0, 0.4])],
  shotRule: { kind: "constant", value: 1 }, source };
const suppressor = { id: "Suppressor", hashId: "SuppressorMk12", name: "Test Suppressor", kind: "suppressor", componentClass: "Suppressor", accuracyClass: 100,
  rootPose: pose(), muzzleOffset: [0, 0, 0.18], muzzleForward: [0, 0, 1], muzzleUp: [0, 1, 0],
  canScaleToMount: true, bidirectional: false, muzzleMounts: [], source };
const dataset = {
  schemaVersion: 2, model: MODEL, source: { unityVersion: "5.6", assemblySha256: "test", inputs: [] },
  settings: { fixedDeltaTime: 0.01, dragCurve: curve(0), gravityModes: [{ name: "Realistic", value: 9.81 }],
    accuracyClasses: [{ id: 33, name: "AutoRifleModern", dropMult: 0.9, driftMult: 2 },
      { id: 100, name: "SuppressorPrecision", dropMult: 1.1, driftMult: 2 },
      { id: 122, name: "BarrelExtensionLong", dropMult: 1.3, driftMult: 1.2 }] },
  calibers: [13, 8].map((id) => ({ id, name: `Caliber ${id}`, barrelCurve: curve(1), opticDropCurve: curve(0) })),
  weapons: [rifle, { ...rifle, id: "Combo", name: "Combination Gun", chambers: [chamber(13, 0.4), chamber(8, 0.25)] }],
  muzzleDevices: [suppressor,
    { ...suppressor, id: "Extender", hashId: "BarrelExtenderThinLong", name: "Test Extender", kind: "device", componentClass: "MuzzleDevice", accuracyClass: 122,
      muzzleOffset: [0, 0, 0.2], muzzleMounts: [{ ...mountProfile([0, 0, 0.2]), followsRootParent: true }] },
    { ...suppressor, id: "Reversible", name: "Reversible Suppressor", bidirectional: true }],
  scenes: [{ file: "level0", name: "IndoorRange", maxRange: 1000, catchHeight: -50 }],
  rounds: [["556x45mmCartridgeFMJ", 13, "Rifle FMJ", "FMJ"], ["Round8", 8, "Round 8 FMJ", "FMJ"], ["Round8SP", 8, "Soft Point 8", "SP"]]
    .map(([id, caliberId, name, roundClass]) => ({ id, caliberId, name, roundClass, numProjectiles: 1,
      mass: 0.01, diameter: 0.01, muzzleVelocity: 800, flightVelocityMultiplier: 1, airDragMultiplier: 1,
      gravityMultiplier: 1, maxRange: 5000, maxRangeRandom: 0, deletesOnStraightDown: true, source })),
  excluded: [],
};

const record = (changes = {}) => ({ id: "saved-rifle", name: "Saved rifle", weaponId: "Rifle", chamberIndex: 0,
  roundId: "556x45mmCartridgeFMJ", attachmentIds: ["Suppressor"], ...changes });
const payload = (favorites) => ({ version: 1, consent: true, favorites });

function trackedCookies(value) {
  const cookieJar = new CookieJar();
  cookieJar.setCookieSync("unrelated=keep; Path=/", "http://localhost/");
  if (value !== undefined) cookieJar.setCookieSync(`h3vrbc_favorites=${value}; Path=/`, "http://localhost/");
  const writes = [];
  const original = cookieJar.setCookieSync.bind(cookieJar);
  cookieJar.setCookieSync = (...args) => {
    writes.push(args[0]);
    return original(...args);
  };
  return { cookieJar, writes };
}

async function controls(name, t, value) {
  const cookies = trackedCookies(value);
  const { dom, close } = await mount(dataset, name, { cookieJar: cookies.cookieJar });
  t.after(close);
  const $ = (id) => dom.window.document.getElementById(id);
  await waitFor(() => !$("solution").hidden || !$("load-error").hidden);
  assert.equal($("load-error").hidden, true, $("load-error").textContent);
  const set = (id, value, type = "input") => {
    $(id).value = value;
    $(id).dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  };
  const consent = (checked) => {
    $("favorites-consent").checked = checked;
    for (const type of ["input", "change"]) $("favorites-consent").dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  };
  const add = (id) => {
    set("muzzle-device", id, "change");
    $("add-muzzle-device").click();
  };
  const recalculate = async () => {
    const submit = $("setup-form").querySelector('button[type="submit"]');
    $("setup-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => !submit.disabled);
    assert.equal($("solution").hidden, false, $("calculation-error").textContent);
  };
  const stored = () => {
    const cookie = cookies.cookieJar.getCookiesSync("http://localhost/").find((item) => item.key === "h3vrbc_favorites");
    return cookie ? JSON.parse(decodeURIComponent(cookie.value)) : null;
  };
  const choices = () => [...$("favorite-select").options].filter((item) => item.value);
  return { $, dom, set, consent, add, recalculate, stored, choices, ...cookies };
}

test("favorites default to opt-out and do not write cookies or alter the current solution", async (t) => {
  const { $, cookieJar, writes, stored, choices } = await controls("favorites-default", t);
  assert.equal($("favorites-section").open, true);
  assert.equal($("favorites-consent").checked, false);
  assert.equal($("favorites-controls").hidden, true);
  assert.equal($("favorites-controls").disabled, true);
  for (const id of ["save-favorite", "load-favorite", "delete-favorite"]) {
    assert.equal($(id).type, "button", `${id} cannot submit the calculation form`);
    assert.equal($(id).disabled, true);
    $(id).click();
  }
  assert.equal(stored(), null);
  assert.equal(choices().length, 0);
  assert.deepEqual(writes, []);
  assert.equal(cookieJar.getCookieStringSync("http://localhost/"), "unrelated=keep");
  assert.equal($("solution").hidden, false);
  assert.equal($("export-csv").disabled, false);
});

test("explicit opt-in saves the loadout and zero setting without target range or manual overrides", async (t) => {
  const { $, dom, set, consent, add, recalculate, stored, choices } = await controls("favorites-save-load", t);
  consent(true);
  assert.equal($("favorites-controls").hidden, false);
  assert.equal($("favorites-controls").disabled, false);
  assert.equal($("solution").hidden, false, "Consent does not invalidate the current result");
  assert.deepEqual(stored(), payload([]));
  $("save-favorite").click();
  assert.equal(stored().favorites.length, 0, "A manual setup cannot be saved as a weapon favorite");
  assert.match($("favorite-status").textContent, /weapon/i);

  set("weapon", "Combo", "change");
  set("weapon-chamber", "1", "change");
  set("ammunition", "Round8SP", "change");
  add("Extender");
  add("Suppressor");
  add("Extender");
  $("muzzle-loadout").querySelector('[data-index="2"][data-action="earlier"]').click();
  // Multiple-barrel weapons require a measured pose for attached devices.
  set("muzzle-geometry-mode", "manual", "change");
  set("barrel-length", "0.85");
  set("muzzle-forward-shift", "45");
  set("muzzle-up-shift", "0");
  $("confirm-muzzle-geometry").checked = true;
  $("confirm-muzzle-geometry").dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  set("target-range", "450");
  set("sight-height", "7");
  set("velocity-multiplier", "1.8");
  await recalculate();

  let submissions = 0;
  let invalidations = 0;
  $("setup-form").addEventListener("submit", () => submissions++);
  $("setup-form").addEventListener("invalid", () => invalidations++, true);
  set("favorite-name", "My combination setup");
  set("favorite-name", "My combination setup", "change");
  assert.equal($("solution").hidden, false, "Favorite names do not change the shot");
  // A save must work independently of native validation of unrelated shot fields.
  $("target-range").value = "";
  $("save-favorite").click();
  $("target-range").value = "450";
  assert.equal(submissions, 0);
  assert.equal(invalidations, 0);
  assert.equal($("solution").hidden, false);
  assert.equal($("export-csv").disabled, false);
  assert.equal(choices().length, 1);
  const saved = stored().favorites[0];
  assert.deepEqual(saved, { id: saved.id, name: "My combination setup", weaponId: "Combo", chamberIndex: 1,
    roundId: "Round8SP", attachmentIds: ["Extender", "Extender", "Suppressor"],
    opticId: "", opticMountIndex: null, opticRailPosition: null, zeroModel: "game", zeroRange: 100 });
  assert.ok(saved.id);

  set("favorite-name", "");
  $("save-favorite").click();
  assert.equal(stored().favorites.length, 1, "Saving an identical combination does not duplicate it");
  assert.equal(stored().favorites[0].id, saved.id);
  assert.ok(stored().favorites[0].name.trim(), "A blank name produces a usable default");
  assert.equal($("solution").hidden, false);
  set("favorite-name", "Renamed with Enter");
  const enter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  $("favorite-name").dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true, "Enter saves without submitting the calculation form");
  assert.equal(stored().favorites[0].name, "Renamed with Enter");
  assert.equal(stored().favorites.length, 1);
  assert.equal(submissions, 0);
  assert.equal($("solution").hidden, false);

  $("clear-muzzle-devices").click();
  set("weapon", "Rifle", "change");
  set("target-range", "600");
  set("sight-height", "9");
  set("velocity-multiplier", "2.2");
  await recalculate();
  set("favorite-select", saved.id, "change");
  assert.equal($("solution").hidden, false, "Browsing favorites does not change the shot");
  set("weapon-search", "Rifle");
  set("ammo-search", "no matching ammunition");
  $("load-favorite").click();
  assert.equal($("weapon").value, "Combo");
  assert.equal($("weapon-chamber").value, "1");
  assert.equal($("ammunition").value, "Round8SP");
  assert.equal($("weapon-search").value, "");
  assert.equal($("ammo-search").value, "");
  assert.deepEqual([...$("muzzle-loadout").children].map((item) => item.querySelector("span").textContent),
    ["Test Extender", "Test Extender", "Test Suppressor"]);
  assert.equal($("target-range").valueAsNumber, 600, "Range is independent of the saved combination");
  assert.equal($("sight-height").valueAsNumber, 9, "Sight measurements are independent of the favorite");
  assert.equal($("velocity-multiplier").valueAsNumber, 1, "The saved setup reapplies stock values instead of saving manual overrides");
  assert.equal($("muzzle-geometry-mode").value, "stock");
  assert.equal($("solution").hidden, true);
  assert.equal($("export-csv").disabled, true);
});

test("persisted consent restores the favorite list, names are text, and opting out removes only app cookies", async (t) => {
  const name = '<img src=x onerror="alert(1)">';
  const saved = record({ name });
  const { $, dom, set, consent, recalculate, stored, choices, writes, cookieJar } =
    await controls("favorites-cookie-reload", t, encodeURIComponent(JSON.stringify(payload([saved]))));
  assert.equal($("favorites-consent").checked, true);
  assert.equal($("favorites-controls").hidden, false);
  assert.equal(choices().length, 1);
  assert.equal(choices()[0].textContent, name);
  assert.equal($("favorites-section").querySelector("img"), null);
  assert.equal($("weapon").value, "", "Opening the app does not automatically apply a saved setup");
  assert.deepEqual(writes, [], "Reading existing consent and favorites does not refresh the cookie");
  set("favorite-select", saved.id, "change");
  assert.ok($("favorite-summary").textContent.includes("Test Rifle"));
  $("load-favorite").click();
  await recalculate();
  const before = [...new dom.window.FormData($("setup-form"))];
  const loadout = $("muzzle-loadout").textContent;
  consent(false);
  assert.equal($("favorites-consent").checked, false);
  assert.equal($("favorites-controls").hidden, true);
  assert.equal($("favorites-controls").disabled, true);
  assert.equal(stored(), null);
  assert.equal(choices().length, 0);
  assert.equal(cookieJar.getCookieStringSync("http://localhost/"), "unrelated=keep");
  assert.deepEqual([...new dom.window.FormData($("setup-form"))], before);
  assert.equal($("muzzle-loadout").textContent, loadout);
  assert.equal($("solution").hidden, false);
  assert.equal($("export-csv").disabled, false);
});

test("deleting favorites preserves the shot and the opted-in empty list", async (t) => {
  const { $, set, stored, choices, writes } = await controls("favorites-delete", t,
    encodeURIComponent(JSON.stringify(payload([record(), record({ id: "other", name: "Other", attachmentIds: [] })]))));
  set("favorite-select", "saved-rifle", "change");
  const favoriteWrites = () => writes.filter((cookie) => cookie.startsWith("h3vrbc_favorites="));
  const before = favoriteWrites().length;
  $("delete-favorite").click();
  assert.equal(favoriteWrites().length, before + 1);
  assert.deepEqual(stored().favorites.map((item) => item.id), ["other"]);
  assert.equal(choices().length, 1);
  set("favorite-select", "other", "change");
  $("delete-favorite").click();
  assert.deepEqual(stored(), payload([]));
  assert.equal(choices().length, 0);
  assert.equal($("favorites-consent").checked, true);
  assert.equal($("solution").hidden, false);
  assert.equal($("export-csv").disabled, false);
});

test("malformed cookies do not opt a user in or rewrite their cookies", async (t) => {
  const invalidValues = ["%E0%A4%A", "not-json", encodeURIComponent(JSON.stringify({ version: 2, consent: true, favorites: [record()] }))];
  for (const [index, value] of invalidValues.entries()) {
    await t.test(`malformed cookie ${index + 1}`, async (t) => {
      const { $, writes, choices, cookieJar } = await controls(`favorites-malformed-${index}`, t, value);
      assert.equal($("favorites-consent").checked, false);
      assert.equal($("favorites-controls").hidden, true);
      assert.equal(choices().length, 0);
      assert.deepEqual(writes, []);
      assert.ok(cookieJar.getCookieStringSync("http://localhost/").includes("unrelated=keep"));
      assert.equal($("solution").hidden, false);
    });
  }
});

test("unavailable favorite references cannot partially restore or invalidate an active setup", async (t) => {
  const unavailable = [
    record({ weaponId: "RemovedWeapon" }),
    record({ chamberIndex: 9 }),
    record({ roundId: "RemovedRound" }),
    record({ roundId: "Round8" }),
    record({ attachmentIds: ["Suppressor", "RemovedAttachment"] }),
  ];
  for (const [index, saved] of unavailable.entries()) {
    await t.test(`unavailable reference ${index + 1}`, async (t) => {
      const { $, dom, set, add, recalculate, writes, choices } = await controls(`favorites-unavailable-${index}`, t,
        encodeURIComponent(JSON.stringify(payload([saved]))));
      assert.equal(choices().length, 1, "Unavailable dataset entries remain visible for removal");
      set("weapon", "Rifle", "change");
      add("Suppressor");
      set("target-range", "350");
      await recalculate();
      set("favorite-select", saved.id, "change");
      assert.equal($("load-favorite").disabled, true);
      assert.ok($("favorite-summary").textContent.trim());
      const before = [...new dom.window.FormData($("setup-form"))];
      const loadout = $("muzzle-loadout").textContent;
      const writesBeforeLoad = [...writes];
      // A synthetic click also exercises validation when the disabled UI is bypassed.
      $("load-favorite").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
      assert.deepEqual([...new dom.window.FormData($("setup-form"))], before);
      assert.equal($("muzzle-loadout").textContent, loadout);
      assert.equal($("solution").hidden, false);
      assert.equal($("export-csv").disabled, false);
      assert.deepEqual(writes, writesBeforeLoad, "An unavailable favorite does not change persisted interface state");
      assert.deepEqual(writes.filter((cookie) => cookie.startsWith("h3vrbc_favorites=")), []);
    });
  }
});

test("loading an unverified attachment resets measured geometry and requires fresh verification", async (t) => {
  const { $, dom, set, consent, add, recalculate, stored } = await controls("favorites-manual-geometry", t);
  consent(true);
  set("weapon", "Rifle", "change");
  add("Reversible");
  set("muzzle-geometry-mode", "manual", "change");
  set("barrel-length", "0.75");
  set("muzzle-forward-shift", "35");
  set("muzzle-up-shift", "0");
  $("confirm-muzzle-geometry").checked = true;
  $("confirm-muzzle-geometry").dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await recalculate();
  $("save-favorite").click();
  assert.deepEqual(stored().favorites[0].attachmentIds, ["Reversible"]);
  assert.equal($("solution").hidden, false);
  $("clear-muzzle-devices").click();
  $("restore-weapon").click();
  await recalculate();
  $("load-favorite").click();
  assert.equal($("muzzle-geometry-mode").value, "stock");
  assert.equal($("confirm-muzzle-geometry").checked, false);
  assert.equal($("barrel-length").value, "", "The loaded setup cannot reuse old measured geometry");
  assert.match($("muzzle-note").textContent, /reversible mounting/);
  assert.equal($("setup-form").checkValidity(), false);
  assert.equal($("solution").hidden, true);
  assert.equal($("export-csv").disabled, true);
});
