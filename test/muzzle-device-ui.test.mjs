import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MODEL } from "../public/physics.js";
import { muzzleGeometry } from "../public/muzzle-devices.js";
import { mount, waitFor } from "./helpers/app.mjs";

const curve = (value) => ({ keys: [{ time: 0, value, inSlope: 0, outSlope: 0 }] });
const pose = (position = [0, 0, 0]) => ({ position, scale: [1, 1, 1], forward: [0, 0, 1], up: [0, 1, 0] });
const mountProfile = (position) => ({ front: position, rear: [...position], pose: pose(position), parentPose: pose(), parentToThis: false, scaleModifier: 1 });
const source = { bundle: "fixture", assetName: "test", pathId: "1" };
const suppressor = { id: "SuppressorMk12", hashId: "SuppressorMk12", name: "Suppressor Mk12", kind: "suppressor", componentClass: "Suppressor", accuracyClass: 100,
  rootPose: pose(), muzzleOffset: [0, 0, 0.18], muzzleForward: [0, 0, 1], muzzleUp: [0, 1, 0],
  canScaleToMount: true, bidirectional: false, muzzleMounts: [], source };
const rifle = { id: "Rifle", hashId: "M4Carbine", name: "Test Rifle", caliberId: 13, accuracyClass: 33,
  chambers: [{ name: "Chamber", caliberId: 13, barrelLength: 0.412201486494956, multiplier: 1.15, position: [0, 0, 0] }],
  muzzlePose: pose([0, 0, 0.412201486494956]), muzzleMounts: [mountProfile([0, 0.01, 0.4])], shotRule: { kind: "constant", value: 1 }, source };
const dataset = {
  schemaVersion: 2, model: MODEL, source: { unityVersion: "5.6", assemblySha256: "test", inputs: [] },
  settings: { fixedDeltaTime: 0.01, dragCurve: curve(0), gravityModes: [{ name: "Realistic", value: 9.81 }],
    accuracyClasses: [{ id: 33, name: "AutoRifleModern", dropMult: 0.9, driftMult: 2 },
      { id: 100, name: "SuppressorPrecision", dropMult: 1.1, driftMult: 2 },
      { id: 122, name: "BarrelExtensionLong", dropMult: 1.3, driftMult: 1.2 },
      { id: 0, name: "None", dropMult: 0, driftMult: 0 }] },
  calibers: [{ id: 13, name: "Test Caliber", barrelCurve: curve(1), opticDropCurve: curve(0) }],
  weapons: [rifle],
  muzzleDevices: [suppressor,
    { ...suppressor, id: "BarrelExtenderThinLong", hashId: "BarrelExtenderThinLong", name: "Long Extender", kind: "device", componentClass: "MuzzleDevice", accuracyClass: 122,
      muzzleOffset: [0, 0, 0.2], muzzleMounts: [{ ...mountProfile([0, 0, 0.2]), followsRootParent: true }] },
    { ...suppressor, id: "SuppressorP7M8", hashId: "SuppressorP7M8", name: "Reversible Suppressor", accuracyClass: 0, bidirectional: true }],
  scenes: [{ file: "level0", name: "IndoorRange", maxRange: 1000, catchHeight: -50 }],
  rounds: [{ id: "556x45mmCartridgeFMJ", name: "Test Round", caliberId: 13, roundClass: "FMJ", numProjectiles: 1,
    mass: 0.01, diameter: 0.01, muzzleVelocity: 800, flightVelocityMultiplier: 1,
    airDragMultiplier: 1, gravityMultiplier: 1, maxRange: 5000, maxRangeRandom: 0, deletesOnStraightDown: true, source }],
  excluded: [],
};

