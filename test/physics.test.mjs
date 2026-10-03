import test from "node:test";
import assert from "node:assert/strict";
import { calculate, evaluateCurve, toCSV } from "../public/physics.js";

const constantCurve = (value) => ({
  keys: [
    { time: 0, value, inSlope: 0, outSlope: 0 },
    { time: 10, value, inSlope: 0, outSlope: 0 },
  ],
});
const settings = { dragCurve: constantCurve(0) };
const profile = {
  muzzleVelocity: 100,
  mass: 0.01,
  diameter: 0.01,
  airDragMultiplier: 1,
  gravityMultiplier: 1,
  flightVelocityMultiplier: 1,
  maxRange: 5000,
  maxRangeRandom: 0,
  deletesOnStraightDown: true,
};
const setup = {
  caliber: { barrelCurve: constantCurve(1), opticDropCurve: constantCurve(-1) },
  zeroModel: "game",
  zeroRange: 100,
  barrelLength: 0.5,
  chamberMultiplier: 1,
  velocityMultiplier: 1,
  sightHeight: 0.05,
  sightSetback: 0,
  targetRange: 100,
  rangeStep: 50,
  gravity: 10,
  fixedStep: 0.01,
  firstStep: 0.01,
  sceneLimit: 5000,
  worldHeight: 1.6,
  catchHeight: -50,
};
const close = (actual, expected, tolerance = 1e-6) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} differs from ${expected} by more than ${tolerance}`,
  );
};

test("nominal optic zero stays fixed when ammunition speed changes, and retains the resulting miss", () => {
  const slow = calculate(profile, settings, setup);
  const fast = calculate({ ...profile, muzzleVelocity: 200 }, settings, setup);
  close(slow.boreAngle, fast.boreAngle);
  assert.ok(
    slow.target.height < -3,
    "a slow round must not be forced through the nominal zero",
  );
  assert.ok(fast.target.height > slow.target.height + 3);
  assert.ok(slow.target.elevationMrad > 0);
});

test("calculated zero actually crosses the sight line rather than using the authored optic curve", () => {
  const result = calculate(profile, settings, {
    ...setup,
    zeroModel: "calculated",
  });
  close(result.target.height, 0, 0.001);
  const nominal = calculate(profile, settings, setup);
  assert.ok(result.boreAngle > nominal.boreAngle);
});

test("corrected flight retraces the solved launch without replacing the base trajectory or range card", () => {
  for (const inclinationDegrees of [-60, 0, 60]) {
    const options = { ...setup, targetRange: 150, inclinationDegrees };
    const result = calculate(profile, settings, options);
    const corrected = result.correctedFlight;
    close(corrected.boreAngle, result.boreAngle + result.target.elevationMrad / 1000);
    close(corrected.boreYaw, result.boreYaw + result.target.windageMrad / 1000);
    close(corrected.target.height, 0, 0.001);
    close(corrected.target.lateral, 0, 0.001);
    assert.ok(Math.abs(result.target.height) > 0.1);
    assert.notDeepEqual(corrected.points, result.points);
    const equivalent = calculate(profile, settings, { ...options, zeroModel: "calculated", zeroRange: options.targetRange });
    assert.deepEqual(corrected.points, equivalent.points,
      "The corrected path must match the actual integrator at the solved launch angles");
    assert.equal(result.target, result.rows.find((row) => row.isTarget));
    assert.ok(toCSV(result, profile, options).includes(`${result.target.height * 100},${result.target.lateral * 100}`));
  }
});

test("flight multiplier changes displacement and flight time, not the drag velocity state", () => {
  const options = {
    ...setup,
    gravity: 0,
    sightHeight: 0,
    zeroModel: "geometric",
  };
  const normal = calculate(profile, settings, options);
  const slowFlight = calculate(
    { ...profile, flightVelocityMultiplier: 0.5 },
    settings,
    options,
  );
  close(slowFlight.target.time, normal.target.time * 2, 0.0001);
  close(slowFlight.target.speed, 100);
});

test("the immediate Fire tick uses its own delta and gravity precedes displacement", () => {
  const options = {
    ...setup,
    sightHeight: 0,
    zeroModel: "geometric",
    targetRange: 1.495,
    rangeStep: 2,
  };
  const fixedFirst = calculate(profile, settings, options);
  const renderFirst = calculate(profile, settings, {
    ...options,
    firstStep: 0.02,
  });
  close(fixedFirst.target.height, -0.002, 0.000001);
  close(renderFirst.target.height, -0.003, 0.000001);
  close(renderFirst.target.time, 0.015, 0.000001);
});

test("travelled-range termination happens after a full FixedUpdate, not before Fire or mid-segment", () => {
  const options = {
    ...setup,
    sightHeight: 0,
    zeroModel: "geometric",
    gravity: 0,
    sceneLimit: 1,
    firstStep: 0.02,
    targetRange: 2.5,
    rangeStep: 3,
  };
  const result = calculate(profile, settings, options);
  close(result.target.height, 0);
  close(result.target.time, 0.02505, 0.000001);
  assert.throws(
    () => calculate(profile, settings, { ...options, targetRange: 4 }),
    /cannot reach/,
  );
});

test("barrel curves clamp outside the authored interval and preserve endpoint velocities", () => {
  const curve = {
    keys: [
      { time: 2, value: 0.5, inSlope: 0.1, outSlope: 0.1 },
      { time: 12, value: 1, inSlope: 0, outSlope: 0 },
    ],
  };
  close(evaluateCurve(curve, 0), 0.5);
  close(evaluateCurve(curve, 100), 1);
  const options = {
    ...setup,
    caliber: { ...setup.caliber, barrelCurve: curve },
  };
  close(
    calculate(profile, settings, { ...options, barrelLength: 0 }).muzzleSpeed,
    50,
  );
  close(
    calculate(profile, settings, { ...options, barrelLength: 10 }).muzzleSpeed,
    100,
  );
});

test("unreachable flight reports a failure rather than an invented correction", () => {
  assert.throws(
    () =>
      calculate({ ...profile, maxRange: 10 }, settings, {
        ...setup,
        targetRange: 1000,
      }),
    /cannot reach/,
  );
});

test("a disabled factory base zero ignores nominal setting without inventing a crossing", () => {
  const options = { ...setup, zeroModel: "unadjusted" };
  const first = calculate(profile, settings, options);
  const second = calculate(profile, settings, { ...options, zeroRange: 300 });
  close(first.boreAngle, 0);
  close(first.target.height, second.target.height);
  assert.ok(first.target.height < -5);
});

test("omitting the firing angle preserves the level-fire result", () => {
  assert.deepEqual(
    calculate(profile, settings, setup),
    calculate(profile, settings, { ...setup, inclinationDegrees: 0 }),
  );
});

test("inclined fire keeps gravity world-down and samples range along the sight line", () => {
  const options = {
    ...setup, zeroModel: "unadjusted", sightHeight: 0,
    targetRange: 0.995, rangeStep: 1, firstStep: 0.02,
  };
  // In the immediate fire tick, v_along = v - g*dt*sin(angle),
  // v_normal = -g*dt*cos(angle). The muzzle starts 0.005 m behind
  // the origin, so a target at 0.995 m is exactly 1 m along the line.
  for (const angle of [0, 45, -45, 90, -90]) {
    const radians = angle * Math.PI / 180;
    const alongSpeed = 100 - 10 * 0.02 * Math.sin(radians);
    const result = calculate(profile, settings, { ...options, inclinationDegrees: angle });
    close(result.target.time, 1 / alongSpeed, 0.0000001);
    close(result.target.height, -10 * 0.02 * Math.cos(radians) / alongSpeed, 0.0000001);
  }
  const uphill = calculate(profile, settings, { ...options, inclinationDegrees: 45 });
  const downhill = calculate(profile, settings, { ...options, inclinationDegrees: -45 });
  assert.ok(uphill.target.time > downhill.target.time);
});

test("without gravity, tilting the entire firing setup preserves flight relative to the sight line", () => {
  const options = { ...setup, zeroModel: "unadjusted", sightHeight: 0, gravity: 0 };
  const level = calculate(profile, settings, options);
  for (const angle of [-60, 60]) {
    const tilted = calculate(profile, settings, { ...options, inclinationDegrees: angle });
    // Rotating float32 positions introduces small projection roundoff.
    close(tilted.target.height, level.target.height, 0.0001);
    close(tilted.target.time, level.target.time, 0.00001);
    close(tilted.target.speed, level.target.speed, 0.0001);
  }
});

test("factory optic zero remains relative to the sight line when the firing angle changes", () => {
  const level = calculate(profile, settings, setup);
  for (const angle of [-45, 45]) {
    const tilted = calculate(profile, settings, { ...setup, inclinationDegrees: angle });
    close(tilted.boreAngle, level.boreAngle);
    close(tilted.muzzleSpeed, level.muzzleSpeed);
    assert.ok(tilted.target.height > level.target.height);
  }
});

test("calculated zero solves the crossing for uphill and downhill shots", () => {
  for (const angle of [-30, 30]) {
    const result = calculate(profile, settings, { ...setup, zeroModel: "calculated", inclinationDegrees: angle });
    close(result.target.height, 0, 0.001);
    close(result.target.elevationMrad, 0, 0.001);
  }
});

test("inclined trajectories still obey the world-height boundary", () => {
  const options = { ...setup, zeroModel: "unadjusted", sightHeight: 0, gravity: 0, targetRange: 1000 };
  assert.equal(calculate(profile, settings, options).target.range, 1000);
  assert.throws(
    () => calculate(profile, settings, { ...options, inclinationDegrees: -30 }),
    /cannot reach.*world-height boundary/,
  );
});

test("firing angles outside ±90° or nonfinite angles are rejected", () => {
  for (const angle of [-91, 91, Infinity, NaN]) {
    assert.throws(
      () => calculate(profile, settings, { ...setup, inclinationDegrees: angle }),
      /inclination.*finite|inclination.*between/i,
    );
  }
});

test("CSV records the selected firing angle and sight-line range convention", () => {
  const options = { ...setup, inclinationDegrees: -30 };
  const result = calculate(profile, settings, options);
  const csv = toCSV(result, profile, options);
  assert.ok(csv.includes('"Sight-line inclination degrees","-30"'));
  assert.ok(csv.includes('"Range interpretation","Distance along line of sight from optical origin"'));
});
