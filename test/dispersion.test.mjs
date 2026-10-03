import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dispersion, dispersionAtRange, calculate, toCSV } from "../public/physics.js";
import { solve } from "../public/solver-worker.js";

// The composition below is transcribed from FistVR.FVRFireArm::Fire (RVA
// 428892). Both mechanical terms are Random.Range(class.MinDegrees,
// class.MaxDegrees) * 0.5, drawn once in Awake, so they are fixed per spawned
// object but not reproducible between sessions.
const curve = (value) => ({ keys: [{ time: 0, value, inSlope: 0, outSlope: 0 }] });
const settings = {
  dragCurve: curve(0),
  accuracyClasses: [
    { id: 41, name: "BoltActionPrecision", minMoa: 0.45, maxMoa: 0.45, minDegrees: 0.01, maxDegrees: 0.01, dropMult: 1, driftMult: 1 },
    { id: 100, name: "SuppressorOld", minMoa: 1.5, maxMoa: 1.5, minDegrees: 0.025, maxDegrees: 0.025, dropMult: 1, driftMult: 1 },
    { id: 101, name: "SuppressorWide", minMoa: 1, maxMoa: 4, minDegrees: 0.016666666, maxDegrees: 0.066666666, dropMult: 1, driftMult: 1 },
  ],
};
const rifle = { name: "MRAD", hashId: "MRAD", accuracyClass: 41 };
const silencer = { name: "Maxim", hashId: "Maxim", accuracyClass: 100, kind: "suppressor" };
const wide = { name: "Wide", hashId: "Wide", accuracyClass: 101, kind: "suppressor" };
const profile = {
  name: "Test", id: "Test", muzzleVelocity: 800, mass: 0.016, diameter: 0.0085,
  spreadDegrees: 0, flightVelocityMultiplier: 1, airDragMultiplier: 1, gravityMultiplier: 1,
  maxRange: 5000, maxRangeRandom: 0, deletesOnStraightDown: true,
};
const options = {
  attachments: [], caliber: { barrelCurve: curve(1), opticDropCurve: curve(0) },
  zeroModel: "unadjusted", zeroRange: 100, barrelLength: 0.6,
  chamberMultiplier: 1, velocityMultiplier: 1,
  sightHeight: 0.07, sightSetback: 0.56, inclinationDegrees: 0,
  targetRange: 600, rangeStep: 100, gravity: 9.8100004196167,
  fixedStep: 0.01, firstStep: 0.01, sceneLimit: 2500,
  worldHeight: 1.6, catchHeight: -50,
};
// Every dispersion value descends from float32 game fields, so comparisons
// carry float32-scale tolerance rather than exact equality.
const close = (actual, expected, tolerance = 1e-6) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

test("mechanical spread is half the class angle, and the firearm contributes with no device fitted", () => {
  const bare = dispersion(settings, { ...options, weapon: rifle }, profile);
  close(bare.firearm.min, 0.005);
  close(bare.maxDegrees, 0.005);
  close(bare.maxMoa, 0.3);
  assert.equal(bare.incomplete, false);
  // Unlike fixed drift, which is zero with no devices, the firearm's own
  // mechanical term is always present.
  assert.ok(bare.maxMoa > 0);
});

test("device mechanical spread adds across every registered device", () => {
  const one = dispersion(settings, { ...options, weapon: rifle, attachments: [silencer] }, profile);
  close(one.maxDegrees, 0.005 + 0.0125);
  close(one.maxMoa, 1.05);
  const both = dispersion(settings, { ...options, weapon: rifle, attachments: [silencer, wide] }, profile);
  close(both.maxDegrees, 0.005 + 0.0125 + 0.033333333);
  close(both.minDegrees, 0.005 + 0.0125 + 0.008333333);
});

test("the authored round spread is the base term and needs no weapon", () => {
  const manual = dispersion(settings, { ...options, weapon: null }, { ...profile, spreadDegrees: 0.4 });
  close(manual.maxDegrees, 0.4);
  close(manual.maxMoa, 24);
  assert.equal(manual.incomplete, false);
});

test("an uncertified component is excluded and named, never guessed or silently zero", () => {
  const unverified = dispersion(settings, { ...options, weapon: { name: "M320", accuracyClass: null } }, profile);
  assert.equal(unverified.incomplete, true);
  assert.deepEqual(unverified.missing, ["selected weapon accuracy class"]);
  close(unverified.maxDegrees, 0);
  const noRound = dispersion(settings, { ...options, weapon: rifle }, { ...profile, spreadDegrees: undefined });
  assert.ok(noRound.missing.includes("round spread"));
  assert.equal(noRound.incomplete, true);
  assert.throws(
    () => dispersion(settings, { ...options, attachments: [{ name: "X", accuracyClass: "nope" }] }, profile),
    /accuracy class/,
  );
});

test("the cone grows linearly with range and the typical radius is the three-sample mean", () => {
  const model = dispersion(settings, { ...options, weapon: rifle }, profile);
  const near = dispersionAtRange(model, 300);
  const far = dispersionAtRange(model, 1200);
  close(far.boundDiameter, 4 * near.boundDiameter, 1e-9);
  // Fire averages three uniform unit-disc samples, so its mean has E|v|^2 = 1/6.
  close(near.typicalRadius / near.boundRadius, Math.sqrt(1 / 6), 1e-9);
  close(near.boundRadius, 300 * Math.tan(0.005 * Math.PI / 180), 1e-9);
});

