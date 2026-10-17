import test from "node:test";
import assert from "node:assert/strict";
import { mount, waitFor } from "./helpers/app.mjs";
import { MODEL } from "../public/physics.js";
import { modById, modNote, modSearchText, modSuffix, modSummary } from "../public/mods.js";

const curve = (value) => ({ keys: [{ time: 0, value, inSlope: 0, outSlope: 0 }, { time: 100, value, inSlope: 0, outSlope: 0 }] });
const source = { bundle: "weapons", assetName: "testweapon", pathId: "42" };
const mods = [
  { id: "Acme-Super_Rifles", name: "Super Rifles", version: "1.2.0", author: "Acme", files: [],
    gameHooks: { methods: ["BallisticProjectile.UpdateVelocity", "FVRViveHand.Update"], unresolvedPatches: false, ballistics: ["BallisticProjectile.UpdateVelocity"] } },
  { id: "Tools", name: "Tools", version: null, files: [], gameHooks: { methods: [], unresolvedPatches: true, ballistics: [] } },
];
const round = (id, name, extra = {}) => ({
  id, name, caliberId: 13, roundClass: "FMJ", numProjectiles: 1, mass: 0.01, diameter: 0.01, muzzleVelocity: 800,
  flightVelocityMultiplier: 1, airDragMultiplier: 1, gravityMultiplier: 1, maxRange: 5000, maxRangeRandom: 0,
  deletesOnStraightDown: true, source, ...extra,
});
const chamber = { name: "Chamber", caliberId: 13, barrelLength: 0.4, multiplier: 1 };
const dataset = {
  schemaVersion: 2, model: MODEL,
  source: { unityVersion: "5.6", assemblySha256: "test", inputs: [] },
  settings: { fixedDeltaTime: 0.01, dragCurve: curve(0), gravityModes: [{ name: "Realistic", value: 9.81 }] },
  calibers: [{ id: 13, name: "Caliber 13", barrelCurve: curve(1), opticDropCurve: curve(0) }],
  weapons: [
    { id: "Rifle", name: "Test Rifle", caliberId: 13, chambers: [chamber], shotRule: { kind: "constant", value: 1 }, source },
    { id: "SuperRifle", name: "Super Rifle", caliberId: 13, chambers: [chamber], shotRule: { kind: "constant", value: 1 },
      source: { bundle: "Acme-Super_Rifles/late_superrifles", assetName: "superrifle" }, mod: "Acme-Super_Rifles",
      modScripts: ["Super_Rifles:Acme.Charger"] },
  ],
  scenes: [{ file: "level0", name: "IndoorRange", maxRange: 1000, catchHeight: -50 }],
  rounds: [round("556x45mmCartridgeFMJ", "Stock Round"), round("SuperRound", "Super Round", { mod: "Acme-Super_Rifles" })],
  excluded: [{ id: "Plasma", name: "Plasma Round", reason: "No BallisticProjectile; different projectile integrator", mod: "Acme-Super_Rifles" }],
  mods,
  modIssues: [
    { mod: "Acme-Super_Rifles", id: "Clash", name: "Clash Gun", reason: "ItemID is defined differently by A, B; left out." },
    { mod: "Tools", id: null, name: null, reason: "2 FVRObjects reuse base-game ItemIDs." },
  ],
};

test("mod helpers label, describe and summarise modded entries", () => {
  const byId = modById(mods);
  const item = { mod: "Acme-Super_Rifles", modScripts: ["Super_Rifles:Acme.Charger"] };
  assert.equal(modSuffix(item, byId), " · Mod: Super Rifles");
  assert.equal(modSuffix({}, byId), "");
  assert.match(modSearchText(item, byId), /^mod Acme-Super_Rifles Super Rifles$/);
  assert.equal(modSearchText({ id: "stock" }, byId), "");
  assert.match(modNote(item, byId), /^From mod Super Rifles 1\.2\.0\. Its prefab uses mod scripts \(Super_Rifles:Acme\.Charger\)/);
  assert.equal(modNote({ mod: "Unknown" }, byId), "From mod Unknown.");
  assert.equal(modSummary({}), "");
  const summary = modSummary({ mods });
  assert.match(summary, /^2 installed mod packages read\./);
  assert.match(summary, /Super Rifles 1\.2\.0 \(BallisticProjectile\.UpdateVelocity\)/);
  assert.match(summary, /not determinable offline: Tools\./);
});

test("modded entries are labelled, searchable and explained in the app", async (t) => {
  const { dom, close } = await mount(dataset, "mods");
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
  await waitFor(() => !$("solution").hidden || !$("load-error").hidden);
  assert.equal($("load-error").hidden, true, $("load-error").textContent);

  const labels = [...$("weapon").options].map((item) => item.textContent);
  assert.ok(labels.includes("Super Rifle · Mod: Super Rifles · Caliber 13"), labels.join(" | "));
  assert.ok(labels.includes("Test Rifle · Caliber 13"));
  input("weapon-search", "mod");
  assert.deepEqual([...$("weapon").options].map((item) => item.value), ["", "SuperRifle"]);
  input("weapon-search", "super rifles");
  assert.deepEqual([...$("weapon").options].map((item) => item.value), ["", "SuperRifle"]);

  change("weapon", "SuperRifle");
  assert.match($("weapon-note").textContent, /From mod Super Rifles 1\.2\.0\. Its prefab uses mod scripts \(Super_Rifles:Acme\.Charger\)/);
  assert.match($("weapon-note").textContent, /Source: Acme-Super_Rifles\/late_superrifles\/superrifle\./);
  const rounds = [...$("ammunition").options].map((item) => item.textContent);
  assert.ok(rounds.includes("Super Round · Mod: Super Rifles"), rounds.join(" | "));
  change("ammunition", "SuperRound");
  assert.match($("ammo-note").textContent, /From mod Super Rifles 1\.2\.0\./);

  assert.match($("provenance").textContent, /2 installed mod packages read\. Patching ballistic game code \(not modeled\): Super Rifles 1\.2\.0 \(BallisticProjectile\.UpdateVelocity\)/);
  assert.equal($("mod-issues-section").hidden, false);
  assert.equal($("mod-issues-summary").textContent, "2 mod items left out or limited — reasons");
  assert.deepEqual([...$("mod-issues").children].map((item) => item.textContent), [
    "Super Rifles · Clash Gun (Clash): ItemID is defined differently by A, B; left out.",
    "Tools: 2 FVRObjects reuse base-game ItemIDs.",
  ]);
  assert.equal($("excluded-summary").textContent, "1 unavailable projectile variant — reasons");
  assert.equal($("excluded-rounds").children[0].textContent,
    "Plasma Round · Mod: Super Rifles: No BallisticProjectile; different projectile integrator");
});

test("datasets extracted without mods keep the mod section hidden", async (t) => {
  const { mods: _, modIssues: __, ...stock } = dataset;
  const { dom, close } = await mount({ ...stock, weapons: stock.weapons.slice(0, 1), rounds: stock.rounds.slice(0, 1), excluded: [] }, "stock");
  t.after(close);
  const $ = (id) => dom.window.document.getElementById(id);
  await waitFor(() => !$("solution").hidden || !$("load-error").hidden);
  assert.equal($("load-error").hidden, true, $("load-error").textContent);
  assert.equal($("mod-issues-section").hidden, true);
  assert.doesNotMatch($("provenance").textContent, /mod/i);
});
