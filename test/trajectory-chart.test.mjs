import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { clipReferenceToHeight, createBackPlaneOffsets, createIsometricLayout, createUncorrectedAimReference, renderTrajectoryChart } from "../public/trajectory-chart.js";
import { mount, waitFor } from "./helpers/app.mjs";
import { dataset, pose, weapon } from "./helpers/optics.mjs";
import { calculate } from "../public/physics.js";

const points = [
  { range: -0.005, height: -0.05, lateral: 0 },
  { range: 100, height: 0.1, lateral: 0.04 },
  { range: 300, height: -1, lateral: 0.15 },
];
const correctedPoints = [points[0], { range: 100, height: 0.15, lateral: -0.005 }, { range: 300, height: 0, lateral: 0 }];
const solution = { points, target: { ...points.at(-1), elevationMrad: 1.23, windageMrad: -0.5 }, settingRange: 100,
  boreAngle: 0.003, boreYaw: 0,
  correctedFlight: { points: correctedPoints, target: correctedPoints.at(-1), boreAngle: 0.00423, boreYaw: -0.0005 } };
const options = { targetRange: 300, zeroRange: 100, zeroModel: "game", inclinationDegrees: 12.5 };

function chart(t, result = solution, settings = options) {
  const dom = new JSDOM('<svg id="chart" role="img" aria-labelledby="chart-title chart-description"></svg>');
  t.after(() => dom.window.close());
  const svg = dom.window.document.getElementById("chart");
  const layout = renderTrajectoryChart(svg, result, settings, { name: "Fixture projectile" });
  return { svg, layout };
}

const close = (actual, expected, tolerance = 1e-10) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test("uncorrected POA uses the original-to-corrected bore rotation, including nonzero base yaw", () => {
  // Independent forward/inverse applications of the integrator's Euler order,
  // rather than repeating the helper's closed-form optic-direction formula.
  const toBore = ([x, y, z], pitch, yaw) => {
    const localX = x * Math.cos(yaw) - z * Math.sin(yaw);
    const localZ = x * Math.sin(yaw) + z * Math.cos(yaw);
    return [localX, y * Math.cos(pitch) - localZ * Math.sin(pitch),
      y * Math.sin(pitch) + localZ * Math.cos(pitch)];
  };
  const fromBore = ([x, y, z], pitch, yaw) => {
    const up = y * Math.cos(pitch) + z * Math.sin(pitch);
    const along = -y * Math.sin(pitch) + z * Math.cos(pitch);
    return [x * Math.cos(yaw) + along * Math.sin(yaw), up,
      -x * Math.sin(yaw) + along * Math.cos(yaw)];
  };
  for (const [basePitch, baseYaw, pitch, yaw] of [
    [0.3, 0.2, 0.3, 0.2], [0.2, 0, 0.25, 0.01],
    [-0.2, 0, -0.25, -0.01], [0.3, -0.2, -0.1, 0.1], [0.1, 0.3, 0.4, -0.2],
  ]) {
    const result = { ...solution, boreAngle: basePitch, boreYaw: baseYaw,
      correctedFlight: { ...solution.correctedFlight, boreAngle: pitch, boreYaw: yaw } };
    const { direction } = createUncorrectedAimReference(result, options);
    const [x, y, z] = fromBore(toBore([0, 0, 1], basePitch, baseYaw), pitch, yaw);
    close(direction.lateral, x);
    close(direction.height, y);
    close(direction.range, z);
    close(Math.hypot(direction.range, direction.height, direction.lateral), 1);
  }
});

test("positive/negative elevation and windage separate original POA from corrected impact with the proper signs", () => {
  for (const [pitch, yaw] of [[0.01, 0], [-0.01, 0], [0, 0.01], [0, -0.01], [0.01, -0.01]]) {
    const result = { ...solution, boreAngle: 0, boreYaw: 0,
      correctedFlight: { ...solution.correctedFlight, boreAngle: pitch, boreYaw: yaw } };
    const reference = createUncorrectedAimReference(result, options);
    close(reference.endpoint.range, options.targetRange);
    close(reference.endpoint.height, options.targetRange * Math.tan(pitch) / Math.cos(yaw));
    close(reference.endpoint.lateral, options.targetRange * Math.tan(yaw));
    assert.ok(Math.hypot(reference.endpoint.height, reference.endpoint.lateral) > 1,
      "A nonzero correction must not leave the original POA on corrected impact");
  }
});

test("the original POA coincides with corrected aim only when the launch orientation is unchanged", () => {
  const result = { ...solution,
    correctedFlight: { ...solution.correctedFlight, boreAngle: solution.boreAngle, boreYaw: solution.boreYaw } };
  const reference = createUncorrectedAimReference(result, options);
  close(reference.endpoint.range, options.targetRange);
  close(reference.endpoint.height, 0);
  close(reference.endpoint.lateral, 0);
  close(reference.zeroPoint.range, result.settingRange);
  close(reference.zeroPoint.height, 0);
  close(reference.zeroPoint.lateral, 0);
});