test("the reported cone never enters the centreline it annotates", () => {
  // Authored spread is a reported launch bias, not an integrated force: two
  // rounds differing only in spreadDegrees must trace the same flight.
  const base = { ...options, weapon: rifle, attachments: [silencer], rangeStep: 200 };
  const tight = calculate({ ...profile, spreadDegrees: 0 }, settings, base);
  const loose = calculate({ ...profile, spreadDegrees: 2 }, settings, base);
  assert.deepEqual(loose.rows.map((row) => [row.height, row.lateral, row.time, row.speed]),
    tight.rows.map((row) => [row.height, row.lateral, row.time, row.speed]));
  assert.deepEqual(loose.correctedFlight.points, tight.correctedFlight.points);
  assert.deepEqual(loose.correctedFlight.target, tight.correctedFlight.target);
  // Only the reported cone differs, and the authored term adds in angle rather
  // than scaling: a cone is an angular bound projected linearly onto the range.
  close(loose.spread.maxDegrees - tight.spread.maxDegrees, 2, 1e-6);
  close(loose.targetSpread.boundRadius, loose.correctedFlight.target.range * Math.tan(2.0175 * Math.PI / 180), 1e-6);
  assert.ok(loose.targetSpread.boundRadius > tight.targetSpread.boundRadius * 50);
  for (const row of loose.rows)
    close(row.spreadRadius, row.range * Math.tan(loose.spread.maxDegrees * Math.PI / 180), 1e-6);
  // The reported cone uses the corrected impact range, not the base flight's.
  close(loose.targetSpread.boundRadius, loose.correctedFlight.target.range * Math.tan(loose.spread.maxDegrees * Math.PI / 180), 1e-6);
});

test("a fitted device widens the cone even though it also moves the centreline", () => {
  const withDevice = { ...options, weapon: rifle, attachments: [silencer] };
  const bare = calculate(profile, settings, { ...withDevice, attachments: [] });
  const fitted = calculate(profile, settings, withDevice);
  // The device carries its own fixed drift and drop, so the centreline moves.
  assert.notEqual(fitted.target.lateral, bare.target.lateral);
  assert.ok(fitted.targetSpread.boundRadius > bare.targetSpread.boundRadius);
  close(fitted.spread.maxDegrees, 0.005 + 0.0125, 1e-6);
});

test("CSV records every dispersion component and its non-reproducible interpretation", () => {
  const withDevice = { ...options, weapon: rifle, attachments: [silencer], rangeStep: 200 };
  const csv = toCSV(calculate(profile, settings, withDevice), profile, withDevice);
  assert.match(csv, /"Dispersion total max degrees","0\.0175\d*"/);
  assert.match(csv, /"Dispersion firearm mechanical max degrees","0\.0049999\d*"/);
  assert.match(csv, /"Dispersion device mechanical max degrees total","0\.0125000\d*"/);
  assert.match(csv, /"Dispersion complete","yes"/);
  assert.match(csv, /not a predicted group and not reproducible/);
  assert.match(csv, /"Projectile spawn recess behind muzzle m","0.004999999888241291"/);
  assert.match(csv, /dispersion_radius_cm,dispersion_typical_radius_cm/);
});

test("the projectile spawns 5 mm behind the muzzle, as Fire's own transform offset does", () => {
  // The recess is a verified source constant, so a zero-setback optic puts the
  // spawn 5 mm behind the optical origin and range is measured from the origin.
  const result = calculate(profile, settings, { ...options, sightSetback: 0, sightHeight: 0, gravity: 0, zeroModel: "unadjusted" });
  close(result.correctedFlight.points[0].range, -0.004999999888241291, 1e-12);
});

test("the worker solve returns the same structured-cloneable solution as the direct call", () => {
  const request = { profile, settings, options: { ...options, weapon: rifle, attachments: [silencer] } };
  const direct = calculate(request.profile, request.settings, request.options);
  const response = solve(request);
  assert.equal(response.ok, true);
  assert.deepEqual(response.solution, direct);
  // Everything crossing the worker boundary must survive a structured clone.
  assert.deepEqual(structuredClone(response), response);
});

test("the worker reports an unreachable setup as a message, not a thrown error", () => {
  const response = solve({ profile, settings, options: { ...options, sceneLimit: 5, rangeStep: 100 } });
  assert.equal(response.ok, false);
  assert.match(response.message, /cannot reach/);
  assert.equal(response.solution, undefined);
});

let localData;
try {
  localData = JSON.parse(await readFile(new URL("../public/data/h3vr.json", import.meta.url), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

test("a real dataset round with authored spread widens the cone beyond its firearm term", { skip: !localData && "Run npm run extract for install integration checks" }, () => {
  const scoped = localData.rounds.find((round) => round.spreadDegrees > 0
    && round.caliberId === 50 && round.muzzleVelocity > 600)
    ?? localData.rounds.find((round) => round.spreadDegrees > 0 && round.muzzleVelocity > 600);
  assert.ok(scoped, "expected a fast round with an authored spread");
  const rifleReal = localData.weapons.find((weapon) => weapon.id === "MRAD");
  const caliber = localData.calibers.find((item) => item.id === scoped.caliberId);
  const model = dispersion(localData.settings, {
    weapon: rifleReal, attachments: [],
    caliber: { barrelCurve: caliber.barrelCurve, opticDropCurve: caliber.opticDropCurve },
  }, scoped);
  close(model.maxDegrees, scoped.spreadDegrees + 0.005, 1e-6);
  assert.ok(model.maxMoa > scoped.spreadDegrees * 60, "the firearm term must widen the round's own spread");
  const result = calculate(scoped, localData.settings, {
    ...options, weapon: rifleReal, caliber,
    sightHeight: 0.075, sightSetback: 0.6, sceneLimit: 5000, targetRange: 300, rangeStep: 100,
    fixedStep: localData.settings.fixedDeltaTime, firstStep: localData.settings.fixedDeltaTime,
  });
  assert.ok(result.targetSpread.boundRadius > 0);
  assert.equal(result.spread.incomplete, false);
});