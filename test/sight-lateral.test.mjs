import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { calculate, sightClearance, toCSV } from "../public/physics.js";
import { centredCases, fingerprint, profile as centredProfile, settings as centredSettings } from "./helpers/centred-cases.mjs";

// A sideways optic (sightLateral, metres, + right of the bore seen from behind).
// The authored zero rules aim the optic at the zero distance along the bore from
// the muzzle, displaced vertically by the authored drop; with the bore pose
// B = Ry(yaw) Rx(-pitch) relative to the sight, that toes the bore in by
// atan2(lateral, hypot(zero + setback, height - drop)) and leaves pitch alone.
const curve = (value) => ({ keys: [{ time: 0, value, inSlope: 0, outSlope: 0 }] });
const settings = {
  dragCurve: curve(0),
  accuracyClasses: [
    { id: 33, minDegrees: 0, maxDegrees: 0, dropMult: 0.8999999761581421, driftMult: 2 },
    { id: 100, minDegrees: 0, maxDegrees: 0, dropMult: 1.100000023841858, driftMult: 2 },
  ],
};
const dragged = { ...settings, dragCurve: curve(0.3) };
const weapon = { name: "M4Carbine", hashId: "M4Carbine", accuracyClass: 33 };
const profile = {
  name: "Test", id: "Test", muzzleVelocity: 800, mass: 0.01, diameter: 0.01, spreadDegrees: 0,
  flightVelocityMultiplier: 1, airDragMultiplier: 1, gravityMultiplier: 1,
  maxRange: 5000, maxRangeRandom: 0, deletesOnStraightDown: true,
};
const options = {
  weapon, attachments: [], caliber: { barrelCurve: curve(1), opticDropCurve: curve(0) },
  zeroModel: "game", zeroRange: 100, barrelLength: 0.5,
  chamberMultiplier: 1, velocityMultiplier: 1,
  sightHeight: 0.07, sightSetback: 0.4, inclinationDegrees: 0,
  targetRange: 600, rangeStep: 50, gravity: 9.8100004196167,
  fixedStep: 0.01, firstStep: 0.01, sceneLimit: 5000,
  worldHeight: 1000, catchHeight: -50,
};
const close = (actual, expected, tolerance = 1e-6, label = "") => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}${actual} != ${expected} (tolerance ${tolerance})`);
};
const settingRow = (result) => result.rows.find((row) => row.isSetting);
// The two-axis solver's own convergence bound at a range.
const solverTolerance = (range) => Math.max(0.000001, range * 0.000001);

// Plain 3x3 rotations, written out independently of trace(): x right, y up, z forward.
const multiply = (A, B) => A.map((row) => B[0].map((_, j) => row.reduce((sum, _, k) => sum + row[k] * B[k][j], 0)));
const apply = (A, v) => A.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
const transpose = (A) => A[0].map((_, j) => A.map((row) => row[j]));
const yawRight = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const pitchDown = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const borePose = (pitch, yaw) => multiply(yawRight(yaw), pitchDown(-pitch));
// The sight's forward axis in bore coordinates (origin at the muzzle, bore along +z).
const sightAxis = (pitch, yaw) => apply(transpose(borePose(pitch, yaw)), [0, 0, 1]);

// Deterministic pseudo-random numbers, so a failure is reproducible.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("a centred optic reproduces the model before lateral offsets, omitted or explicitly zero", async () => {
  // Pinned from commit 4754a03 by the same cases and fingerprint (see helpers).
  const expected = JSON.parse(await readFile(new URL("./fixtures/centred-optic-4754a03.json", import.meta.url), "utf8"));
  const cases = centredCases();
  assert.equal(cases.length, expected.length);
  cases.forEach((setup, index) => {
    const omitted = calculate(centredProfile, centredSettings, setup);
    assert.deepEqual(fingerprint(omitted), expected[index], `case ${index}`);
    assert.deepEqual(fingerprint(calculate(centredProfile, centredSettings, { ...setup, sightLateral: 0 })), expected[index], `case ${index}, explicit 0`);
    if (setup.zeroModel !== "calculated") assert.ok(Object.is(omitted.boreYaw, 0), "no toe-in without an offset");
  });
});

test("the optic-setting row keeps the previous distance bit for bit with no lateral offset", () => {
  // hypot(a, b, 0) is not always hypot(a, b): it can round differently once |b|
  // outgrows a. A zero of a centimetre against a large authored drop does that.
  for (const [zeroRange, sightHeight, sightSetback, drop] of [[100, 0.07, 0.4, -0.04], [0.01, 0.041, 0, -0.5], [0.01, 0.055, 0, -0.5], [0.3, 0.07, -0.1, -2]]) {
    const setup = { ...options, zeroRange, sightHeight, sightSetback, targetRange: zeroRange < 1 ? 10 : 200, rangeStep: 5, caliber: { ...options.caliber, opticDropCurve: curve(drop) } };
    const result = calculate(profile, dragged, setup);
    assert.equal(result.settingRange, Math.hypot(zeroRange + sightSetback, result.authoredDrop - sightHeight));
    assert.equal(settingRow(result).range, result.settingRange);
  }
});

test("authored zeros toe the bore in to the zero point on the bore line without changing its pitch", () => {
  for (const [sightLateral, sightHeight, sightSetback, zeroRange, drop] of [[0.04, 0.07, 0.4, 100, 0], [-0.06, 0.05, -0.05, 25, -0.2], [0.15, 0.12, 0.9, 300, -1.5]]) {
    for (const zeroModel of ["game", "geometric"]) {
      const setup = { ...options, zeroModel, zeroRange, sightHeight, sightSetback, targetRange: 500, rangeStep: 100, caliber: { ...options.caliber, opticDropCurve: curve(drop) } };
      const centred = calculate(profile, dragged, setup);
      const offset = calculate(profile, dragged, { ...setup, sightLateral });
      assert.equal(offset.boreAngle, centred.boreAngle, "toe-in leaves the pitch unchanged");
      assert.ok(Math.sign(offset.boreYaw) === Math.sign(sightLateral), "the bore turns toward the optic's side");
      // Independently of the closed form: the sight ray from the optical origin at
      // (lateral, height, -setback) reaches the authored point (0, drop, zero),
      // and the distance along it is the optic-setting range.
      const axis = sightAxis(offset.boreAngle, offset.boreYaw);
      const along = offset.settingRange;
      const reached = [sightLateral + along * axis[0], sightHeight + along * axis[1], -sightSetback + along * axis[2]];
      close(reached[0], 0, 1e-12, "lateral ");
      close(reached[1], offset.authoredDrop, 1e-12, "height ");
      close(reached[2], zeroRange, 1e-9, "forward ");
    }
  }
});

test("the projectile spawns where the bore pose puts the muzzle, toe-in included", () => {
  // A short zero and a wide offset make the toe-in large enough that turning the
  // lateral offset the wrong way round would move the spawn by centimetres.
  const recess = 0.005; // Spawned 5 mm behind the muzzle, along the bore.
  for (const zeroModel of ["game", "geometric", "calculated"])
    for (const sightLateral of [0.1, -0.07]) {
      const setup = { ...options, zeroModel, zeroRange: 1.5, sightLateral, targetRange: 50, rangeStep: 10, caliber: { ...options.caliber, opticDropCurve: curve(-0.01) } };
      const result = calculate(profile, dragged, setup);
      assert.ok(Math.abs(result.boreYaw) > 0.03);
      for (const [pitch, yaw, point] of [[result.boreAngle, result.boreYaw, result.points[0]],
        [result.correctedFlight.boreAngle, result.correctedFlight.boreYaw, result.correctedFlight.points[0]]]) {
        const muzzle = apply(borePose(pitch, yaw), [-sightLateral, -setup.sightHeight, setup.sightSetback - recess]);
        close(point.lateral, muzzle[0], 1e-6, `${zeroModel} lateral `);
        close(point.height, muzzle[1], 1e-6, `${zeroModel} height `);
        close(point.range, muzzle[2], 1e-6, `${zeroModel} range `);
      }
    }
});

test("with no gravity or drag, the toed-in bore crosses the sight line at the optic-setting range in both axes", () => {
  for (const zeroModel of ["geometric", "game"])
    for (const extra of [{}, { inclinationDegrees: 30 }, { inclinationDegrees: -20 }, { cantMode: "specific", cantDegrees: 15 },
      { sightLateral: -0.06, sightSetback: -0.05 }, { zeroRange: 37, sightLateral: 0.1 }]) {
      const result = calculate(profile, settings, { ...options, zeroModel, gravity: 0, sightLateral: 0.04, ...extra });
      const row = settingRow(result);
      close(row.height, 0, 0.00002, `${zeroModel} ${JSON.stringify(extra)} height `);
      close(row.lateral, 0, 0.00002, `${zeroModel} ${JSON.stringify(extra)} lateral `);
    }
  // A displaced authored point lies off the bore axis vertically only, so a
  // straight shot still crosses the sight line laterally there.
  const displaced = calculate(profile, settings, { ...options, gravity: 0, sightLateral: 0.04, caliber: { ...options.caliber, opticDropCurve: curve(-0.3) } });
  close(settingRow(displaced).lateral, 0, 0.00002);
  close(settingRow(displaced).height, 0.3, 0.001);
});

test("a toed-in base shot crosses the sight line laterally only at the optic setting and then drifts toward the optic's side", () => {
  for (const sightLateral of [0.04, -0.04]) {
    const result = calculate(profile, dragged, { ...options, sightLateral, targetRange: 1000, rangeStep: 25, caliber: { ...options.caliber, opticDropCurve: curve(-0.05) } });
    const side = Math.sign(sightLateral);
    close(settingRow(result).lateral, 0, 0.000001);
    for (const row of result.rows) {
      if (row.range < result.settingRange - 1) assert.ok(row.lateral * side < 0, `${row.range} m starts on the bore's side`);
      if (row.range > result.settingRange + 1) assert.ok(row.lateral * side > 0, `${row.range} m ends on the optic's side`);
    }
    // Drag acts along the velocity and gravity is world-down, so a level,
    // uncanted shot's plan view is the straight line of the toe-in.
    const near = result.rows.find((row) => row.range === 500), far = result.rows.find((row) => row.range === 1000);
    close((far.lateral - near.lateral) / 500, Math.tan(result.boreYaw), 1e-7);
    // The solved windage removes that miss, and the corrected round lands on aim.
    assert.ok(result.target.windageMrad * side < 0);
    close(result.correctedFlight.target.lateral, 0, solverTolerance(1000));
  }
});