test("sideways/backward optic references remain finite without inventing a forward ray", () => {
  for (const pitch of [Math.PI / 2, Math.PI]) {
    const result = { ...solution, boreAngle: 0, boreYaw: 0,
      correctedFlight: { ...solution.correctedFlight, boreAngle: pitch, boreYaw: 0 } };
    const reference = createUncorrectedAimReference(result, options);
    assert.ok(reference.endpoint.range < 0.00001);
    for (const point of [reference.endpoint, reference.zeroPoint])
      assert.ok([point.range, point.height, point.lateral].every(Number.isFinite));
  }
  assert.throws(() => createUncorrectedAimReference({ ...solution, boreYaw: NaN }, options), /finite base and corrected/);
});

test("back-wall offsets intersect the ray at the shot range and keep both legs on the wall", () => {
  const reference = { origin: { range: 20, height: 0.03, lateral: 0.001 },
    direction: { range: 1, height: 0.002, lateral: -0.001 } };
  const impact = { range: 100, height: 0.012, lateral: -0.003 };
  const bounds = { heightMin: -0.5, heightMax: 0.5, lateralLimit: 0.2 };
  const before = structuredClone({ reference, impact, bounds });
  const offsets = createBackPlaneOffsets(reference, impact, bounds);
  assert.ok(offsets);
  assert.equal(offsets.poa.range, impact.range);
  close(offsets.poa.height, 0.19);
  close(offsets.poa.lateral, -0.079);
  assert.deepEqual(offsets.corner, { range: impact.range, height: impact.height, lateral: offsets.poa.lateral });
  close(offsets.height, -0.178);
  close(offsets.lateral, 0.076);
  assert.equal(offsets.impact, impact);
  assert.deepEqual({ reference, impact, bounds }, before, "Intersection geometry must not alter the solution");
});

test("back-wall intersections include the boundaries but never clamp off-wall, backward or parallel rays", () => {
  const impact = { range: 100, height: 0, lateral: 0 };
  const bounds = { heightMin: -0.5, heightMax: 0.5, lateralLimit: 0.2 };
  const intersect = (height, lateral, range = 1) => createBackPlaneOffsets({
    origin: { range: 0, height: 0, lateral: 0 }, direction: { range, height, lateral } }, impact, bounds);
  for (const [height, lateral] of [[0.005, 0.002], [0.005, -0.002], [-0.005, 0.002], [-0.005, -0.002]])
    assert.ok(intersect(height, lateral), "An intersection at the wall's edge is still visible");
  for (const [height, lateral] of [[0.00501, 0], [-0.00501, 0], [0, 0.00201], [0, -0.00201]])
    assert.equal(intersect(height, lateral), null, "An off-wall ray must not acquire a clamped fake marker");
  assert.equal(intersect(0, 0, -1), null);
  assert.equal(intersect(0, 1, 0), null);
  assert.equal(intersect(Infinity, 0), null);
  assert.equal(intersect(0, NaN), null);
});

test("isometric axes preserve right/left and up/down signs in the sight-relative frame", () => {
  const { project } = createIsometricLayout(points, 300);
  const [x, y] = project({ range: 100 });
  const forward = project({ range: 200 });
  const right = project({ range: 100, lateral: 0.05 });
  const left = project({ range: 100, lateral: -0.05 });
  const up = project({ range: 100, height: 0.05 });
  const down = project({ range: 100, height: -0.05 });
  assert.ok(forward[0] > x && forward[1] < y);
  assert.ok(right[0] > x && right[1] > y);
  assert.ok(left[0] < x && left[1] < y);
  assert.equal(up[0], x);
  assert.ok(up[1] < y && down[1] > y);
  assert.ok(Math.abs((forward[1] - y) / (forward[0] - x) + 1 / Math.sqrt(3)) < 1e-10);
  assert.ok(Math.abs((right[1] - y) / (right[0] - x) - 1 / Math.sqrt(3)) < 1e-10);
});

test("flat, tiny, left-drifting and large trajectories fit finite viewport bounds without changing samples", () => {
  for (const samples of [
    [{ range: 0, height: 0, lateral: 0 }, { range: 1, height: 0, lateral: 0 }],
    points,
    points.map((point) => ({ ...point, lateral: -point.lateral })),
    [{ range: -2, height: 0.000001, lateral: 0 }, { range: 5000, height: -2000, lateral: 100 }],
    [{ range: 0, height: 10, lateral: -5 }, { range: 200, height: 100, lateral: 30 }],
  ]) {
    const before = structuredClone(samples);
    const targetRange = samples.at(-1).range;
    const layout = createIsometricLayout(samples, targetRange);
    assert.ok(layout.heightMax > layout.heightMin && layout.lateralLimit > 0);
    for (const point of [...samples, ...layout.floor, ...layout.rangePlane]) {
      const [x, y] = layout.project(point);
      assert.ok(Number.isFinite(x) && Number.isFinite(y));
      assert.ok(x >= 135 && x <= 737, `${x} outside horizontal margins`);
      assert.ok(y >= 47 && y <= 393, `${y} outside vertical margins`);
    }
    assert.deepEqual(samples, before);
  }
  for (const [samples, range] of [[[], 300], [points, 0], [points, Infinity], [[{ range: 1, height: NaN, lateral: 0 }], 1]])
    assert.throws(() => createIsometricLayout(samples, range), /finite flight samples/);
});

