import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { weaponPreset } from "../public/weapons.js";
import { calculate } from "../public/physics.js";

// Identities and DriftMult entries verified against the 120p3 assembly and
// extracted accuracy chart; see docs/horizontal-drift.md for the source trace.
const curve = (value) => ({ keys: [{ time: 0, value, inSlope: 0, outSlope: 0 }] });
const settings = {
  dragCurve: curve(0),
  accuracyClasses: [
    { id: 33, dropMult: 0.8999999761581421, driftMult: 2 },
    { id: 100, dropMult: 1.100000023841858, driftMult: 2 },
    { id: 101, dropMult: 1.399999976158142, driftMult: 4 },
  ],
};
const weapon = { name: "M4Carbine", hashId: "M4Carbine", accuracyClass: 33 };
const precision = { name: "Mk12", hashId: "SuppressorMk12", accuracyClass: 100, kind: "suppressor" };
const average = { name: "PBS1", hashId: "SuppressorPBS1", accuracyClass: 101, kind: "suppressor" };
const profile = {
  muzzleVelocity: 800, mass: 0.01, diameter: 0.01,
  flightVelocityMultiplier: 1, airDragMultiplier: 1, gravityMultiplier: 1,
  maxRange: 5000, maxRangeRandom: 0, deletesOnStraightDown: true,
};
const options = {
  weapon, attachments: [], caliber: { barrelCurve: curve(1), opticDropCurve: curve(0) },
  zeroModel: "game", zeroRange: 100, barrelLength: 0.4,
  chamberMultiplier: 1, velocityMultiplier: 1,
  sightHeight: 0.05, sightSetback: 0, inclinationDegrees: 0,
  targetRange: 500, rangeStep: 100, gravity: 9.8100004196167,
  fixedStep: 0.01, firstStep: 0.01, sceneLimit: 2000,
  worldHeight: 1000, catchHeight: -50,
};
const close = (actual, expected, tolerance = 0.000001) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

test("unattached centerline shots have no lateral drift, including inclined long-range shots", () => {
  for (const inclinationDegrees of [-60, 0, 60]) {
    const result = calculate(profile, settings, { ...options, targetRange: 1000, rangeStep: 250, inclinationDegrees });
    for (const row of result.rows) {
      close(row.lateral, 0);
      close(row.windageMoa, 0);
    }
    close(result.muzzleEffects.horizontalDriftMoa, 0);
  }
});

test("verified firearm/device identities produce a repeatable fixed yaw rather than random drift", () => {
  const attached = { ...options, attachments: [precision] };
  const result = calculate(profile, settings, attached);
  close(result.muzzleEffects.horizontalDriftMoa, 0.9768000245094299);
  close(result.muzzleEffects.verticalDriftMoa, -1.0263999700546265);
  assert.ok(result.target.lateral > 0, "Positive device yaw moves the group right");
  assert.ok(result.target.windageMoa < 0, "The required correction is left");
  assert.deepEqual(calculate(profile, settings, attached), result);
});

test("fixed angular drift grows approximately linearly with range", () => {
  const result = calculate(profile, settings, { ...options, attachments: [precision] });
  const near = result.rows.find((row) => row.range === 100);
  close(result.target.lateral, near.lateral * 5, 0.00001);
  close(result.target.lateral, 500 * Math.tan(result.muzzleEffects.yawDegrees * Math.PI / 180), 0.00001);
  close(result.target.windageMoa, near.windageMoa, 0.00001);
});

test("corrected flight cancels both deterministic device bias axes for inclined shots", () => {
  for (const inclinationDegrees of [-60, 0, 60]) {
    const result = calculate(profile, settings, { ...options, attachments: [precision], inclinationDegrees });
    assert.ok(result.target.lateral > 0);
    assert.ok(result.target.windageMrad < 0);
    close(result.correctedFlight.target.height, 0, 0.001);
    close(result.correctedFlight.target.lateral, 0, 0.001);
    close(result.correctedFlight.boreYaw, result.boreYaw + result.target.windageMrad / 1000);
    assert.notEqual(result.correctedFlight.points, result.points);
  }
});

test("fixed drift uses the last registered device rather than summing all devices", () => {
  const lastPrecision = calculate(profile, settings, { ...options, attachments: [average, precision] });
  const precisionOnly = calculate(profile, settings, { ...options, attachments: [precision] });
  close(lastPrecision.muzzleEffects.horizontalDriftMoa, precisionOnly.muzzleEffects.horizontalDriftMoa);
  const lastAverage = calculate(profile, settings, { ...options, attachments: [precision, average] });
  const averageOnly = calculate(profile, settings, { ...options, attachments: [average] });
  close(lastAverage.muzzleEffects.horizontalDriftMoa, averageOnly.muzzleEffects.horizontalDriftMoa);
  assert.notEqual(lastAverage.muzzleEffects.horizontalDriftMoa, lastPrecision.muzzleEffects.horizontalDriftMoa);
});

let localData;
try {
  localData = JSON.parse(await readFile(new URL("../public/data/h3vr.json", import.meta.url), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

test("bare MRAD with .338 Lapua AP has no modeled lateral bias at the reported 1000 m zero / 1215 m range", { skip: !localData && "Run npm run extract for install integration checks" }, () => {
  const rifle = localData.weapons.find((item) => item.id === "MRAD");
  const round = localData.rounds.find((item) => item.id === "338LapuaCartridgeAP");
  const preset = weaponPreset(rifle);
  assert.deepEqual(rifle.muzzlePose.forward, [0, 0, 1]);
  assert.equal(round.spreadDegrees, 0);
  const result = calculate(round, localData.settings, {
    ...options, ...preset, weapon: rifle,
    caliber: localData.calibers.find((item) => item.id === preset.caliberId),
    zeroRange: 1000, targetRange: 1215, rangeStep: 300,
    sightHeight: 0.075, sightSetback: 0.6, sceneLimit: 5000,
    fixedStep: localData.settings.fixedDeltaTime,
    firstStep: localData.settings.fixedDeltaTime,
  });
  close(result.muzzleEffects.horizontalDriftMoa, 0);
  close(result.target.lateral, 0);
  close(result.target.windageMrad, 0);
});