test("calculated zero solves both axes, so the base shot crosses the sight line at the zero range", () => {
  for (const extra of [{}, { cantMode: "specific", cantDegrees: -20 }, { inclinationDegrees: 25 }, { sightLateral: -0.08, sightSetback: 0 }]) {
    const setup = { ...options, zeroModel: "calculated", sightLateral: 0.04, ...extra };
    const result = calculate(profile, dragged, setup);
    assert.equal(result.settingRange, setup.zeroRange);
    const row = settingRow(result);
    close(row.height, 0, solverTolerance(setup.zeroRange), `${JSON.stringify(extra)} height `);
    close(row.lateral, 0, solverTolerance(setup.zeroRange), `${JSON.stringify(extra)} lateral `);
    if (!extra.cantMode) close(result.boreYaw, setup.sightLateral / setup.zeroRange, Math.abs(setup.sightLateral / setup.zeroRange) * 0.01);
  }
});

test("no base zero adjustment keeps the optic parallel, so the base shot stays the full offset to the bore's side", () => {
  for (const extra of [{}, { gravity: 0 }, { inclinationDegrees: 30 }, { sightLateral: -0.025 }]) {
    const setup = { ...options, zeroModel: "unadjusted", sightLateral: 0.04, ...extra };
    const result = calculate(profile, dragged, setup);
    assert.ok(Object.is(result.boreYaw, 0));
    assert.equal(result.settingRange, null);
    const muzzle = Math.fround(-setup.sightLateral);
    assert.equal(result.points[0].lateral, muzzle);
    for (const row of result.rows) assert.equal(row.lateral, muzzle);
    if (!setup.inclinationDegrees)
      for (const row of result.rows) close(row.windageMrad, Math.atan2(setup.sightLateral, row.range) * 1000, 0.00001);
  }
});

