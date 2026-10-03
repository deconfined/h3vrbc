import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mount, waitFor } from "./helpers/app.mjs";
import { MODEL } from "../public/physics.js";

const curve = (value) => ({ keys: [{ time: 0, value, inSlope: 0, outSlope: 0 }, { time: 100, value, inSlope: 0, outSlope: 0 }] });
const source = { bundle: "weapons", assetName: "testweapon", pathId: "42" };
const chamber = (caliberId, barrelLength, multiplier = 1) => ({ name: `Chamber ${caliberId}`, caliberId, barrelLength, multiplier });
const dataset = {
  schemaVersion: 2, model: MODEL,
  source: { unityVersion: "5.6", assemblySha256: "test", inputs: [] },
  settings: { fixedDeltaTime: 0.01, dragCurve: curve(0), gravityModes: [{ name: "Realistic", value: 9.81 }] },
  calibers: [13, 8, 21, 999].map((id) => ({ id, name: `Caliber ${id}`, barrelCurve: curve(1), opticDropCurve: curve(0) })),
  weapons: [
    { id: "Rifle", name: "Test Rifle", caliberId: 13, chambers: [chamber(13, 0.412201486494956, 1.149999976158142)], shotRule: { kind: "constant", value: 1 }, source },
    { id: "Combo", name: "Combination Gun", caliberId: 13, chambers: [chamber(13, 0.5), chamber(8, 0.25, 2.5)], shotRule: { kind: "constant", value: 0.8 }, source },
    { id: "Sticky", name: "Sticky Launcher", caliberId: 21, chambers: [chamber(21, 0.15, 3.5)], shotRule: { kind: "sticky", bonus: 2 }, source },
    { id: "Dynamic", name: "Dynamic Gun", caliberId: 13, chambers: [chamber(13, 0.2)], shotRule: { kind: "manual", reason: "Variable pressure." }, source },
    { id: "Missing", name: "Missing Prefab", caliberId: 8, chambers: [], presetUnavailable: "No stock prefab." },
    { id: "Unsupported", name: "Unsupported Flight", caliberId: 999, chambers: [chamber(999, 0.3)], shotRule: { kind: "constant", value: 1 }, source },
  ],
  scenes: [{ file: "level0", name: "IndoorRange", maxRange: 1000, catchHeight: -50 }],
  rounds: [13, 8, 21].map((id) => ({
    id: id === 13 ? "556x45mmCartridgeFMJ" : `Round${id}`, name: `Round ${id}`, caliberId: id, roundClass: "FMJ", numProjectiles: 1,
    mass: 0.01, diameter: 0.01, muzzleVelocity: 800, flightVelocityMultiplier: 1,
    airDragMultiplier: 1, gravityMultiplier: 1, maxRange: 5000, maxRangeRandom: 0,
    deletesOnStraightDown: true, source,
  })),
  excluded: [],
};
test("weapon picker autofills stock values, preserves manual overrides and filters by active chamber", async (t) => {
  const { dom, close } = await mount(dataset, "presets");
  t.after(close);
  const $ = (id) => dom.window.document.getElementById(id);
  const input = (id, value) => {
    $(id).value = value;
    $(id).dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const change = (id, value) => {
    $(id).value = value;
    $(id).dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const submit = $("setup-form").querySelector('button[type="submit"]');
  await waitFor(() => !$("solution").hidden || !$("load-error").hidden);
  assert.equal($("load-error").hidden, true, $("load-error").textContent);
  assert.equal($("calculation-error").hidden, true, $("calculation-error").textContent);

  await t.test("search narrows the list without changing the active setup or result", () => {
    input("weapon-search", "TEST rifle");
    assert.deepEqual([...$("weapon").options].map((item) => item.value), ["", "Rifle"]);
    assert.equal($("solution").hidden, false);
    change("weapon", "Rifle");
    assert.equal($("barrel-length").valueAsNumber, 0.412201486494956);
    assert.equal($("chamber-multiplier").valueAsNumber, 1.149999976158142);
    assert.equal($("velocity-multiplier").valueAsNumber, 1);
    assert.equal($("setup-form").checkValidity(), true, "Extracted precision must not cause step mismatch");
    assert.equal($("solution").hidden, true);
    input("weapon-search", "no matches");
    assert.equal($("weapon").value, "Rifle", "Active weapon must stay selected outside search");
    assert.match($("weapon-results").textContent, /0 matching weapons/);
    input("weapon-search", "");
  });

  await t.test("manual edits invalidate results and restoring reapplies the stock preset", async () => {
    input("barrel-length", "0.75");
    assert.match($("weapon-note").textContent, /Custom overrides/);
    $("restore-weapon").click();
    assert.equal($("barrel-length").valueAsNumber, 0.412201486494956);
    $("setup-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => !submit.disabled);
    assert.equal($("solution").hidden, false, $("calculation-error").textContent);
    assert.ok(Number($("muzzle-speed").textContent) > 800, "Preset chamber multiplier must affect launch speed");
    input("weapon-search", "combo");
    $("weapon-search").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal($("solution").hidden, false, "Browsing or blurring search must not invalidate an unchanged solution");
    input("velocity-multiplier", "1.2");
    assert.equal($("solution").hidden, true);
    assert.equal($("export-csv").disabled, true);
    change("weapon", "");
    assert.equal($("velocity-multiplier").valueAsNumber, 1.2, "Manual mode keeps current editable values");
    input("weapon-search", "");
  });

  await t.test("mixed-caliber barrels refill values and change compatible ammunition", () => {
    change("weapon", "Combo");
    assert.equal($("weapon-chamber-group").hidden, false);
    assert.equal($("ammunition").value, "556x45mmCartridgeFMJ");
    input("ammo-search", "no match");
    assert.equal(submit.disabled, true);
    change("weapon-chamber", "1");
    assert.equal($("ammo-search").value, "");
    assert.equal($("barrel-length").valueAsNumber, 0.25);
    assert.equal($("chamber-multiplier").valueAsNumber, 2.5);
    assert.equal($("velocity-multiplier").valueAsNumber, 0.8);
    assert.deepEqual([...$("ammunition").options].map((item) => item.value), ["Round8"]);
    assert.equal(submit.disabled, false);
  });

  await t.test("verified sticky charge updates only the shot multiplier", () => {
    change("weapon", "Sticky");
    assert.equal($("shot-charge-group").hidden, false);
    assert.equal($("velocity-multiplier").valueAsNumber, 1);
    input("barrel-length", "0.4");
    input("shot-charge", "50");
    assert.equal($("velocity-multiplier").valueAsNumber, 2);
    assert.equal($("barrel-length").valueAsNumber, 0.4, "Changing charge must not clobber geometry overrides");
    input("shot-charge", "100");
    assert.equal($("velocity-multiplier").valueAsNumber, 3);
  });

  await t.test("unknown fields are blanked when switching weapons, with explicit reasons", () => {
    $("overrides-section").open = false;
    change("weapon", "Dynamic");
    assert.equal($("shot-charge-group").hidden, true);
    assert.equal($("shot-charge").disabled, true);
    assert.equal($("velocity-multiplier").value, "");
    assert.equal($("overrides-section").open, true, "Missing preset values must reveal Manual overrides before submission");
    assert.equal($("barrel-length").valueAsNumber, 0.2);
    assert.match($("weapon-note").textContent, /Variable pressure/);
    assert.equal($("setup-form").checkValidity(), false);
    input("velocity-multiplier", "0.9");
    assert.equal($("setup-form").checkValidity(), true);
    change("weapon", "Missing");
    for (const id of ["barrel-length", "chamber-multiplier", "velocity-multiplier"])
      assert.equal($(id).value, "");
    assert.match($("weapon-note").textContent, /No stock prefab/);
    change("weapon", "Unsupported");
    assert.equal(submit.disabled, true);
    assert.match($("ammo-note").textContent, /no supported projectile/);
  });
});

test("workspace puts favorites before simulation and manual overrides last without changing form data or results when collapsed", async (t) => {
  const { dom, close } = await mount(dataset, "workspace");
  t.after(close);
  const $ = (id) => dom.window.document.getElementById(id);
  await waitFor(() => !$("solution").hidden || !$("load-error").hidden);
  assert.equal($("load-error").hidden, true, $("load-error").textContent);
  const form = $("setup-form");
  assert.equal(form.closest("details"), null, "Setup categories have no enclosing collapsible section");
  const sections = [...form.querySelectorAll(".setup-scroll > .setup-section")];
  assert.deepEqual(sections.map((section) => section.id), [
    "favorites-section", "simulation-section", "weapon-section", "muzzle-section", "sight-section", "overrides-section",
  ]);
  assert.deepEqual(sections.map((section) => section.open), [true, true, true, false, true, false]);
  assert.equal($("simulation-timing").open, false);
  assert.equal($("scene").closest(".setup-section"), sections[1]);
  assert.equal($("barrel-length").closest(".setup-section"), sections.at(-1));
  assert.equal($("restore-weapon").closest(".setup-section"), sections.at(-1));
  assert.ok($("ammo-facts").closest("#weapon-section"));
  assert.ok($("build-tag").closest("header"));
  const submit = form.querySelector('button[type="submit"]');
  assert.ok(submit.closest(".setup-actions"));
  assert.equal(form.querySelector(".setup-scroll").contains(submit), false, "Calculate stays outside the scrolling controls");
  const before = [...new dom.window.FormData(form)];
  for (const section of form.querySelectorAll("details")) section.open = false;
  assert.deepEqual([...new dom.window.FormData(form)], before, "Collapsed fields still participate in calculation");
  assert.equal($("solution").hidden, false);
  assert.equal($("export-csv").disabled, false, "Opening and closing sections does not invalidate a solution");
});

test("native submit reveals every collapsed ancestor of invalid fields and accepts valid collapsed fields", async (t) => {
  const { dom, close } = await mount(dataset, "collapsed-validation");
  t.after(close);
  const $ = (id) => dom.window.document.getElementById(id);
  await waitFor(() => !$("solution").hidden || !$("load-error").hidden);
  const input = (id, value) => {
    $(id).value = value;
    $(id).dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  input("barrel-length", "");
  input("fixed-step", "0");
  const form = $("setup-form");
  const sections = [...form.querySelectorAll("details")];
  for (const section of sections) section.open = false;
  const submit = form.querySelector('button[type="submit"]');
  submit.click();
  for (const id of ["simulation-section", "simulation-timing", "overrides-section"]) {
    assert.equal($(id).open, true, `${id} must open before native validation tries to focus a field`);
  }
  assert.equal($("solution").hidden, true);
  assert.equal($("export-csv").disabled, true);
  input("barrel-length", "0.5");
  input("fixed-step", "10");
  for (const section of sections) section.open = false;
  submit.click();
  await waitFor(() => !$("solution").hidden);
  for (const section of sections) {
    assert.equal(section.open, false, `${section.id}: valid collapsed controls need not be reopened to calculate`);
  }
  assert.equal($("export-csv").disabled, false);
});

test("simulation scene selection refreshes visible limits without silently changing the requested shot", async (t) => {
  const scenes = [...dataset.scenes, { file: "small-range", name: "SmallRange", maxRange: 50, catchHeight: -7 }];
  const { dom, close } = await mount({ ...dataset, scenes }, "simulation-limits");
  t.after(close);
  const $ = (id) => dom.window.document.getElementById(id);
  await waitFor(() => !$("solution").hidden || !$("load-error").hidden);
  assert.match($("simulation-note").textContent, /-50\.0 m world height/);
  $("scene").value = "small-range";
  $("scene").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal($("scene-limit").valueAsNumber, 50);
  assert.match($("simulation-note").textContent, /-7\.0 m world height/);
  assert.match($("simulation-note").textContent, /target range does not override/);
  assert.equal($("target-range").valueAsNumber, 300);
  assert.equal($("zero-range").valueAsNumber, 100);
  assert.equal($("solution").hidden, true);
  assert.equal($("export-csv").disabled, true);
});

test("top adjustment callouts invert aim corrections in both units while the range card remains unchanged", async (t) => {
  const { dom, close } = await mount(dataset, "scope-adjustments");
  t.after(close);
  const $ = (id) => dom.window.document.getElementById(id);
  await waitFor(() => !$('solution').hidden || !$('load-error').hidden);
  assert.equal($("load-error").hidden, true, $("load-error").textContent);
  assert.equal($("hold-label").textContent.trim(), "ELEVATION ADJUSTMENT");
  assert.equal($("windage-label").textContent, "WINDAGE ADJUSTMENT");
  const set = (id, value, type = "input") => {
    $(id).value = value;
    $(id).dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  };
  const elevations = [], windages = [];
  for (const [zeroRange, cant] of [[100, 0], [1, 0], [100, 15], [100, -15]]) {
    set("zero-range", String(zeroRange));
    set("cant-mode", cant ? "specific" : "none", "change");
    set("cant-angle", String(cant));
    $("setup-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => !$("setup-form").querySelector('button[type="submit"]').disabled);
    assert.equal($("solution").hidden, false, $("calculation-error").textContent);
    const row = $("range-rows").querySelector(".target-row");
    for (const [valueId, secondaryId, mradColumn, moaColumn] of [
      ["hold-value", "hold-secondary", 3, 4], ["windage-value", "windage-secondary", 5, 6],
    ]) {
      assert.equal(Number($(valueId).textContent), -Number(row.children[mradColumn].textContent) || 0);
      assert.equal(Number($(secondaryId).textContent.split(" ")[0]), -Number(row.children[moaColumn].textContent) || 0);
      assert.doesNotMatch($(valueId).textContent, /^-0\.000$/);
    }
    elevations.push(Number($("hold-value").textContent));
    windages.push(Number($("windage-value").textContent));
    assert.ok(Math.abs(Number($("trajectory-chart").querySelector(".range-point").dataset.heightCm)) < 0.1,
      "Changing scope display signs must not change the actual corrected solve");
  }
  assert.ok(elevations[0] < 0 && elevations[1] > 0, "Both elevation adjustment directions are covered");
  assert.ok(windages[2] > 0 && windages[3] < 0, "Both windage adjustment directions are covered");
});

test("firing angle controls trajectory, result labels and CSV, and validates its limits", async (t) => {
  const { dom, close } = await mount(dataset, "firing-angle");
  t.after(close);
  const $ = (id) => dom.window.document.getElementById(id);
  const submit = $("setup-form").querySelector('button[type="submit"]');
  const inputAngle = (value) => {
    $("firing-angle").value = value;
    $("firing-angle").dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const recalculate = async () => {
    $("setup-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => !submit.disabled);
  };
  await waitFor(() => !$("solution").hidden || !$("load-error").hidden);
  assert.equal($("load-error").hidden, true, $("load-error").textContent);
  assert.equal($("firing-angle").valueAsNumber, 0);
  const levelHold = Number($("hold-value").textContent);
  for (const angle of [45, -45, 12.5]) {
    inputAngle(String(angle));
    assert.equal($("setup-form").checkValidity(), true);
    assert.equal($("solution").hidden, true);
    assert.equal($("export-csv").disabled, true);
    await recalculate();
    assert.equal($("solution").hidden, false, $("calculation-error").textContent);
    assert.notEqual(Number($("hold-value").textContent), levelHold);
    assert.ok($("target-label").textContent.includes(`${angle.toFixed(1)}°`));
    assert.match($("target-label").textContent, /along sight line/);
    assert.ok($("chart-description").textContent.includes(`${angle.toFixed(1)}° sight line`));
    assert.match($("zero-label").textContent, /relative to sight/);
  }

  // Capture the real export blob without triggering JSDOM navigation.
  const originalCreateURL = URL.createObjectURL;
  let exported;
  URL.createObjectURL = (blob) => {
    exported = blob;
    return originalCreateURL(blob);
  };
  t.after(() => { URL.createObjectURL = originalCreateURL; });
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  $("export-csv").click();
  assert.ok(exported);
  assert.ok((await exported.text()).includes('"Sight-line inclination degrees","12.5"'));

  $("weapon").value = "Rifle";
  $("weapon").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  $("restore-weapon").click();
  assert.equal($("firing-angle").valueAsNumber, 12.5, "Changing or restoring a weapon must preserve the firing angle");
  for (const value of ["91", "-91", ""]) {
    inputAngle(value);
    assert.equal($("setup-form").checkValidity(), false);
    await recalculate();
    assert.equal($("solution").hidden, true);
    assert.equal($("export-csv").disabled, true);
  }
  for (const value of ["-90", "90"]) {
    inputAngle(value);
    assert.equal($("setup-form").checkValidity(), true);
  }
});

let localData;
try {
  localData = JSON.parse(await readFile(new URL("../public/data/h3vr.json", import.meta.url), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

test("the UI loads the extracted game catalog and calculates with an actual AKM preset", { skip: !localData && "Run npm run extract for install integration checks" }, async (t) => {
  const { dom, close } = await mount(localData, "game-install");
  t.after(close);
  const $ = (id) => dom.window.document.getElementById(id);
  await waitFor(() => !$("solution").hidden || !$("load-error").hidden);
  assert.equal($("load-error").hidden, true, $("load-error").textContent);
  assert.equal($("weapon").options.length, localData.weapons.length + 1);
  $("weapon").value = "AKM";
  $("weapon").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal($("barrel-length").valueAsNumber, 0.412201486494956);
  assert.equal($("chamber-multiplier").valueAsNumber, 1);
  const supported = new Map(localData.rounds.map((round) => [round.id, round]));
  for (const round of $("ammunition").options) assert.equal(supported.get(round.value).caliberId, 15);
  $("firing-angle").value = "30";
  $("firing-angle").dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const submit = $("setup-form").querySelector('button[type="submit"]');
  $("setup-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => !submit.disabled);
  assert.equal($("solution").hidden, false, $("calculation-error").textContent);
  assert.ok(Number($("muzzle-speed").textContent) > 500);
  assert.match($("target-label").textContent, /30\.0°/);
  assert.equal($("export-csv").disabled, false);
});

test("old caliber-only datasets request regeneration rather than silently using manual defaults", async (t) => {
  const { dom, close } = await mount({ ...dataset, schemaVersion: 1 }, "schema");
  t.after(close);
  const error = dom.window.document.getElementById("load-error");
  await waitFor(() => !error.hidden);
  assert.match(error.textContent, /npm run extract/);
  assert.equal(dom.window.document.getElementById("workspace").hidden, true);
});
