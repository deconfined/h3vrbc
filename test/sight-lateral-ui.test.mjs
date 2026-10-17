import test from "node:test";
import assert from "node:assert/strict";
import { CookieJar } from "jsdom";
import { mount, waitFor } from "./helpers/app.mjs";
import { dataset, optic, pose, weapon } from "./helpers/optics.mjs";

const closeNumber = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, message ?? `${actual} != ${expected}`);

// Offset risers: the same scope, its optical origin moved sideways off the bore.
const rightOptic = { ...optic, id: "Right:46", attachmentId: "RightRiser", name: "Right riser scope", opticalPose: pose([0.02, 0.03, -0.1]) };
const leftOptic = { ...optic, id: "Left:47", attachmentId: "LeftRiser", name: "Left riser scope", opticalPose: pose([-0.025, 0.03, -0.1]) };
const muzzleMount = { front: [0, 0, 0.4], rear: [0, 0, 0.4], pose: pose([0, 0, 0.4]), parentPose: pose(), parentToThis: false, scaleModifier: 1 };
const suppressor = { id: "Suppressor", hashId: "SuppressorMk12", name: "Test Suppressor", kind: "suppressor", componentClass: "Suppressor", accuracyClass: 100,
  rootPose: pose(), muzzleOffset: [0, 0, 0.18], muzzleForward: [0, 0, 1], muzzleUp: [0, 1, 0],
  canScaleToMount: true, bidirectional: false, muzzleMounts: [], source: optic.source };
const data = {
  ...dataset,
  settings: { ...dataset.settings, accuracyClasses: [{ id: 33, name: "AutoRifleModern", dropMult: 0.9, driftMult: 2 },
    { id: 100, name: "SuppressorPrecision", dropMult: 1.1, driftMult: 2 }] },
  weapons: [...dataset.weapons, { ...weapon, id: "Threaded", name: "Threaded rifle", hashId: "M4Carbine", accuracyClass: 33, muzzleMounts: [muzzleMount] }],
  optics: [...dataset.optics, rightOptic, leftOptic],
  muzzleDevices: [suppressor],
};

async function controls(name, t, cookieJar) {
  const { dom, close } = await mount(data, name, { cookieJar });
  let closed = false;
  const stop = () => { if (!closed) { closed = true; close(); } };
  t.after(stop);
  const $ = (id) => dom.window.document.getElementById(id);
  await waitFor(() => !$("workspace").hidden || !$("load-error").hidden);
  await new Promise((resolve) => dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(resolve)));
  assert.equal($("load-error").hidden, true, $("load-error").textContent);
  const set = (id, value, type = "input") => {
    $(id).value = value;
    $(id).dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  };
  const recalculate = async () => {
    $("setup-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => !$("setup-form").querySelector('button[type="submit"]').disabled);
    assert.equal($("solution").hidden, false, $("calculation-error").textContent);
  };
  const original = URL.createObjectURL;
  let blob;
  URL.createObjectURL = (value) => { blob = value; return original(value); };
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  t.after(() => { URL.createObjectURL = original; });
  // One metadata row of the exported CSV, as a number where it is one.
  const csv = async () => {
    $("export-csv").click();
    const text = await blob.text();
    return (key) => {
      const row = text.split("\r\n").find((line) => line.startsWith(`"${key}",`));
      assert.ok(row, `CSV row ${key}`);
      const value = row.slice(key.length + 4, -1);
      return value === "" || Number.isNaN(Number(value)) ? value : Number(value);
    };
  };
  return { $, dom, set, recalculate, csv, close: stop };
}