test("only projectile samples set the height ceiling; even extreme POA heights cannot squash the flight", () => {
  const refs = [{ range: 600, height: 10, lateral: -0.2 }];
  const first = createIsometricLayout(correctedPoints, 600, refs);
  const second = createIsometricLayout(correctedPoints, 600, [{ ...refs[0], height: -1000000 }]);
  const apex = Math.max(...correctedPoints.map((point) => point.height));
  assert.equal(first.heightMax, apex);
  assert.equal(second.heightMax, apex);
  assert.equal(first.heightMin, second.heightMin);
  assert.equal(first.lateralLimit, second.lateralLimit);
  for (const point of correctedPoints) assert.deepEqual(first.project(point), second.project(point));
  assert.ok(first.rangePlane.every((point) => point.height <= apex));
  const flat = createIsometricLayout([{ range: 0, height: 0, lateral: 0 }, { range: 100, height: 0, lateral: 0 }], 100);
  assert.equal(flat.heightMax, 0);
  assert.ok(flat.heightMin < 0, "Flat flight must retain a finite height span");
});

test("height clipping preserves the reference's true direction, including downward, horizontal and zero-span rays", () => {
  const reference = { origin: { range: 0, height: 0, lateral: 0 }, endpoint: { range: 600, height: 2, lateral: -0.2 } };
  const before = structuredClone(reference);
  const up = clipReferenceToHeight(reference, -0.2, 0.25);
  close(up.endpoint.height, 0.25);
  close(up.endpoint.range, 75);
  close(up.endpoint.lateral, -0.025);
  assert.equal(up.clipped, true);
  const down = clipReferenceToHeight({ ...reference, endpoint: { ...reference.endpoint, height: -2 } }, -0.2, 0.25);
  close(down.endpoint.height, -0.2);
  close(down.endpoint.range, 60);
  close(down.endpoint.lateral, -0.02);
  const flat = { origin: reference.origin, endpoint: { ...reference.endpoint, height: 0 } };
  assert.equal(clipReferenceToHeight(flat, -0.2, 0).clipped, false);
  const zero = clipReferenceToHeight(reference, -0.2, 0);
  assert.deepEqual(zero.origin, zero.endpoint);
  assert.equal(clipReferenceToHeight({ origin: { ...reference.origin, height: 1 },
    endpoint: { ...reference.endpoint, height: 1 } }, -0.2, 0.25), null);
  assert.deepEqual(reference, before, "Clipping must never move the actual base-zero reference");
});

test("an off-height POA and farther zero are cropped without inflating the wall or losing actual plane offsets", (t) => {
  const result = { ...solution, settingRange: 600 };
  const { svg, layout } = chart(t, result, { ...options, zeroRange: 600 });
  assert.equal(layout.heightMax, 0.15);
  assert.equal(Number(svg.dataset.heightMaxCm), 15);
  assert.ok(layout.aimReference.zeroPoint.height > layout.heightMax);
  assert.equal(svg.querySelector(".optic-zero-point, .optic-zero-label, .back-poa-point, .back-offsets"), null);
  assert.equal(layout.backOffsets, null);
  assert.ok(layout.planeOffsets);
  assert.equal(svg.querySelector(".back-height-label").textContent,
    `DROP · ${Math.abs(layout.planeOffsets.height * 100).toFixed(2)} cm`);
  close(layout.visibleReference.endpoint.height, layout.heightMax);
  assert.ok(layout.visibleReference.endpoint.range < options.targetRange);
  const ray = svg.querySelector(".sight-line");
  assert.equal(ray.dataset.heightClipped, "true");
  const [x, y] = layout.project(layout.visibleReference.endpoint);
  assert.equal(Number(ray.getAttribute("x2")), x);
  assert.equal(Number(ray.getAttribute("y2")), y);
  assert.match(svg.querySelector("#chart-description").textContent, /height ceiling is the plotted projectile apex/);
  assert.match(svg.querySelector("#chart-description").textContent, /marker is omitted, not moved onto the boundary/);
});