test("mirroring the optic to the other side mirrors the base flight exactly", () => {
  for (const zeroModel of ["game", "unadjusted"]) {
    const right = calculate(profile, dragged, { ...options, zeroModel, sightLateral: 0.035 });
    const left = calculate(profile, dragged, { ...options, zeroModel, sightLateral: -0.035 });
    // === rather than Object.is: the parallel optic's yaw is zero on both sides.
    assert.ok(left.boreYaw === -right.boreYaw);
    assert.equal(left.boreAngle, right.boreAngle);
    right.points.forEach((point, i) => {
      assert.equal(left.points[i].height, point.height);
      assert.ok(left.points[i].lateral === -point.lateral, `${point.range} m`);
    });
    // The solves themselves are only mirrored to the solver's tolerance.
    const aim = 2 * solverTolerance(options.targetRange) / options.targetRange * 1000;
    close(left.target.windageMrad, -right.target.windageMrad, aim);
    close(left.target.elevationMrad, right.target.elevationMrad, aim);
  }
});

test("a canted weapon rolls the lateral offset with it and still lands the corrected shot on aim", () => {
  const sightLateral = 0.04, sightHeight = options.sightHeight;
  for (const cantDegrees of [-30, 10, 45]) {
    // Parallel optic, straight flight: the muzzle stays at the rolled offset.
    const straight = calculate(profile, settings, { ...options, zeroModel: "unadjusted", gravity: 0, sightLateral, cantMode: "specific", cantDegrees });
    const roll = cantDegrees * Math.PI / 180;
    // Weapon-right is (cos, -sin) and weapon-up (sin, cos) in the sight's (lateral, height).
    const lateral = -sightLateral * Math.cos(roll) - sightHeight * Math.sin(roll);
    const height = sightLateral * Math.sin(roll) - sightHeight * Math.cos(roll);
    for (const point of [straight.points[0], straight.target]) {
      close(point.lateral, lateral, 1e-7);
      close(point.height, height, 1e-7);
    }
    for (const zeroModel of ["game", "calculated"]) {
      const result = calculate(profile, dragged, { ...options, zeroModel, sightLateral, cantMode: "specific", cantDegrees });
      close(result.correctedFlight.target.height, 0, solverTolerance(options.targetRange));
      close(result.correctedFlight.target.lateral, 0, solverTolerance(options.targetRange));
    }
  }
});