test("the lateral offset input reaches the solve and CSV in metres, and muzzle devices never shift it", async (t) => {
  const { $, set, recalculate, csv } = await controls("sight-lateral-input", t);
  assert.equal($("sight-lateral").value, "0", "A centered optic is the default");
  assert.equal($("sight-lateral").name, "sightLateral");
  assert.equal($("sight-lateral").required, true);
  set("weapon", "Rifle", "change");
  // No base zero adjustment keeps the bore parallel to the sight, so a sideways
  // optic leaves the shot exactly that far to the other side.
  set("zero-model", "unadjusted", "change");
  set("sight-setback", "40");
  set("sight-lateral", "5");
  await recalculate();
  assert.equal($("lateral-label").textContent, "Base POI: 5.00 cm left of POA");
  assert.ok(Number($("windage-value").textContent) < 0, "The base shot lands left, so the offset reads negative");
  let row = await csv();
  assert.equal(row("Sight lateral offset m (+ right of bore)"), 0.05);
  assert.equal(row("Sight geometry"), "Manual sight geometry");
  set("sight-lateral", "-5");
  assert.equal($("solution").hidden, true, "Editing the offset invalidates the solution");
  await recalculate();
  assert.equal($("lateral-label").textContent, "Base POI: 5.00 cm right of POA");

  set("weapon", "Threaded", "change");
  set("muzzle-device", "Suppressor", "change");
  $("add-muzzle-device").click();
  assert.equal($("sight-lateral").value, "-5", "Adding a device keeps the bare-muzzle inputs");
  await recalculate();
  row = await csv();
  closeNumber(row("Sight setback m"), 0.58, "The device's forward shift still moves the setback");
  closeNumber(row("Sight height m"), 0.05);
  assert.equal(row("Sight lateral offset m (+ right of bore)"), -0.05, "Devices mount on the bore axis");
  // The device adds its own launch yaw; the optic's offset still moves the base
  // shot by exactly its own width.
  const poi = () => {
    const [, value, side] = /^Base POI: (\d+\.\d\d) cm (right|left) of POA$/.exec($("lateral-label").textContent);
    return side === "right" ? Number(value) : -Number(value);
  };
  const offset = poi();
  set("sight-lateral", "0");
  await recalculate();
  assert.ok(Math.abs(offset - poi() - 5) < 0.015, `${offset} - ${poi()} should be the 5 cm offset`);
});

test("optic defaults fill, compare, restore and clear a sideways optical origin", async (t) => {
  const { $, set, recalculate, csv } = await controls("sight-lateral-optic", t);
  set("weapon", "Rifle", "change");
  set("optic", rightOptic.id, "change");
  closeNumber($("sight-height").valueAsNumber, 5);
  closeNumber($("sight-setback").valueAsNumber, 40);
  closeNumber($("sight-lateral").valueAsNumber, 2);
  assert.match($("optic-note").textContent, /Stock direct-mount defaults: height 5\.000 cm; setback 40\.000 cm from the bare muzzle; 2\.000 cm right of the bore\./);
  assert.equal($("setup-form").checkValidity(), true);
  await recalculate();
  const row = await csv();
  assert.match(row("Sight geometry"), /^Forward-facing stock direct mount/);
  closeNumber(row("Sight lateral offset m (+ right of bore)"), 0.02);
  // The authored rule toes the bore in to cross the sight line at the 100 m zero,
  // so at 300 m the shot has crossed over to the optic's side.
  assert.match($("lateral-label").textContent, /^Base POI: \d+\.\d\d cm right of POA$/);

  set("optic-rail-position", "25");
  closeNumber($("sight-setback").valueAsNumber, 45);
  closeNumber($("sight-lateral").valueAsNumber, 2, "Sliding along the rail does not move the optic sideways");
  set("sight-lateral", "3");
  assert.match($("optic-note").textContent, /Manual sight geometry overrides/, "Editing only the lateral offset is a manual override");
  assert.equal($("solution").hidden, true);
  $("restore-optic").click();
  closeNumber($("sight-lateral").valueAsNumber, 2);
  closeNumber($("sight-setback").valueAsNumber, 45, "Restoration keeps the chosen rail position");
  assert.match($("optic-note").textContent, /2\.000 cm right of the bore/);

  set("optic", leftOptic.id, "change");
  closeNumber($("sight-lateral").valueAsNumber, -2.5);
  assert.match($("optic-note").textContent, /from the bare muzzle; 2\.500 cm left of the bore\./);
  set("optic", optic.id, "change");
  assert.equal($("sight-lateral").valueAsNumber, 0);
  assert.match($("optic-note").textContent, /setback 40\.000 cm from the bare muzzle\./);
  assert.doesNotMatch($("optic-note").textContent, /of the bore/, "A centered optic needs no lateral sentence");

  set("sight-lateral", "4");
  set("optic", "Dynamic:45", "change");
  for (const id of ["sight-height", "sight-setback", "sight-lateral"])
    assert.equal($(id).value, "", `${id} is cleared rather than left stale`);
  assert.match($("optic-note").textContent, /live extension\. Enter sight height, setback and lateral offset manually/);
  assert.equal($("setup-form").checkValidity(), false);
  set("weapon", "NoMount", "change");
  set("optic", rightOptic.id, "change");
  assert.equal($("sight-lateral").value, "", "No direct mount: no lateral default either");
});