test("off-plot POA arrowheads sit at the clipped endpoint and follow the ray, including a zero-length visible ray", (t) => {
  const onPlot = { ...solution, correctedFlight: { ...solution.correctedFlight,
    boreAngle: solution.boreAngle + 0.0003, boreYaw: solution.boreYaw } };
  const { svg } = chart(t, onPlot);
  assert.equal(svg.querySelector(".sight-line-arrowhead"), null);
  for (const [pitchDelta, yaw, flat] of [[0.002, 0.001, false], [-0.002, -0.001, false], [0.002, 0, true]]) {
    const flightPoints = flat ? correctedPoints.map((point) => ({ ...point, height: 0 })) : correctedPoints;
    const result = { ...solution, correctedFlight: { ...solution.correctedFlight,
      points: flightPoints, target: flightPoints.at(-1),
      boreAngle: solution.boreAngle + pitchDelta, boreYaw: yaw } };
    const layout = renderTrajectoryChart(svg, result, options, { name: "Fixture projectile" });
    assert.equal(layout.visibleReference.clipped, true);
    const arrow = svg.querySelector(".sight-line-arrowhead");
    assert.ok(arrow, "A clipped POA ray must have an arrowhead");
    assert.equal(svg.querySelectorAll(".sight-line-arrowhead").length, 1);
    const transform = arrow.getAttribute("transform").match(/^translate\(([^,]+),([^\)]+)\) rotate\(([^\)]+)\)$/);
    assert.ok(transform, "The arrowhead must be positioned and oriented in screen space");
    const [, x, y, degrees] = transform.map(Number);
    const ray = svg.querySelector(".sight-line");
    close(x, Number(ray.getAttribute("x2")));
    close(y, Number(ray.getAttribute("y2")));
    const [ox, oy] = layout.project(layout.aimReference.origin);
    const [ex, ey] = layout.project(layout.aimReference.endpoint);
    const length = Math.hypot(ex - ox, ey - oy), radians = degrees * Math.PI / 180;
    close(Math.cos(radians), (ex - ox) / length);
    close(Math.sin(radians), (ey - oy) / length);
    if (flat) assert.deepEqual(layout.visibleReference.origin, layout.visibleReference.endpoint);
    assert.match(arrow.querySelector("title").textContent, /continues off the plot/);
    assert.match(svg.querySelector("#chart-description").textContent, /arrowhead at the clipped end/);
  }
  renderTrajectoryChart(svg, onPlot, options, { name: "Fixture projectile" });
  assert.ok(svg.querySelector(".back-poa-point"));
  assert.equal(svg.querySelector(".sight-line-arrowhead"), null, "Rerender must remove an obsolete arrowhead");
});

test("RISE and DROP depend on corrected impact relative to the uncorrected POA, including off-wall intersections", (t) => {
  for (const correction of [-0.002, 0.002]) {
    const result = { ...solution, target: { ...solution.target, height: correction < 0 ? -999 : 999 },
      correctedFlight: { ...solution.correctedFlight, boreAngle: solution.boreAngle + correction } };
    const { svg, layout } = chart(t, result);
    assert.equal(layout.backOffsets, null, "These measurements deliberately lie beyond the finite height view");
    const name = correction < 0 ? "RISE" : "DROP";
    assert.equal(svg.querySelector(".back-height-label").textContent,
      `${name} · ${Math.abs(layout.planeOffsets.height * 100).toFixed(2)} cm`);
    assert.equal(svg.querySelector(".back-height-label").closest(".back-readout-row").classList.contains("back-readout-unavailable"), false);
  }
});

test("SVG shows three axes and a range endpoint without a target-range aim crosshair", (t) => {
  const before = structuredClone(solution);
  const { svg, layout } = chart(t);
  assert.equal(svg.getAttribute("data-view"), "isometric");
  assert.equal(svg.getAttribute("data-flight"), "corrected");
  assert.equal(svg.getAttribute("viewBox"), "0 0 1040 440");
  for (const className of ["chart-plane", "range-plane", "trajectory", "trajectory-shadow", "sight-line", "range-point", "muzzle-point"])
    assert.ok(svg.querySelector(`.${className}`), className);
  for (const label of ["HEIGHT / cm", "RANGE / m", "LATERAL +RIGHT / cm", "300 m", "BASE ZERO · 100 m"])
    assert.ok(svg.textContent.includes(label), label);
  const labels = [...svg.querySelectorAll("text")].map((node) => node.textContent).join(" ");
  assert.doesNotMatch(labels, /TARGET|POA|POI/);
  assert.equal(svg.querySelector(".range-label"), null, "The impact point must not repeat the range label");
  const axisLabels = [...svg.querySelectorAll(".chart-axis")].map((node) => node.textContent);
  for (const range of ["0", "75", "150", "225", "300"])
    assert.ok(axisLabels.includes(range), `Range-axis tick ${range} must remain visible`);
  assert.equal(svg.querySelector(".back-readout-heading").textContent, "300 m / IMPACT PLANE");
  assert.equal(svg.querySelector(".aim-point, .impact-offset, .target-plane"), null);
  const [x, y] = layout.project(solution.correctedFlight.target);
  const target = svg.querySelector(".range-point");
  assert.equal(Number(target.getAttribute("cx")), x);
  assert.equal(Number(target.getAttribute("cy")), y);
  assert.equal(Number(target.dataset.heightCm), 0);
  assert.equal(Number(target.dataset.lateralCm), 0);
  assert.match(target.querySelector("title").textContent, /Corrected trajectory sample/);
  const description = svg.querySelector("#chart-description").textContent;
  assert.match(description, /12\.5° sight line/);
  assert.match(description, /lateral offset is 0\.00 cm/);
  assert.match(description, /independently exaggerated/);
  assert.match(description, /not terrain/);
  assert.match(description, /not an imposed trajectory crossing/);
  assert.match(description, /simulated after applying 1\.230 mrad elevation and -0\.500 mrad windage/);
  assert.match(description, /not a target object/);
  const expectedPath = correctedPoints.map((point, index) => {
    const [x, y] = layout.project(point);
    return `${index ? "L" : "M"}${x.toFixed(3)},${y.toFixed(3)}`;
  }).join(" ");
  assert.equal(svg.querySelector(".trajectory").getAttribute("d"), expectedPath,
    "The chart must use the separately simulated corrected points, never the original flight");
  assert.notEqual(svg.querySelector(".trajectory").getAttribute("d"), svg.querySelector(".trajectory-shadow").getAttribute("d"));
  for (const path of svg.querySelectorAll("path")) assert.doesNotMatch(path.getAttribute("d"), /NaN|Infinity/);
  assert.deepEqual(solution, before, "Rendering must not change the ballistic solution");
});