test("sightClearance matches a brute-force walk along the sight line in bore coordinates", () => {
  const next = random(20261017);
  for (let i = 0; i < 150; i++) {
    const sightLateral = (next() - 0.5) * 0.12, sightHeight = next() * 0.12, sightSetback = 0.05 + next() * 1.1;
    const pitch = (next() - 0.5) * 0.4, yaw = (next() - 0.5) * 0.2;
    const clearance = sightClearance({ sightHeight, sightSetback, sightLateral }, pitch, yaw);
    const axis = sightAxis(pitch, yaw);
    const end = sightSetback / axis[2];
    const at = (t) => [sightLateral + t * axis[0], sightHeight + t * axis[1], sightSetback - t * axis[2]];
    const muzzle = at(end);
    close(clearance.atMuzzle.right, muzzle[0], 1e-12);
    close(clearance.atMuzzle.up, muzzle[1], 1e-12);
    close(clearance.atMuzzle.behindMuzzle, 0, 1e-12);
    let best = Infinity, bestPoint = null;
    for (let step = 0; step <= 4000; step++) {
      const point = at(end * step / 4000), distance = Math.hypot(point[0], point[1]);
      if (distance < best) { best = distance; bestPoint = point; }
    }
    // The sampled minimum can only overestimate, by at most half a sample's lean.
    assert.ok(clearance.closest.distance <= best + 1e-12);
    close(clearance.closest.distance, best, end / 4000 * 0.5);
    close(clearance.closest.behindMuzzle, bestPoint[2], end / 4000 + 1e-9);
    close(clearance.closest.distance, Math.hypot(clearance.closest.right, clearance.closest.up), 1e-15);
  }
  assert.equal(sightClearance({ sightHeight: 0.07, sightSetback: 0, sightLateral: 0.03 }, 0.01, 0), null);
  assert.equal(sightClearance({ sightHeight: 0.07, sightSetback: -0.1 }, 0.01, 0), null);
  // A purely vertical crossing sits h / tan(pitch) along from the optic.
  const vertical = sightClearance({ sightHeight: 0.07, sightSetback: 0.9 }, 0.1, 0);
  close(vertical.closest.distance, 0, 1e-15);
  close(vertical.closest.behindMuzzle, 0.9 - 0.07 / Math.tan(0.1), 1e-12);
});

