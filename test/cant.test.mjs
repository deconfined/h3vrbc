import test from "node:test";
import assert from "node:assert/strict";
import { calculate, toCSV } from "../public/physics.js";
import { profile, settings, setup, device } from "./helpers/cant.mjs";

const close = (a, b, tolerance = 0.001) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

test("omitted and explicit zero cant preserve the original uncanted solution", () => {
  const original = calculate(profile, settings, setup);
  assert.deepEqual(calculate(profile, settings, { ...setup, cantMode: "none", cantDegrees: 0, cantToleranceDegrees: 0 }), original);
  const specific = calculate(profile, settings, { ...setup, cantMode: "specific", cantDegrees: 0 });
  assert.deepEqual(specific, original);
  assert.equal(original.cantUncertainty, null);
});

test("specific cant solves both weapon-local dial axes, including a sideways weapon and inclined shots", () => {
  const base = calculate(profile, settings, setup);
  for (const inclinationDegrees of [-45, 0, 45]) {
    for (const cantDegrees of [-90, -30, 15, 90]) {
      const options = { ...setup, inclinationDegrees, cantMode: "specific", cantDegrees };
      const result = calculate(profile, settings, options);
      close(result.correctedFlight.target.height, 0);
      close(result.correctedFlight.target.lateral, 0);
      assert.equal(result.correctedFlight.cantDegrees, cantDegrees);
      assert.equal(result.cantUncertainty, null);
      assert.equal(result.boreAngle, base.boreAngle, "Factory zero geometry remains in the weapon's local frame");
      assert.ok(cantDegrees > 0 ? result.target.windageMrad < 0 : result.target.windageMrad > 0);
    }
  }
});

test("specific cant also compensates muzzle-device bias, and calculated base zero includes the known tilt", () => {
  for (const cantDegrees of [-90, -10, 10, 90]) {
    const options = { ...setup, attachments: [device], cantMode: "specific", cantDegrees, inclinationDegrees: 30 };
    const result = calculate(profile, settings, options);
    close(result.correctedFlight.target.height, 0);
    close(result.correctedFlight.target.lateral, 0);
    const zeroed = calculate(profile, settings, { ...options, zeroModel: "calculated", zeroRange: options.targetRange });
    close(zeroed.target.height, 0);
    close(zeroed.target.lateral, 0);
    close(zeroed.target.elevationMrad, 0, 0.00001);
    close(zeroed.target.windageMrad, 0, 0.00001);
  }
});

test("gravity-free base flight rolls both optical-origin spawn geometry and local device bias", () => {
  for (const inclinationDegrees of [-45, 0, 45]) {
    const options = { ...setup, gravity: 0, attachments: [device], inclinationDegrees };
    const base = calculate(profile, settings, options);
    for (const cantDegrees of [-90, -30, 45, 90]) {
      const rolled = calculate(profile, settings, { ...options, cantMode: "specific", cantDegrees });
      const angle = cantDegrees * Math.PI / 180;
      for (const [i, point] of rolled.points.entries()) {
        const original = base.points[i];
        close(point.range, original.range);
        close(point.lateral, original.lateral * Math.cos(angle) + original.height * Math.sin(angle));
        close(point.height, original.height * Math.cos(angle) - original.lateral * Math.sin(angle));
      }
      close(rolled.target.time, base.target.time, 0.00001);
    }
  }
});

test("uncertainty holds the nominal dial settings fixed and samples the entire inclusive cant interval", () => {
  const base = calculate(profile, settings, setup);
  const options = { ...setup, cantMode: "uncertainty", cantToleranceDegrees: 5 };
  const result = calculate(profile, settings, options);
  assert.deepEqual(result.rows, base.rows);
  assert.deepEqual(result.points, base.points);
  assert.deepEqual(result.correctedFlight, base.correctedFlight);
  const uncertainty = result.cantUncertainty;
  assert.equal(uncertainty.complete, true);
  assert.equal(uncertainty.samples.length, 21);
  assert.equal(uncertainty.samples[0].cantDegrees, -5);
  assert.equal(uncertainty.samples.at(-1).cantDegrees, 5);
  assert.equal(uncertainty.samples[10].cantDegrees, 0);
  assert.equal(uncertainty.samples[10].target, result.correctedFlight.target);
  assert.equal(uncertainty.boreAngle, result.correctedFlight.boreAngle);
  assert.equal(uncertainty.boreYaw, result.correctedFlight.boreYaw);
  assert.ok(uncertainty.target.lateralMin < -0.01 && uncertainty.target.lateralMax > 0.01);
  close(uncertainty.target.lateralMin, -uncertainty.target.lateralMax, 0.00001);
  assert.equal(uncertainty.target.heightMax, Math.max(...uncertainty.samples.map((sample) => sample.target.height)));
  assert.ok(uncertainty.target.heightMax > uncertainty.samples[0].target.height,
    "Sampling only the two endpoints would omit the maximum at zero cant");
  assert.ok(uncertainty.sections.every((section) => section.length === 21));
  const compensated = calculate(profile, settings, { ...setup, cantMode: "specific", cantDegrees: 5 });
  close(compensated.correctedFlight.target.lateral, 0);
  assert.ok(Math.abs(uncertainty.samples.at(-1).target.lateral) > 0.01,
    "Uncertainty probes must not be compensated independently");
});