test("no lateral drift stays on the sight line, and disabled/calculated zero markers keep their meaning", (t) => {
  const flat = [{ range: 0, height: 0, lateral: 0 }, { range: 300, height: 0, lateral: 0 }];
  const { svg, layout } = chart(t, { points: flat, target: { ...flat[1], elevationMrad: 0, windageMrad: 0 }, settingRange: null,
    boreAngle: 0, boreYaw: 0,
    correctedFlight: { points: flat, target: flat[1], boreAngle: 0, boreYaw: 0 } }, { ...options, zeroModel: "unadjusted" });
  assert.equal(svg.querySelector(".optic-zero-point"), null);
  assert.equal(layout.rangeEnd, options.targetRange);
  assert.match(svg.querySelector("#chart-title").textContent, /no base zero adjustment/);
  assert.equal(svg.querySelector(".range-point").dataset.lateralCm, "0");
  assert.equal(svg.querySelector(".trajectory").getAttribute("d"), svg.querySelector(".trajectory-shadow").getAttribute("d"));
  renderTrajectoryChart(svg, { ...solution, settingRange: 100 }, { ...options, zeroModel: "calculated" }, { name: "Fixture projectile" });
  assert.ok(svg.textContent.includes("BASE ZERO · 100 m"));
  assert.match(svg.querySelector(".optic-zero-point title").textContent, /solves a projectile crossing/);
  assert.equal(svg.querySelectorAll("#chart-title").length, 1, "Rerender replaces, rather than accumulates, chart elements");
});

test("a farther base zero stays on the straight POA ray when it fits the projectile height range", (t) => {
  const settings = { ...options, zeroRange: 600 };
  const result = { ...solution, settingRange: 600,
    correctedFlight: { ...solution.correctedFlight, boreAngle: solution.boreAngle + 0.0001 } };
  const before = structuredClone(result);
  const { svg, layout } = chart(t, result, settings);
  const reference = createUncorrectedAimReference(result, settings);
  assert.equal(layout.visibleReference.clipped, false);
  assert.equal(svg.querySelector(".sight-line-arrowhead"), null);
  close(layout.rangeEnd, reference.zeroPoint.range);
  assert.equal(svg.querySelector(".optic-zero-label").textContent, "BASE ZERO · 600 m");
  const zero = svg.querySelector(".optic-zero-point");
  const [zx, zy] = layout.project(reference.zeroPoint);
  assert.equal(Number(zero.getAttribute("cx")), zx);
  assert.equal(Number(zero.getAttribute("cy")), zy);
  assert.equal(zero.dataset.zeroRangeM, "600");
  assert.equal(zero.dataset.elevationMrad, "0");
  assert.equal(zero.dataset.windageMrad, "0");
  close(Number(zero.dataset.heightCm), reference.zeroPoint.height * 100);
  close(Number(zero.dataset.lateralCm), reference.zeroPoint.lateral * 100);
  const ray = svg.querySelector(".sight-line");
  const [ox, oy] = layout.project({ range: 0 });
  assert.equal(ray.tagName, "line");
  assert.equal(Number(ray.getAttribute("x1")), ox);
  assert.equal(Number(ray.getAttribute("y1")), oy);
  assert.equal(Number(ray.getAttribute("x2")), zx);
  assert.equal(Number(ray.getAttribute("y2")), zy);
  assert.match(ray.querySelector("title").textContent, /zero additional elevation and windage dial adjustments/);
  assert.match(zero.querySelector("title").textContent, /not a guaranteed projectile crossing/);
  close(reference.zeroPoint.height / reference.zeroPoint.range, reference.endpoint.height / reference.endpoint.range);
  close(reference.zeroPoint.lateral / reference.zeroPoint.range, reference.endpoint.lateral / reference.endpoint.range);
  const [tx, ty] = layout.project(result.correctedFlight.target);
  assert.equal(Number(svg.querySelector(".range-point").getAttribute("cx")), tx);
  assert.equal(Number(svg.querySelector(".range-point").getAttribute("cy")), ty);
  assert.ok(svg.querySelector(".trajectory").getAttribute("d").endsWith(`L${tx.toFixed(3)},${ty.toFixed(3)}`));
  const [rx, ry] = layout.project({ range: settings.targetRange,
    height: settings.targetRange * reference.direction.height / reference.direction.range,
    lateral: settings.targetRange * reference.direction.lateral / reference.direction.range });
  assert.ok(Math.hypot(rx - tx, ry - ty) > 1,
    "The rendered original POA must separate from corrected POI at the same range");
  for (const point of [reference.endpoint, reference.zeroPoint]) {
    const [x, y] = layout.project(point);
    assert.ok(x >= 135 && x <= 737 && y >= 47 && y <= 393, "The rotated reference must fit the viewport");
  }
  assert.equal(svg.querySelector(".trajectory").getAttribute("d").split(" ").length, result.correctedFlight.points.length,
    "A farther zero reference must not extrapolate the projectile flight");
  assert.deepEqual(result, before);
});