test("a long-range elevation tilts a centred sight line into the barrel and a sideways optic keeps it clear", () => {
  // A synthetic heavy, .50 BMG-like round out to 4000 m: the dial puts the
  // sight line about 88 mrad under the bore, more than height/setback allows.
  const heavy = { ...profile, muzzleVelocity: 860, mass: 0.0457, diameter: 0.01295 };
  const setup = { ...options, attachments: [], weapon: null, sightHeight: 0.07, sightSetback: 0.9, barrelLength: 0.74,
    targetRange: 4000, rangeStep: 1000, fixedStep: 0.01111111044883728, firstStep: 0.01111111044883728 };
  const air = { ...settings, dragCurve: curve(0.2) };
  const centred = calculate(heavy, air, setup);
  assert.ok(centred.correctedFlight.boreAngle > Math.atan2(0.07, 0.9));
  assert.ok(centred.sightClearance.atMuzzle.up < -0.005, "the sight line passes under the bore axis at the muzzle");
  close(centred.sightClearance.closest.distance, 0, 1e-12);
  assert.ok(centred.sightClearance.closest.behindMuzzle > 0.05);
  const offset = calculate(heavy, air, { ...setup, sightLateral: 0.04 });
  assert.ok(offset.sightClearance.closest.distance > 0.0399 && offset.sightClearance.closest.distance <= 0.04);
  close(offset.correctedFlight.boreAngle, centred.correctedFlight.boreAngle, 1e-6);
  // The calculation reports the clearance of its own corrected aim.
  assert.deepEqual(offset.sightClearance, sightClearance({ ...setup, sightLateral: 0.04 }, offset.correctedFlight.boreAngle, offset.correctedFlight.boreYaw));
  // The 100 m toe-in leaves the base shot well right at 4000 m; windage removes it.
  assert.ok(offset.target.lateral > 1.4 && offset.target.windageMrad < -0.35);
  const csv = toCSV(offset, heavy, { ...setup, sightLateral: 0.04 });
  assert.match(csv, /"Sight lateral offset m \(\+ right of bore\)","0\.04"/);
  assert.match(csv, /"Corrected sight line closest approach to bore axis cm","3\.99/);
  assert.equal(calculate(heavy, air, { ...setup, sightSetback: 0 }).sightClearance, null);
});
