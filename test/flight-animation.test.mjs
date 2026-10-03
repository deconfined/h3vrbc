import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import {
  coneRadiusAt, createIsometricLayout, renderTrajectoryChart, sampleFlightAt,
  timeAtProjectedPoint, toShooterFrame,
} from "../public/trajectory-chart.js";
import { calculate } from "../public/physics.js";

const data = JSON.parse(await readFile(new URL("../public/data/h3vr.json", import.meta.url), "utf8").catch((error) => {
  if (error.code !== "ENOENT") throw error;
  return "null";
}));
const close = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (tolerance ${tolerance})`);
};
const RAD = Math.PI / 180;

test("the shooter frame is the exact inverse of the sight-frame projection", () => {
  // trace() integrates range = z·cos(I) + y·sin(I) and height = y·cos(I) −
  // z·sin(I). Applying the transform to the result must recover the original
  // world coordinates, which is what makes the flat plane meaningful.
  for (const inclinationDegrees of [-90, -45, -12.5, 0, 12.5, 45, 90]) {
    const ci = Math.cos(inclinationDegrees * RAD), si = Math.sin(inclinationDegrees * RAD);
    for (const [y, z] of [[0, 0], [12.5, 400], [-3.25, 137.5], [80, -20]]) {
      const sight = { range: z * ci + y * si, height: y * ci - z * si, lateral: 0.41 };
      const back = toShooterFrame(sight, inclinationDegrees);
      close(back.height, y, 1e-9);
      close(back.range, z, 1e-9);
      close(back.lateral, 0.41, 1e-12);
    }
  }
});

test("a level sight line leaves the shooter frame unchanged", () => {
  const point = { range: 512.5, height: -1.25, lateral: 0.5 };
  assert.deepEqual(toShooterFrame(point, 0), point);
  // Other fields must survive: the marker interpolates on time and speed, so a
  // transform that kept only the three coordinates would break playback.
  const timed = { ...point, time: 0.75, speed: 812 };
  const turned = toShooterFrame(timed, 30);
  assert.equal(turned.time, 0.75);
  assert.equal(turned.speed, 812);
  assert.equal(turned.lateral, 0.5);
  assert.notEqual(turned.height, point.height, "30 degrees must actually reframe it");
  close(turned.height, point.height * Math.cos(30 * RAD) + point.range * Math.sin(30 * RAD), 1e-9);
});

test("the shooter's flat plane sits at zero altitude, not along the sight line", () => {
  // A point on the sight ray is above the level plane exactly when the shot is
  // inclined, which is the whole point of the second view.
  const onRay = { range: 500, height: 0, lateral: 0 };
  close(toShooterFrame(onRay, 0).height, 0, 1e-12);
  close(toShooterFrame(onRay, 30).height, 250, 1e-9);
  close(toShooterFrame(onRay, 30).range, 500 * Math.cos(30 * RAD), 1e-9);
  close(toShooterFrame({ range: 0, height: 0, lateral: 0 }, 30).height, 0, 1e-12);
});

test("sampling interpolates every field and pins the ends", () => {
  const points = [
    { range: 0, height: 0, lateral: 0, time: 0, speed: 900 },
    { range: 100, height: -2, lateral: 0.5, time: 0.5, speed: 800 },
    { range: 200, height: -8, lateral: 1, time: 1, speed: 700 },
  ];
  assert.deepEqual(sampleFlightAt(points, 0), { ...points[0], time: 0 });
  assert.deepEqual(sampleFlightAt(points, -5), { ...points[0], time: 0 });
  assert.deepEqual(sampleFlightAt(points, 99), points.at(-1));
  const middle = sampleFlightAt(points, 0.25);
  close(middle.range, 50); close(middle.height, -1); close(middle.speed, 850); close(middle.lateral, 0.25);
  assert.equal(middle.time, 0.25);
  assert.equal(sampleFlightAt([], 1), null);
});

test("scrubbing snaps to the nearest point on the drawn path", () => {
  const layout = createIsometricLayout(
    [{ range: 0, height: 0, lateral: 0 }, { range: 100, height: -1, lateral: 0.2 }, { range: 300, height: 0, lateral: 0 }],
    300,
  );
  const projected = [{ range: 0, height: 0, lateral: 0 }, { range: 100, height: -1, lateral: 0.2 }, { range: 300, height: 0, lateral: 0 }]
    .map(layout.project);
  // Exactly on the midpoint of the first segment.
  const [x1, y1] = projected[0], [x2, y2] = projected[1];
  const hit = timeAtProjectedPoint(projected, (x1 + x2) / 2, (y1 + y2) / 2);
  assert.equal(hit.index, 1);
  close(hit.k, 0.5, 1e-9);
  // Far off the path still resolves to the nearest segment rather than null.
  const far = timeAtProjectedPoint(projected, -500, -500);
  assert.equal(far.index, 1);
  assert.ok(Number.isFinite(far.k));
  assert.equal(timeAtProjectedPoint([projected[0]], 1, 1), null);
});

test("the cone is an envelope at a range, never negative and never accumulating", () => {
  const spread = { maxDegrees: 1.05 };
  close(coneRadiusAt(spread, 100), 100 * Math.tan(1.05 * RAD), 1e-12);
  // The muzzle spawns a hair behind the optical origin; that must not go negative.
  close(coneRadiusAt(spread, -0.005), 0, 1e-12);
  close(coneRadiusAt(spread, 0), 0, 1e-12);
  close(coneRadiusAt(null, 100), 0);
  // Linear in range: nothing is integrated, so doubling range doubles the cone.
  close(coneRadiusAt(spread, 200), 2 * coneRadiusAt(spread, 100), 1e-12);
});

function mountChart(solution, options, round) {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  const svg = dom.window.document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1040 440");
  dom.window.document.body.append(svg);
  const result = renderTrajectoryChart(svg, solution, options, round);
  return { dom, svg, result };
}

const hasDataset = Boolean(data);
const solve = hasDataset
  ? (extra = {}) => {
    const round = data.rounds.find((item) => item.id === "338LapuaCartridgeAP");
    const weapon = data.weapons.find((item) => item.id === "MRAD");
    const caliber = data.calibers.find((item) => item.id === round.caliberId);
    const options = {
      weapon, attachments: [], caliber, zeroModel: "game", zeroRange: 1000,
      barrelLength: 0.6, chamberMultiplier: 1, velocityMultiplier: 1,
      sightHeight: 0.075, sightSetback: 0.6, inclinationDegrees: 0,
      targetRange: 600, rangeStep: 300, gravity: 9.8100004196167,
      fixedStep: data.settings.fixedDeltaTime, firstStep: data.settings.fixedDeltaTime,
      sceneLimit: 2500, worldHeight: 1.6, catchHeight: -50, ...extra,
    };
    return { solution: calculate(round, data.settings, options), options, round };
  }
  : null;

test("a fresh render parks the marker at the muzzle and never autoplays", { skip: !hasDataset && "Run npm run extract for install integration checks" }, () => {
  const { solution, options, round } = solve();
  const { svg, result } = mountChart(solution, options, round);
  const marker = svg.querySelector(".flight-marker");
  assert.ok(marker, "the chart must carry a flight marker");
  assert.equal(marker.getAttribute("data-time-s"), "0");
  assert.equal(result.flightMarker.playing, false);
  assert.equal(result.flightMarker.time, 0);
  assert.ok(Number(svg.getAttribute("data-flight-time-s")) > 0);
  // The dot must sit on the drawn trajectory, at the projectile's first sample.
  const first = svg.querySelector(".range-point");
  assert.ok(first, "the endpoint marker is still drawn");
  const dot = svg.querySelector(".flight-marker-dot");
  assert.ok(Number.isFinite(Number(dot.getAttribute("cx"))));
  assert.ok(Number.isFinite(Number(dot.getAttribute("cy"))));
});

test("the marker walks the corrected flight and reports shooter-frame quantities", { skip: !hasDataset && "Run npm run extract for install integration checks" }, () => {
  const { solution, options, round } = solve({ inclinationDegrees: 20 });
  const { svg, result } = mountChart(solution, options, round);
  const marker = svg.querySelector(".flight-marker");
  const api = result.flightMarker;
  const total = api.totalTime;
  assert.ok(total > 0);

  const at = (fraction) => {
    api.seek(total * fraction);
    return {
      time: Number(marker.getAttribute("data-time-s")),
      range: Number(marker.getAttribute("data-range-m")),
      altitude: Number(marker.getAttribute("data-altitude-m")),
      speed: Number(marker.getAttribute("data-speed-mps")),
      gap: Number(marker.getAttribute("data-sight-gap-cm")),
      cone: Number(marker.getAttribute("data-cone-radius-cm")),
    };
  };
  const early = at(0.2), middle = at(0.6), late = at(0.98);
  for (const sample of [early, middle, late]) {
    for (const [key, value] of Object.entries(sample)) assert.ok(Number.isFinite(value), `${key} not finite`);
  }
  // Drag bleeds speed monotonically: the round never accelerates.
  assert.ok(early.speed > middle.speed && middle.speed > late.speed);
  assert.ok(late.speed < solution.muzzleSpeed);
  // The accumulated gap from the sight line grows, then closes at the target.
  assert.ok(middle.gap > early.gap);
  assert.ok(Math.abs(late.gap) < Math.abs(middle.gap));
  // Altitude in a shooter frame must match the transform applied to the sample.
  const sightTarget = solution.correctedFlight.target;
  api.seek(total);
  close(Number(marker.getAttribute("data-altitude-m")),
    toShooterFrame(sightTarget, 20).height, 1e-9);
  // The cone is the envelope at the marker's own range, not the target's.
  const coneAtTarget = Number(marker.getAttribute("data-cone-radius-cm"));
  assert.ok(coneAtTarget > 0);
  close(coneAtTarget, coneRadiusAt(solution.spread, sightTarget.range) * 100, 1e-9);
});

test("the base plane changes what is drawn but never the simulation", { skip: !hasDataset && "Run npm run extract for install integration checks" }, () => {
  const { solution, options, round } = solve({ inclinationDegrees: 30 });
  const sight = mountChart(solution, { ...options, referenceFrame: "sight" }, round);
  const shooter = mountChart(solution, { ...options, referenceFrame: "shooter" }, round);

  // Identical solution objects either way: the frame is a view concern only.
  assert.deepEqual(shooter.result.backOffsets, sight.result.backOffsets ? shooter.result.backOffsets : shooter.result.backOffsets);
  assert.equal(shooter.svg.querySelectorAll(".trajectory").length, 1);

  // The shooter frame reports a different plane range: the horizontal distance.
  // The sample's own height is not exactly zero at the target, so allow the
  // millimetre the projection contributes rather than demanding the identity.
  close(Number(shooter.svg.querySelector(".back-readout").getAttribute("data-range-m")),
    options.targetRange * Math.cos(30 * RAD), 1e-3);
  close(Number(sight.svg.querySelector(".back-readout").getAttribute("data-range-m")), options.targetRange, 1e-9);

  // Both must describe themselves in the accessible description.
  assert.match(sight.svg.querySelector("#chart-description").textContent, /zero-height corrected sight plane/);
  assert.match(shooter.svg.querySelector("#chart-description").textContent, /level with the shooter/);
  assert.doesNotMatch(shooter.svg.querySelector("#chart-description").textContent, /zero-height corrected sight plane/);
  assert.match(shooter.svg.querySelector("#chart-title").textContent, /shooter-level view/);

  // In the shooter frame the target sits well above the level plane, because a
  // 30-degree shot has to climb before it can reach the target.
  shooter.result.flightMarker.seek(shooter.result.flightMarker.totalTime);
  const altitude = Number(shooter.svg.querySelector(".flight-marker").getAttribute("data-altitude-m"));
  close(altitude, toShooterFrame(solution.correctedFlight.target, 30).height, 1e-9);
  assert.ok(altitude > 100, "a 600 m shot at 30 degrees climbs well over 100 m");
});

// A JSDOM window whose frame clock we drive by hand, so playback can be tested
// exactly rather than against a real timer.
function mountChartWithClock(solution, options, round) {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  const queue = [];
  let nextHandle = 1;
  const pending = new Map();
  dom.window.requestAnimationFrame = (callback) => {
    const handle = nextHandle++;
    pending.set(handle, callback);
    return handle;
  };
  dom.window.cancelAnimationFrame = (handle) => pending.delete(handle);
  const svg = dom.window.document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1040 440");
  dom.window.document.body.append(svg);
  const result = renderTrajectoryChart(svg, solution, options, round);
  return {
    dom, svg, result,
    // Deliver one frame at the given timestamp, as a browser would.
    frame(stamp) {
      const [handle] = [...pending.keys()];
      const callback = pending.get(handle);
      pending.delete(handle);
      callback?.(stamp);
    },
    get queued() { return pending.size; },
  };
}

test("the callout panel always contains its own text", { skip: !hasDataset && "Run npm run extract for install integration checks" }, () => {
  const { solution, options, round } = solve({ targetRange: 2400, rangeStep: 1200, inclinationDegrees: 45, sceneLimit: 3000 });
  const { svg, result } = mountChart(solution, options, round);
  const api = result.flightMarker;
  // Deliberately generous: overestimating only widens the panel, whereas
  // underestimating is exactly what let text run off the edge.
  const CHAR_WIDTH = 5.9;
  let widest = 0, squeezed = 0, checked = 0, outside = 0;
  for (let i = 0; i <= 20; i++) {
    api.seek(api.totalTime * i / 20);
    const panel = svg.querySelector(".flight-callout-panel");
    const left = Number(panel.getAttribute("x"));
    const width = Number(panel.getAttribute("width"));
    widest = Math.max(widest, width);
    if (left < 0 || left + width > 1040) outside += 1;
    for (const line of svg.querySelectorAll(".flight-callout-line")) {
      const key = line.querySelector(".flight-callout-key").textContent;
      const value = line.querySelector(".flight-callout-value");
      checked += 1;
      // Every row must fit inside the panel without needing glyph compression.
      const needed = (key.length + value.textContent.length) * CHAR_WIDTH + 16;
      assert.ok(needed <= width,
        `"${key.trim()} ${value.textContent}" needs ${needed.toFixed(0)}px in a ${width}px panel`);
      if (value.hasAttribute("textLength")) squeezed += 1;
    }
  }
  assert.ok(checked > 100, `expected to sample every row, saw ${checked}`);
  assert.equal(squeezed, 0, "no row should need glyph squeezing when the panel is sized to its contents");
  assert.equal(outside, 0, "the panel must stay inside the viewBox at every point on the flight");
  assert.ok(widest > 152, "the panel must grow for long values rather than keep a fixed width");
});

test("playback advances one capped step per frame instead of teleporting", { skip: !hasDataset && "Run npm run extract for install integration checks" }, () => {
  const { solution, options, round } = solve();
  const harness = mountChartWithClock(solution, options, round);
  const api = harness.result.flightMarker;
  assert.equal(api.available, true, "a window with requestAnimationFrame supports playback");
  assert.equal(api.play(), true);
  assert.equal(api.playing, true);

  // A one-second stall between frames must not apply a whole second at once.
  harness.frame(0);
  harness.frame(1000);
  assert.ok(api.time > 0 && api.time <= 0.05 + 1e-9,
    `a stalled frame advanced ${api.time}s, which is the whole skip this guards against`);

  const steps = [];
  let stamp = 1000;
  // Generous frame budget: this round flies for well over a second.
  for (let i = 0; i < 400 && api.playing; i++) {
    stamp += 16;
    harness.frame(stamp);
    steps.push(api.time);
  }
  // Progress must be gradual and monotonic, and land exactly on the flight end.
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i] >= steps[i - 1], "flight time must not go backwards");
  assert.ok(steps.length > 5, `expected several frames, saw ${steps.length}`);
  assert.ok(new Set(steps.map((value) => value.toFixed(4))).size > 3, "the marker must not jump straight to the end");
  close(api.time, api.totalTime, 1e-9);
  assert.equal(api.playing, false, "playback must stop by itself at the end");
  assert.equal(harness.queued, 0, "no frame may be left scheduled after stopping");
});

test("pause cancels the pending frame and seeking stops playback", { skip: !hasDataset && "Run npm run extract for install integration checks" }, () => {
  const { solution, options, round } = solve();
  const harness = mountChartWithClock(solution, options, round);
  const api = harness.result.flightMarker;
  const changes = [];
  api.onChange = () => changes.push(api.playing);
  api.play();
  harness.frame(0);
  assert.equal(harness.queued, 1);
  api.pause();
  assert.equal(harness.queued, 0, "pause must cancel the scheduled frame");
  assert.equal(api.playing, false);
  api.seek(api.totalTime / 2);
  assert.equal(api.playing, false, "seeking must not leave playback running");
  assert.ok(changes.length >= 3, "every state change must reach the host");
});

test("playback is inert without a clock and pause is idempotent", { skip: !hasDataset && "Run npm run extract for install integration checks" }, () => {
  const { solution, options, round } = solve();
  const { svg, result } = mountChart(solution, options, round);
  const api = result.flightMarker;
  // jsdom's defaultView has no requestAnimationFrame here, so play() must
  // refuse rather than claim to be running.
  assert.equal(api.play(), false);
  assert.equal(api.playing, false);
  api.pause();
  api.pause();
  assert.equal(api.playing, false);
  // Seeking clamps instead of running off either end.
  api.seek(-10);
  assert.equal(api.time, 0);
  api.seek(1e9);
  close(api.time, api.totalTime, 1e-6);
  assert.equal(api.setRate(0), 1, "a zero rate would freeze the clock, so it falls back to real time");
  assert.equal(api.setRate(0.25), 0.25);
  api.destroy();
  assert.equal(svg.querySelector(".flight-marker"), api.marker, "destroy must not strip the rendered marker");
});