test("optic-zero anchors keep the model's sight-range projection without forcing game-zero crossings", (t) => {
  const round = dataset.rounds[0];
  const settings = { ...options, zeroRange: 600, targetRange: 600, rangeStep: 100,
    barrelLength: 0.4, sightHeight: 0.05, sightSetback: 0.5,
    velocityMultiplier: 1, chamberMultiplier: 1, fixedStep: 0.01, firstStep: 0.01,
    sceneLimit: 1000, gravity: 9.81, worldHeight: 1.6, catchHeight: -50,
    caliber: dataset.calibers[0], attachments: [] };
  const nominal = calculate(round, dataset.settings, settings);
  const { svg, layout } = chart(t, nominal, settings);
  assert.notEqual(nominal.settingRange, settings.zeroRange);
  const reference = createUncorrectedAimReference(nominal, settings);
  assert.equal(layout.aimReference.zeroDistance, nominal.settingRange);
  assert.deepEqual(layout.aimReference.zeroPoint, reference.zeroPoint);
  assert.ok(reference.zeroPoint.height > layout.heightMax);
  assert.equal(svg.querySelector(".optic-zero-point, .optic-zero-label"), null,
    "An off-height base zero must not expand the height scale or be clamped onto its ceiling");
  assert.ok(Math.abs(nominal.target.height) > 0.1, "The authored optic rule must not be replaced by a calculated crossing");
  assert.ok(Math.abs(nominal.target.elevationMrad) > 0.1);
  const calculated = calculate(round, dataset.settings, { ...settings, zeroModel: "calculated" });
  assert.ok(Math.abs(calculated.target.height) < 0.001);
  assert.ok(Math.abs(calculated.target.elevationMrad) < 0.001);
  renderTrajectoryChart(svg, calculated, { ...settings, zeroModel: "calculated" }, round);
  assert.equal(svg.querySelector(".optic-zero-label").textContent, "BASE ZERO · 600 m");
});

test("a corrected chart never silently falls back to an uncorrected-only solution", (t) => {
  assert.throws(() => chart(t, { ...solution, correctedFlight: undefined }), /simulated corrected flight/);
});

test("SVG places POA at the impact-plane intersection and draws independent height and lateral offsets to corrected POI", (t) => {
  const result = { ...solution, correctedFlight: { ...solution.correctedFlight,
    boreAngle: solution.boreAngle + 0.0003 } };
  const before = structuredClone(result);
  const { svg, layout } = chart(t, result);
  const { poa, corner, impact, height, lateral } = layout.backOffsets;
  assert.equal(poa.range, options.targetRange, "The back marker is at shot range, not the base-zero distance");
  const marker = svg.querySelector(".back-poa-point");
  const [px, py] = layout.project(poa);
  assert.equal(Number(marker.getAttribute("cx")), px);
  assert.equal(Number(marker.getAttribute("cy")), py);
  assert.equal(Number(marker.dataset.rangeM), options.targetRange);
  close(Number(marker.dataset.heightCm), poa.height * 100);
  close(Number(marker.dataset.lateralCm), poa.lateral * 100);
  assert.match(marker.querySelector("title").textContent, /Uncorrected POA on the impact plane/);
  const heightGuide = svg.querySelector(".back-height-offset");
  const lateralGuide = svg.querySelector(".back-lateral-offset");
  const [cx, cy] = layout.project(corner), [ix, iy] = layout.project(impact);
  for (const [guide, a, b, value] of [
    [heightGuide, [px, py], [cx, cy], height], [lateralGuide, [cx, cy], [ix, iy], lateral],
  ]) {
    assert.equal(Number(guide.getAttribute("x1")), a[0]);
    assert.equal(Number(guide.getAttribute("y1")), a[1]);
    assert.equal(Number(guide.getAttribute("x2")), b[0]);
    assert.equal(Number(guide.getAttribute("y2")), b[1]);
    close(Number(guide.dataset.offsetCm), value * 100);
  }
  assert.equal(heightGuide.getAttribute("x1"), heightGuide.getAttribute("x2"), "Height must be a vertical segment");
  close((iy - cy) / (ix - cx), 1 / Math.sqrt(3));
  assert.equal(svg.querySelector(".back-height-label").textContent, `DROP · ${Math.abs(height * 100).toFixed(2)} cm`);
  assert.equal(svg.querySelector(".back-lateral-label").textContent, `DRIFT · ${Math.abs(lateral * 100).toFixed(2)} cm`);
  assert.match(svg.querySelector("#chart-description").textContent, /geometric offsets, not dial settings/);
  assert.deepEqual(result, before);
});