test("the corrected line of sight reports its clearance from the bore and warns when it runs into the barrel", async (t) => {
  const { $, set, recalculate, csv } = await controls("sight-lateral-clearance", t);
  const note = $("sight-clearance");
  assert.equal($("solution").contains(note), true, "The readout hides with the solution it describes");
  assert.equal($("solution").hidden, false);
  assert.equal(note.hidden, true, "An optic at the muzzle (setback 0) has no barrel under its line of sight");
  const warning = () => note.classList.contains("sight-clearance-warning");
  // The text is the CSV's full-precision figures, rounded and given directions.
  const expected = async () => {
    const row = await csv();
    const up = row("Corrected sight line at active muzzle, up from bore axis cm");
    const right = row("Corrected sight line at active muzzle, right of bore axis cm");
    const distance = row("Corrected sight line closest approach to bore axis cm");
    const behind = Math.max(0, row("Corrected sight line closest approach, behind active muzzle cm")).toFixed(0);
    const side = Math.abs(right).toFixed(1) === "0.0" ? "beside" : right > 0 ? "right of" : "left of";
    return { up, right, distance, text: `Corrected line of sight at the muzzle: ${Math.abs(up).toFixed(1)} cm ${up < 0 ? "below" : "above"} and ${Math.abs(right).toFixed(1)} cm ${side} the bore axis; closest ${distance.toFixed(1)} cm from the axis, ${behind === "0" ? "at the muzzle" : `${behind} cm behind the muzzle`}.` };
  };

  set("weapon", "Rifle", "change");
  set("optic", optic.id, "change");
  await recalculate();
  let figures = await expected();
  assert.equal(note.hidden, false);
  assert.equal(warning(), false);
  assert.ok(figures.up > 4 && figures.up < 5, "A 5 cm sight stays well above the bore at a modest correction");
  assert.equal(note.textContent, `${figures.text} A barrel, suppressor or handguard with a larger radius there blocks the view.`);
  assert.match(note.textContent, /4\.\d cm above and 0\.0 cm beside the bore axis; closest 4\.\d cm from the axis, at the muzzle\./);

  // A slow round: the correction tilts the line of sight down onto the bore.
  // Still just above the axis at the muzzle, it already runs through the barrel.
  set("zero-model", "unadjusted", "change");
  set("velocity-multiplier", "0.15");
  set("target-range", "300");
  await recalculate();
  figures = await expected();
  assert.ok(figures.up > 0 && figures.up < 2.5, `${figures.up} cm above the axis`);
  assert.equal(warning(), true, "Above the axis but within 3 cm, after using up over half the sight height");

  // Further out it passes below the bore before reaching the muzzle.
  set("target-range", "500");
  await recalculate();
  figures = await expected();
  const pitch = Number(/^(-?\d+\.\d+)° corrected bore/.exec($("launch-detail").textContent)[1]) * Math.PI / 180;
  assert.ok(Math.abs(figures.up - (5 - 40 * Math.tan(pitch))) < 0.01, "Up at the muzzle follows from the corrected pitch over the 40 cm setback");
  assert.ok(figures.up < 0 && figures.distance < 3);
  assert.equal(warning(), true);
  assert.equal(note.textContent, `${figures.text} A barrel, suppressor or handguard with a larger radius there blocks the view: raise the optic or offset it sideways.`);
  assert.match(note.textContent, /\d\.\d cm below and 0\.0 cm beside the bore axis; closest 0\.0 cm from the axis, \d+ cm behind the muzzle\./);

  // Offset risers move the line clear sideways; 2 cm is still too close.
  set("sight-lateral", "-2");
  await recalculate();
  figures = await expected();
  assert.equal(warning(), true);
  assert.match(note.textContent, /cm below and 2\.0 cm left of the bore axis; closest 2\.0 cm from the axis/);
  set("sight-lateral", "5");
  await recalculate();
  figures = await expected();
  assert.equal(warning(), false, "5 cm to the side clears a barrel the line now passes under");
  assert.ok(figures.up < 0 && figures.distance >= 3);
  assert.equal(note.textContent, `${figures.text} A barrel, suppressor or handguard with a larger radius there blocks the view.`);
  assert.match(note.textContent, /cm below and 5\.0 cm right of the bore axis; closest 5\.0 cm from the axis/);

  // A low sight sits within 3 cm of the bore on every shot; a modest correction
  // that leaves most of that height is not a warning.
  set("sight-lateral", "0");
  set("velocity-multiplier", "1");
  set("sight-height", "2");
  set("target-range", "200");
  await recalculate();
  figures = await expected();
  assert.ok(figures.distance > 1 && figures.distance < 3, `${figures.distance} cm from the axis`);
  assert.equal(warning(), false, "A 2 cm sight at a modest correction is not flagged");

  set("target-range", "400");
  assert.equal($("solution").hidden, true, "No solution, no clearance readout");
  set("sight-setback", "-5");
  await recalculate();
  assert.equal(note.hidden, true, "An optic ahead of the muzzle has no barrel under its line of sight");
  assert.equal((await csv())("Corrected sight line at active muzzle, up from bore axis cm"), "");
});