test("fixed-dial cant error matches the independent discrete-gravity prediction rather than rotating nominal POI", () => {
  const result = calculate(profile, settings, { ...setup, cantMode: "uncertainty", cantToleranceDegrees: 30 });
  // With no drag and a horizontal sight line, rolling leaves forward velocity
  // and arrival time unchanged. Gravity displacement is the sum of the game's
  // pre-movement velocity updates, including the fraction of the final tick.
  const time = result.correctedFlight.target.time, dt = setup.fixedStep;
  const ticks = Math.floor(time / dt), fraction = time / dt - ticks;
  const drop = setup.gravity * dt * dt * (ticks * (ticks + 1) / 2 + fraction * (ticks + 1));
  for (const sample of result.cantUncertainty.samples) {
    const angle = sample.cantDegrees * Math.PI / 180;
    close(sample.target.time, time, 0.00001);
    close(sample.target.lateral, drop * Math.sin(angle), 0.00001);
    close(sample.target.height, drop * (Math.cos(angle) - 1), 0.00001);
  }
});

test("cant uncertainty can cause error at the base zero, grows with tolerance and vanishes without gravity", () => {
  const options = { ...setup, zeroModel: "calculated", zeroRange: setup.targetRange, cantMode: "uncertainty" };
  const narrow = calculate(profile, settings, { ...options, cantToleranceDegrees: 2 });
  const wide = calculate(profile, settings, { ...options, cantToleranceDegrees: 10 });
  close(wide.target.height, 0);
  assert.ok(wide.cantUncertainty.target.lateralMax > narrow.cantUncertainty.target.lateralMax * 4);
  assert.ok(wide.cantUncertainty.target.lateralMin < -0.01);
  const weightless = calculate(profile, settings, { ...options, gravity: 0, cantToleranceDegrees: 20 });
  close(weightless.cantUncertainty.target.lateralMin, 0, 0.00001);
  close(weightless.cantUncertainty.target.lateralMax, 0, 0.00001);
  const zero = calculate(profile, settings, { ...options, cantToleranceDegrees: 0 });
  assert.equal(zero.cantUncertainty.samples.length, 1);
  assert.equal(zero.cantUncertainty.target.lateralMin, zero.correctedFlight.target.lateral);
  assert.equal(zero.cantUncertainty.target.lateralMax, zero.correctedFlight.target.lateral);
});

test("unreachable cant samples do not masquerade as a complete uncertainty band", () => {
  const result = calculate({ ...profile, muzzleVelocity: 100 }, settings, {
    ...setup, zeroModel: "calculated", zeroRange: 150.3, targetRange: 150.3,
    sceneLimit: 150.4, cantMode: "uncertainty", cantToleranceDegrees: 90,
  });
  assert.ok(result.correctedFlight.target);
  assert.equal(result.cantUncertainty.complete, false);
  assert.ok(result.cantUncertainty.unreachableAngles.length > 0);
  assert.equal(result.cantUncertainty.target, null);
  assert.deepEqual(result.cantUncertainty.sections, []);
  assert.ok(result.cantUncertainty.samples.some((sample) => /travelled-range/.test(sample.reason ?? "")));
});

test("cant input validation enforces finite limits and mutual exclusion", () => {
  for (const fields of [
    { cantMode: "both" }, { cantMode: "specific", cantDegrees: NaN }, { cantMode: "specific", cantDegrees: 91 },
    { cantMode: "specific", cantDegrees: -91 }, { cantMode: "uncertainty", cantToleranceDegrees: Infinity },
    { cantMode: "uncertainty", cantToleranceDegrees: -1 }, { cantMode: "uncertainty", cantToleranceDegrees: 91 },
    { cantMode: "specific", cantDegrees: 5, cantToleranceDegrees: 5 },
    { cantMode: "uncertainty", cantDegrees: 5, cantToleranceDegrees: 5 }, { cantMode: "none", cantDegrees: 5 },
  ]) assert.throws(() => calculate(profile, settings, { ...setup, ...fields }), /cant|exclusive/i);
});

test("CSV records the cant assumptions and uncertainty bounds without changing range-card columns", () => {
  const options = { ...setup, cantMode: "uncertainty", cantToleranceDegrees: 5 };
  const result = calculate(profile, settings, options);
  const csv = toCSV(result, profile, options);
  assert.ok(csv.includes('"Weapon cant mode","uncertainty"'));
  assert.ok(csv.includes('"Cant tolerance degrees (+/-)","5"'));
  assert.ok(csv.includes('"Cant uncertainty complete","true"'));
  assert.ok(csv.includes('"Cant uncertainty samples","21"'));
  assert.ok(csv.includes(`"Corrected cant lateral min cm","${result.cantUncertainty.target.lateralMin * 100}"`));
  assert.ok(csv.includes(`"Corrected cant lateral max mrad","${result.cantUncertainty.target.lateralMaxMrad}"`));
  assert.ok(csv.includes("range_m,height_cm,lateral_cm,elevation_mrad,elevation_MOA,windage_mrad,windage_MOA,time_s,velocity_state_m_per_s"));
  const fixed = { ...setup, cantMode: "specific", cantDegrees: -10 };
  assert.ok(toCSV(calculate(profile, settings, fixed), profile, fixed).includes('"Specific weapon cant degrees (positive right)","-10"'));
});