test("off-wall intersections remove the marker and both offset guides, including on rerender", (t) => {
  const { svg } = chart(t, { ...solution, correctedFlight: { ...solution.correctedFlight,
    boreAngle: solution.boreAngle, boreYaw: solution.boreYaw } });
  assert.ok(svg.querySelector(".back-poa-point"));
  for (const pitch of [0.01, Math.PI]) {
    const result = { ...solution, boreAngle: 0, boreYaw: 0,
      correctedFlight: { ...solution.correctedFlight, boreAngle: pitch, boreYaw: 0 } };
    const layout = renderTrajectoryChart(svg, result, options, { name: "Fixture projectile" });
    assert.equal(layout.backOffsets, null);
    assert.equal(svg.querySelector(".back-poa-point, .back-offsets"), null);
    assert.equal(svg.querySelector(".back-height-label").textContent, layout.planeOffsets
      ? `DROP · ${Math.abs(layout.planeOffsets.height * 100).toFixed(2)} cm` : "RISE/DROP · —");
    assert.equal(svg.querySelector(".back-lateral-label").textContent, layout.planeOffsets ? "DRIFT · 0.00 cm" : "DRIFT · —");
    assert.match(svg.querySelector("#chart-description").textContent, /no plane marker or offset guides/);
    assert.ok(svg.querySelector(".range-point"), "Corrected impact remains visible");
  }
});

test("wall measurements use a separate aligned gutter even for downward offsets and a zero beyond the shot range", (t) => {
  for (const correction of [-0.0044, 0]) {
    const target = { ...solution.correctedFlight.target, height: correction === 0 ? 0.00001 : 0 };
    const result = { ...solution, settingRange: 600,
      correctedFlight: { ...solution.correctedFlight,
        points: [...correctedPoints.slice(0, -1), target], target,
        boreAngle: solution.boreAngle + correction, boreYaw: solution.boreYaw } };
    const { svg, layout } = chart(t, result, { ...options, zeroRange: 600 });
    const heightY = Number(svg.querySelector(".back-height-label").getAttribute("y"));
    const lateralY = Number(svg.querySelector(".back-lateral-label").getAttribute("y"));
    assert.equal(lateralY - heightY, 32, "Measurement labels use fixed, readable row spacing");
    assert.ok(heightY > 0 && heightY < 430 && lateralY > 0 && lateralY < 430);
    const wallRight = Math.max(...layout.rangePlane.map((point) => layout.project({ ...point, range: options.targetRange })[0]));
    for (const label of svg.querySelectorAll(".back-readout-label")) {
      assert.ok(Number(label.getAttribute("x")) > wallRight + 20, "Labels must be beside, not on, the back wall");
      assert.ok(Number(label.getAttribute("x")) >= 760, "Even a reference extending beyond the wall cannot overlap the readout");
    }
    assert.equal(svg.querySelectorAll(".back-readout-row").length, 5);
    assert.equal(svg.querySelector(".back-error-label").textContent, "ERROR · —");
    assert.equal(svg.querySelector(".back-readout-heading").textContent, "300 m / IMPACT PLANE");
  }
});

test("coincident original aim and corrected impact have zero-length, finite wall offsets", (t) => {
  const result = { ...solution, target: { ...solution.target, elevationMrad: 0, windageMrad: 0 },
    correctedFlight: { ...solution.correctedFlight, boreAngle: solution.boreAngle, boreYaw: solution.boreYaw } };
  const { svg, layout } = chart(t, result);
  close(layout.backOffsets.height, 0);
  close(layout.backOffsets.lateral, 0);
  for (const guide of svg.querySelectorAll(".back-offset")) {
    assert.equal(guide.getAttribute("x1"), guide.getAttribute("x2"));
    assert.equal(guide.getAttribute("y1"), guide.getAttribute("y2"));
    assert.equal(Number(guide.dataset.offsetCm), 0);
  }
  assert.ok(svg.querySelector(".back-poa-point"));
  assert.equal(svg.querySelector(".back-height-label").textContent, "RISE · 0.00 cm");
  assert.equal(svg.querySelector(".back-lateral-label").textContent, "DRIFT · 0.00 cm");
});

