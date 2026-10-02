import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { searchWeapons, weaponPreset } from "../public/weapons.js";
import { calculate, toCSV } from "../public/physics.js";

const calibers = new Map([
  [13, { name: "5.56×45 mm" }],
  [8, { name: ".45 ACP" }],
]);
const weapon = {
  id: "TestRifle",
  name: "Test Rifle",
  caliberId: 13,
  chambers: [{ name: "Chamber", caliberId: 13, barrelLength: 0.412201486494956, multiplier: 1.149999976158142 }],
  shotRule: { kind: "constant", value: 0.8 },
};

test("weapon search matches names, IDs and chamber calibers without mutating the catalog", () => {
  const mixed = { ...weapon, id: "Combo", name: "Combination gun", chambers: [...weapon.chambers, { caliberId: 8 }] };
  const list = [weapon, mixed];
  assert.deepEqual(searchWeapons(list, calibers, " TEST rifle "), [weapon]);
  assert.deepEqual(searchWeapons(list, calibers, "testrifle"), [weapon]);
  assert.deepEqual(searchWeapons(list, calibers, "ACP"), [mixed]);
  assert.deepEqual(searchWeapons(list, calibers, "no match"), []);
  assert.deepEqual(searchWeapons(list, calibers, ""), list);
  assert.equal(list.length, 2);
});

test("presets preserve exact extracted distances and both distinct launch multipliers", () => {
  const preset = weaponPreset(weapon);
  assert.equal(preset.barrelLength, weapon.chambers[0].barrelLength);
  assert.equal(preset.chamberMultiplier, weapon.chambers[0].multiplier);
  assert.equal(preset.velocityMultiplier, 0.8);
  assert.equal(preset.caliberId, 13);
  assert.deepEqual(preset.warnings, []);
});

test("each barrel supplies its own caliber, length and chamber multiplier", () => {
  const second = { name: "Second", caliberId: 8, barrelLength: 0.2, multiplier: 2.5 };
  const preset = weaponPreset({ ...weapon, chambers: [...weapon.chambers, second] }, 1);
  assert.equal(preset.caliberId, 8);
  assert.equal(preset.barrelLength, 0.2);
  assert.equal(preset.chamberMultiplier, 2.5);
  assert.equal(preset.velocityMultiplier, 0.8);
});

test("missing or unverified values are null, never silently replaced with defaults", () => {
  const missing = weaponPreset({ id: "Unknown", caliberId: 8, presetUnavailable: "No prefab." });
  assert.equal(missing.barrelLength, null);
  assert.equal(missing.chamberMultiplier, null);
  assert.equal(missing.velocityMultiplier, null);
  assert.ok(missing.warnings.includes("No prefab."));
  const dynamic = weaponPreset({ ...weapon, shotRule: { kind: "manual", reason: "Variable pressure." } });
  assert.equal(dynamic.barrelLength, weapon.chambers[0].barrelLength);
  assert.equal(dynamic.velocityMultiplier, null);
  assert.ok(dynamic.warnings.includes("Variable pressure."));
  const invalid = weaponPreset({ ...weapon, chambers: [{ barrelLength: NaN, multiplier: 0 }], shotRule: { kind: "constant", value: Infinity } });
  assert.equal(invalid.barrelLength, null);
  assert.equal(invalid.chamberMultiplier, null);
  assert.equal(invalid.velocityMultiplier, null);
});

test("sticky shot charge uses the verified 1 + bonus × charge rule", () => {
  const sticky = { ...weapon, shotRule: { kind: "sticky", bonus: 2 } };
  assert.equal(weaponPreset(sticky).velocityMultiplier, 1);
  assert.equal(weaponPreset(sticky, 0, 50).velocityMultiplier, 2);
  assert.equal(weaponPreset(sticky, 0, 100).velocityMultiplier, 3);
  assert.equal(weaponPreset(sticky, 0, 101).velocityMultiplier, null);
  assert.equal(weaponPreset(sticky, 0, NaN).velocityMultiplier, null);
});

let data;
try {
  data = JSON.parse(await readFile(new URL("../public/data/h3vr.json", import.meta.url), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

test("local game extraction supplies traceable weapon presets that feed the calculator and CSV", { skip: !data && "Run npm run extract for install integration checks" }, () => {
  assert.equal(data.schemaVersion, 2);
  const byCaliber = new Map(data.calibers.map((item) => [item.id, item]));
  assert.equal(new Set(data.weapons.map((item) => item.id)).size, data.weapons.length);
  const automatic = data.weapons.filter((item) => {
    const preset = weaponPreset(item);
    return preset.barrelLength !== null && preset.chamberMultiplier !== null && preset.velocityMultiplier !== null;
  });
  assert.ok(automatic.length > 600);
  for (const item of automatic) {
    const preset = weaponPreset(item);
    assert.ok(byCaliber.has(preset.caliberId));
    assert.ok(item.source.bundle && item.source.assetName && item.source.pathId);
    assert.ok(item.shotRule.source.class && item.shotRule.source.methods.length);
  }
  const akm = data.weapons.find((item) => item.id === "AKM");
  const preset = weaponPreset(akm);
  assert.equal(preset.barrelLength, 0.412201486494956);
  assert.equal(preset.velocityMultiplier, 1);
  const python = weaponPreset(data.weapons.find((item) => item.id === "Python"));
  assert.equal(python.chamberMultiplier, 1.149999976158142);
  const round = data.rounds.find((item) => item.caliberId === preset.caliberId && item.roundClass === "FMJ");
  const options = {
    ...preset, weapon: akm, caliber: byCaliber.get(preset.caliberId),
    zeroModel: "game", zeroRange: 100, sightHeight: 0.05, sightSetback: 0,
    targetRange: 100, rangeStep: 50, gravity: 9.8100004196167,
    sceneLimit: 1000, worldHeight: 1.6, catchHeight: -50,
    fixedStep: data.settings.fixedDeltaTime, firstStep: data.settings.fixedDeltaTime,
  };
  const result = calculate(round, data.settings, options);
  assert.ok(result.muzzleSpeed > 0);
  const csv = toCSV(result, round, options);
  assert.ok(csv.includes('"Weapon","AKM"'));
  assert.ok(csv.includes('"Effective chamber-to-muzzle distance m","0.412201486494956"'));
});