test("the lateral offset survives refresh, and a snapshot from before it existed restores with a centered optic", async (t) => {
  const cookieJar = new CookieJar();
  const app = await controls("sight-lateral-save", t, cookieJar);
  app.$("favorites-consent").checked = true;
  app.$("favorites-consent").dispatchEvent(new app.dom.window.Event("change", { bubbles: true }));
  app.set("weapon", "Rifle", "change");
  app.set("optic", rightOptic.id, "change");
  app.set("sight-lateral", "-3.75");
  app.dom.window.dispatchEvent(new app.dom.window.Event("pagehide"));
  const cookie = () => cookieJar.getCookiesSync("http://localhost/").find((item) => item.key === "h3vrbc_interface");
  const saved = JSON.parse(decodeURIComponent(cookie().value));
  assert.equal(saved.state.values["sight-lateral"], "-3.75");
  app.close();

  const restored = await controls("sight-lateral-reload", t, cookieJar);
  assert.equal(restored.$("optic").value, rightOptic.id);
  assert.equal(restored.$("sight-lateral").value, "-3.75");
  assert.match(restored.$("optic-note").textContent, /Manual sight geometry overrides/);
  restored.set("sight-lateral", "2");
  assert.match(restored.$("optic-note").textContent, /Stock direct-mount defaults: .*2\.000 cm right of the bore/,
    "Typing the stock offset back is recognised as the optic default");
  restored.close();

  const legacy = structuredClone(saved);
  delete legacy.state.values["sight-lateral"];
  legacy.state.values.optic = "";
  legacy.state.values["sight-height"] = "6.5";
  cookieJar.setCookieSync(`h3vrbc_interface=${encodeURIComponent(JSON.stringify(legacy))}; Path=/`, "http://localhost/");
  const old = await controls("sight-lateral-legacy", t, cookieJar);
  assert.equal(old.$("interface-status").hidden, true, old.$("interface-status").textContent);
  assert.equal(old.$("weapon").value, "Rifle");
  assert.equal(old.$("sight-height").value, "6.5");
  assert.equal(old.$("sight-lateral").value, "0");
  await old.recalculate();
});