test("the isometric chart applies both corrections while the range card retains actual base device drift", async (t) => {
  const rifle = { ...weapon, hashId: "M4Carbine", accuracyClass: 33,
    muzzleMounts: [{ front: [0, 0, 0.4], rear: [0, 0, 0.4], pose: pose(), parentPose: pose(), parentToThis: false, scaleModifier: 1 }] };
  const suppressor = { id: "SuppressorMk12", hashId: "SuppressorMk12", name: "Test suppressor", kind: "suppressor", componentClass: "Suppressor",
    accuracyClass: 100, rootPose: pose(), muzzleOffset: [0, 0, 0.18], muzzleForward: [0, 0, 1], muzzleUp: [0, 1, 0],
    canScaleToMount: true, bidirectional: false, muzzleMounts: [], source: { bundle: "fixture", assetName: "suppressor", pathId: "1" } };
  const data = { ...dataset, weapons: [rifle], muzzleDevices: [suppressor], settings: { ...dataset.settings,
    accuracyClasses: [{ id: 33, name: "Modern rifle", dropMult: 0.9, driftMult: 2 }, { id: 100, name: "Precision suppressor", dropMult: 1.1, driftMult: 2 }] } };
  const { dom, close } = await mount(data, "isometric-chart");
  t.after(close);
  const $ = (id) => dom.window.document.getElementById(id);
  await waitFor(() => !$("solution").hidden || !$("load-error").hidden);
  assert.equal($("load-error").hidden, true, $("load-error").textContent);
  const set = (id, value) => {
    $(id).value = value;
    $(id).dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const recalculate = async () => {
    $("setup-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => !$("setup-form").querySelector('button[type="submit"]').disabled);
    assert.equal($("solution").hidden, false, $("calculation-error").textContent);
  };
  assert.equal($("trajectory-chart").dataset.view, "isometric");
  assert.equal(Number($("trajectory-chart").querySelector(".range-point").dataset.lateralCm), 0);
  assert.equal($("trajectory-chart").dataset.flight, "corrected");
  assert.match(dom.window.document.querySelector(".chart-heading h2").textContent, /^Corrected trajectory/);
  assert.match(dom.window.document.querySelector(".chart-note").textContent, /simulated after applying/);
  assert.match(dom.window.document.querySelector(".legend").textContent, /Uncorrected POA/);
  set("weapon", "Rifle");
  set("muzzle-device", suppressor.id);
  $("add-muzzle-device").click();
  await recalculate();
  const target = $("trajectory-chart").querySelector(".range-point");
  assert.ok(Math.abs(Number(target.dataset.lateralCm)) < 0.01, "Corrected windage must bring impact onto aim");
  assert.ok(Math.abs(Number(target.dataset.heightCm)) < 0.01, "Corrected elevation must bring impact onto aim");
  assert.ok(Number($("range-rows").querySelector(".target-row").children[2].textContent) > 0,
    "The range card must still report the uncorrected rightward offset");
  assert.ok(Number($("windage-value").textContent) > 0, "Scope setting is the inverse of the leftward aim correction");
  const ray = $("trajectory-chart").querySelector(".sight-line");
  assert.ok(Number(ray.dataset.directionLateral) < 0,
    "Leftward aim correction still puts the original optic ray left of corrected aim");
  const dx = Number(ray.getAttribute("x2")) - Number(ray.getAttribute("x1"));
  const dy = Number(ray.getAttribute("y2")) - Number(ray.getAttribute("y1"));
  const tx = Number(target.getAttribute("cx")) - Number(ray.getAttribute("x1"));
  const ty = Number(target.getAttribute("cy")) - Number(ray.getAttribute("y1"));
  assert.ok(Math.abs(dx * ty - dy * tx) / Math.hypot(dx, dy) > 1,
    "The screen-space uncorrected ray must no longer run through corrected impact");
  set("firing-angle", "45");
  assert.equal($("solution").hidden, true);
  await recalculate();
  assert.match($("chart-description").textContent, /45\.0° sight line/);
  assert.match($("chart-description").textContent, /not terrain/);
  assert.equal($("export-csv").disabled, false);
  set("zero-range", "600");
  await recalculate();
  assert.equal($("zero-range").value, "600", "Plotting corrected flight must not replace the user's base optic setting");
  const zero = $("trajectory-chart").querySelector(".optic-zero-point");
  if (zero) {
    assert.equal(zero.dataset.zeroRangeM, "600");
    assert.equal($("trajectory-chart").querySelector(".optic-zero-label").textContent, "BASE ZERO · 600 m");
  } else {
    assert.match($("chart-description").textContent, /base-zero point is outside the flight-height view/);
  }
  const correctedEndpoint = $("trajectory-chart").querySelector(".range-point");
  assert.ok(Math.abs(Number(correctedEndpoint.dataset.heightCm)) < 0.05);
  assert.ok(Math.abs(Number(correctedEndpoint.dataset.lateralCm)) < 0.05);
  assert.ok($("trajectory-chart").querySelector(".sight-line"), "The in-height part of the uncorrected ray remains visible");
});

test("the wall readout never enters the lower-right quadrant reserved for the flight controls", () => {
  // The controls are an HTML overlay anchored to the container's bottom-right
  // corner, because the SVG scales to its panel and that space cannot be
  // addressed in SVG units. The readout is the only thing that could reach it,
  // so its first row has to stay in the top of the gutter in every layout.
  for (const points of [correctedPoints, [...correctedPoints, { range: 400, height: -18, lateral: 0.2 }]]) {
    const layout = createIsometricLayout(points, 300);
    const wallCenterY = layout.project({ range: 300, height: (layout.heightMin + layout.heightMax) / 2, lateral: 0 })[1];
    const firstRowY = Math.max(84, Math.min(440 * 0.4, wallCenterY - 32));
    // Four rows at 32px spacing: the last must clear the overlay's top edge.
    assert.ok(firstRowY + 3 * 32 + 8 < 284,
      `the last readout row sits at ${firstRowY + 3 * 32}, inside the reserved quadrant`);
    assert.ok(firstRowY >= 84 && firstRowY + 3 * 32 < 440, "the readout must stay inside the viewBox");
  }
});