async function controls(data, name, t) {
  const { dom, close } = await mount(data, name);
  t.after(close);
  const $ = (id) => dom.window.document.getElementById(id);
  await waitFor(() => !$("solution").hidden || !$("load-error").hidden);
  assert.equal($("load-error").hidden, true, $("load-error").textContent);
  const set = (id, value, type = "input") => {
    $(id).value = value;
    $(id).dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  };
  const recalculate = async () => {
    const submit = $("setup-form").querySelector('button[type="submit"]');
    $("setup-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => !submit.disabled);
  };
  const originalCreateURL = URL.createObjectURL;
  let exported;
  URL.createObjectURL = (blob) => { exported = blob; return originalCreateURL(blob); };
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  t.after(() => { URL.createObjectURL = originalCreateURL; });
  const csv = async () => {
    exported = null;
    $("export-csv").click();
    assert.ok(exported, "Expected an enabled, current export");
    return exported.text();
  };
  return { $, dom, set, recalculate, csv };
}

test("muzzle picker applies an ordered loadout, adjusts geometry and renders right-POI/left-correction signs and CSV", async (t) => {
  const { $, set, recalculate, csv } = await controls(dataset, "muzzle-loadout", t);
  assert.equal($("add-muzzle-device").disabled, true, "A source firearm identity is required");
  set("weapon", "Rifle", "change");
  await recalculate();
  assert.equal(Number($("windage-value").textContent), 0);
  assert.equal($("muzzle-device").options.length, 3);
  set("muzzle-search", "PRECISION");
  assert.equal($("muzzle-device").options.length, 1);
  assert.equal($("solution").hidden, false, "Catalog previews do not change the setup");
  assert.match($("muzzle-device-facts").textContent, /0\.977 MOA right/);
  $("add-muzzle-device").click();
  assert.equal($("muzzle-loadout").children.length, 1);
  assert.equal($("solution").hidden, true);
  assert.equal($("export-csv").disabled, true);
  const geometry = muzzleGeometry(rifle, rifle.chambers[0], [suppressor]);
  assert.equal($("barrel-length").valueAsNumber, geometry.barrelLength);
  assert.equal($("sight-height").valueAsNumber, 5, "Bare sight geometry must not be destructively rewritten");
  assert.equal($("sight-setback").valueAsNumber, 0);
  assert.equal($("manual-muzzle-geometry").hidden, true);
  assert.equal($("confirm-muzzle-geometry").required, false);
  set("target-range", "500");
  await recalculate();
  assert.equal($("solution").hidden, false, $("calculation-error").textContent);
  assert.ok(Number($("windage-value").textContent) < 0);
  assert.match($("windage-secondary").textContent, /aim left/);
  assert.match($("lateral-label").textContent, /right of POA/);
  const row = $("range-rows").querySelector(".target-row");
  assert.equal(row.children.length, 9);
  assert.ok(Number(row.children[2].textContent) > 0, "Lateral POI is right");
  assert.ok(Number(row.children[5].textContent) < 0, "Windage correction is left");
  const exported = await csv();
  assert.ok(exported.includes('"Muzzle devices in registration order","SuppressorMk12"'));
  assert.ok(exported.includes('"Muzzle geometry","Stock inner-to-outer mounts"'));
  assert.ok(exported.includes('"Sight height m","0.04"'), "Effective height incorporates the source muzzle up shift");
  assert.ok(exported.includes(`"Sight setback m","${geometry.forwardShift}"`));
  assert.match(exported, /lateral_cm.*windage_mrad.*windage_MOA/);

  set("muzzle-search", "");
  set("muzzle-kind", "device", "change");
  assert.equal($("muzzle-device").options.length, 1);
  $("add-muzzle-device").click();
  assert.equal($("muzzle-loadout").children.length, 2);
  assert.equal($("barrel-length").value, "", "An impossible auto mount chain must not retain the old barrel distance");
  assert.match($("muzzle-note").textContent, /no verified forward submount/);
  assert.equal($("solution").hidden, true);
  $("muzzle-loadout").querySelector('[data-index="1"][data-action="earlier"]').click();
  assert.match($("muzzle-loadout").children[0].textContent, /Long Extender/);
  assert.ok($("barrel-length").valueAsNumber > geometry.barrelLength);
  await recalculate();
  assert.equal($("solution").hidden, false, $("calculation-error").textContent);
  assert.ok((await csv()).includes('"Muzzle devices in registration order","BarrelExtenderThinLong; SuppressorMk12"'));
  $("muzzle-loadout").querySelector('[data-index="1"][data-action="remove"]').click();
  assert.equal($("muzzle-loadout").children.length, 1);
  assert.equal($("solution").hidden, true);
  assert.equal($("export-csv").disabled, true);
  $("clear-muzzle-devices").click();
  assert.equal($("muzzle-loadout").children.length, 0);
  assert.equal($("barrel-length").valueAsNumber, rifle.chambers[0].barrelLength);
  assert.equal($("muzzle-geometry-group").hidden, true);
  await recalculate();
  assert.equal(Number($("windage-value").textContent), 0);
  assert.match($("windage-secondary").textContent, /no lateral correction/);
  assert.ok((await csv()).includes('"Muzzle devices in registration order",""'));
});

test("unverified/reversible mounting requires explicitly confirmed measured geometry, preserved by multiplier restoration", async (t) => {
  const { $, dom, set, recalculate, csv } = await controls(dataset, "muzzle-manual", t);
  set("weapon", "Rifle", "change");
  set("muzzle-device", "SuppressorP7M8", "change");
  $("add-muzzle-device").click();
  assert.equal($("barrel-length").value, "");
  assert.equal($("overrides-section").open, true, "Unknown muzzle distance must reveal the required manual override");
  assert.equal($("muzzle-section").open, true, "Unverified mounting must reveal the measured-geometry controls");
  assert.match($("muzzle-note").textContent, /reversible mounting/);
  set("barrel-length", "0.9");
  await recalculate();
  assert.equal($("solution").hidden, true, "Entering a barrel override cannot bypass unverified automatic mounting");
  assert.match($("calculation-error").textContent, /Select measured geometry/);
  set("muzzle-geometry-mode", "manual", "change");
  assert.equal($("manual-muzzle-geometry").hidden, false);
  for (const id of ["barrel-length", "muzzle-forward-shift", "muzzle-up-shift"]) assert.equal($(id).value, "");
  assert.equal($("setup-form").checkValidity(), false);
  set("barrel-length", "0.9");
  set("muzzle-forward-shift", "10");
  set("muzzle-up-shift", "0.2");
  assert.equal($("setup-form").checkValidity(), false, "Measurements require an explicit confirmation");
  $("confirm-muzzle-geometry").checked = true;
  $("confirm-muzzle-geometry").dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal($("setup-form").checkValidity(), true);
  await recalculate();
  assert.equal($("solution").hidden, false, $("calculation-error").textContent);
  assert.equal(Number($("windage-value").textContent), 0, "The source None-class suppressor has no fixed horizontal bias");
  const exported = await csv();
  assert.ok(exported.includes('"Muzzle geometry","Measured centered/bore-aligned muzzle"'));
  assert.ok(exported.includes('"Mounted muzzle forward shift m","0.1"'));
  assert.ok(exported.includes('"Sight height m","0.048"'));
  set("velocity-multiplier", "2");
  $("restore-weapon").click();
  assert.equal($("velocity-multiplier").valueAsNumber, 1);
  assert.equal($("barrel-length").valueAsNumber, 0.9);
  assert.equal($("muzzle-forward-shift").valueAsNumber, 10);
  assert.equal($("confirm-muzzle-geometry").checked, true);
  assert.equal($("solution").hidden, true);
  assert.equal($("export-csv").disabled, true);
  assert.match($("restore-weapon").textContent, /multipliers/);
  set("muzzle-forward-shift", "11");
  assert.equal($("confirm-muzzle-geometry").checked, false, "Changing a measured pose requires fresh confirmation");
  $("confirm-muzzle-geometry").checked = true;
  set("muzzle-device", "SuppressorMk12", "change");
  $("add-muzzle-device").click();
  assert.equal($("confirm-muzzle-geometry").checked, false, "Loadout changes invalidate measured-pose confirmation");
  $("clear-muzzle-devices").click();
  assert.equal($("manual-muzzle-geometry").hidden, true);
  assert.equal($("confirm-muzzle-geometry").disabled, true);
  assert.equal($("setup-form").checkValidity(), true);
});

let localData;
try {
  localData = JSON.parse(await readFile(new URL("../public/data/h3vr.json", import.meta.url), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

test("the UI offers all 84 actual devices and calculates an extracted M4/Mk12 loadout", { skip: !localData && "Run npm run extract for install integration checks" }, async (t) => {
  const { $, set, recalculate, csv } = await controls(localData, "muzzle-game-install", t);
  assert.equal($("muzzle-device").options.length, 84);
  set("weapon", "M4Carbine", "change");
  set("muzzle-search", "SuppressorMk12");
  assert.equal($("muzzle-device").options.length, 1);
  $("add-muzzle-device").click();
  assert.equal($("barrel-length").valueAsNumber, 0.5015700061258377);
  await recalculate();
  assert.equal($("solution").hidden, false, $("calculation-error").textContent);
  assert.ok(Number($("windage-value").textContent) < 0);
  assert.match($("lateral-label").textContent, /right of POA/);
  const exported = await csv();
  assert.ok(exported.includes('"Weapon hash ID","M4Carbine"'));
  assert.ok(exported.includes('"Horizontal device drift MOA","0.9768000245094299"'));
  assert.ok(exported.includes('"Effective chamber-to-muzzle distance m","0.5015700061258377"'));
  set("weapon", "MRAD", "change");
  assert.equal($("muzzle-loadout").children.length, 1, "The same device is re-evaluated for the new firearm");
  assert.equal($("export-csv").disabled, true);
  await recalculate();
  assert.equal($("solution").hidden, false, $("calculation-error").textContent);
  const changed = await csv();
  assert.ok(changed.includes('"Weapon hash ID","MRAD"'));
  assert.ok(changed.includes('"Horizontal device drift MOA","1.9411200284957886"'));
  $("clear-muzzle-devices").click();
  set("ammunition", "338LapuaCartridgeAP", "change");
  set("zero-range", "1000");
  set("target-range", "1215");
  set("range-step", "300");
  set("scene-limit", "5000");
  set("world-height", "1000");
  set("sight-height", "7.5");
  set("sight-setback", "60");
  await recalculate();
  assert.equal($("solution").hidden, false, $("calculation-error").textContent);
  assert.equal(Number($("windage-value").textContent), 0, "Bare MRAD/AP must not acquire a device bias from the catalog preview");
  assert.match($("lateral-label").textContent, /centered/);
  set("muzzle-kind", "brake", "change");
  set("muzzle-search", "");
  assert.equal($("muzzle-device").options.length, 10);
  set("muzzle-kind", "device", "change");
  assert.equal($("muzzle-device").options.length, 16);
});
