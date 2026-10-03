import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { calculate } from "../public/physics.js";
import { convexHull, createUncorrectedAimReference, renderTrajectoryChart } from "../public/trajectory-chart.js";
import { profile, settings, setup } from "./helpers/cant.mjs";

function chart(t, options) {
  const solution = calculate(profile, settings, options);
  const dom = new JSDOM('<svg role="img" aria-labelledby="chart-title chart-description"></svg>');
  t.after(() => dom.window.close());
  const svg = dom.window.document.querySelector("svg");
  const layout = renderTrajectoryChart(svg, solution, options, profile);
  return { svg, layout, solution };
}

test("convex uncertainty hull contains interior samples and handles duplicates and degenerate slices", () => {
  const points = [[0, 0], [1, 0], [0, 1], [0.2, 0.2], [1, 0], [0, 0]];
  const before = structuredClone(points);
  assert.deepEqual(convexHull(points), [[0, 0], [1, 0], [0, 1]]);
  assert.deepEqual(points, before);
  assert.deepEqual(convexHull([]), []);
  assert.deepEqual(convexHull([[1, 1], [1, 1]]), [[1, 1]]);
  assert.deepEqual(convexHull([[2, 2], [1, 1], [0, 0]]), [[0, 0], [2, 2]]);
});

test("specific weapon roll transforms the original optic reference into the same corrected sight frame", () => {
  const options = { ...setup, cantMode: "specific", cantDegrees: 30 };
  const solution = calculate(profile, settings, options);
  const rolled = createUncorrectedAimReference(solution, options).direction;
  const local = createUncorrectedAimReference({ ...solution,
    correctedFlight: { ...solution.correctedFlight, cantDegrees: 0 } }, options).direction;
  const angle = Math.PI / 6;
  assert.ok(Math.abs(rolled.lateral - (local.lateral * Math.cos(angle) + local.height * Math.sin(angle))) < 1e-12);
  assert.ok(Math.abs(rolled.height - (local.height * Math.cos(angle) - local.lateral * Math.sin(angle))) < 1e-12);
  assert.equal(rolled.range, local.range);
});

test("uncertainty chart shades the entire sampled flight envelope and shows lateral bounds on the back wall", (t) => {
  const options = { ...setup, cantMode: "uncertainty", cantToleranceDegrees: 5 };
  const { svg, layout, solution } = chart(t, options);
  assert.equal(svg.dataset.cantMode, "uncertainty");
  assert.equal(layout.heightMax, Math.max(0, ...solution.correctedFlight.points.map((point) => point.height),
    ...solution.cantUncertainty.samples.flatMap((sample) => sample.points.map((point) => point.height))));
  assert.ok(layout.aimReference.endpoint.height > layout.heightMax,
    "The original POA must not stretch the height scale beyond any sampled projectile apex");
  assert.ok(svg.querySelectorAll(".cant-envelope-slice").length > 100);
  assert.ok(svg.querySelector(".cant-target-region"));
  const target = svg.querySelector(".cant-target-uncertainty");
  assert.equal(Number(target.dataset.lateralMinCm), solution.cantUncertainty.target.lateralMin * 100);
  assert.equal(Number(target.dataset.lateralMaxCm), solution.cantUncertainty.target.lateralMax * 100);
  assert.ok(Number(target.dataset.lateralMinCm) < 0 && Number(target.dataset.lateralMaxCm) > 0);
  assert.equal(svg.querySelectorAll(".cant-target-width").length, 3);
  const error = layout.errorGuide;
  const expected = Math.abs(error.max * 100).toFixed(2);
  assert.equal(svg.querySelector(".back-error-label").textContent, `ERROR · ±${expected} cm`);
  assert.ok(svg.querySelector(".back-error-label .back-readout-value"), "The uncertainty value must be a prominent chart label");
  const width = svg.querySelector(".back-error-offset");
  assert.equal(Number(width.dataset.errorMinCm), error.min * 100);
  assert.equal(Number(width.dataset.errorMaxCm), error.max * 100);
  for (const [i, end] of error.ends.entries()) {
    assert.equal(end.range, options.targetRange);
    assert.ok(end.height >= layout.heightMin && end.height < solution.cantUncertainty.target.heightMin,
      "The ERROR ruler must stay on the wall below the impact region, separate from DRIFT");
    const [x, y] = layout.project(end);
    assert.equal(Number(width.getAttribute(`x${i + 1}`)), x);
    assert.equal(Number(width.getAttribute(`y${i + 1}`)), y);
  }
  assert.match(svg.querySelector("#chart-description").textContent, /nominal dial settings held fixed/);
  assert.match(svg.querySelector("#chart-description").textContent, /not a probabilistic confidence interval/);
  for (const sample of solution.cantUncertainty.samples) {
    for (const point of sample.points) {
      const [x, y] = layout.project(point);
      assert.ok(x >= 135 && x <= 737 && y >= 47 && y <= 393, "Cant uncertainty must fit in the view");
    }
  }
  const nominal = svg.querySelector(".range-point");
  assert.equal(Number(nominal.dataset.lateralCm), solution.correctedFlight.target.lateral * 100,
    "Uncertainty must not move or replace the corrected nominal endpoint");
});

test("specific cant and incomplete uncertainty never retain an old band on rerender", (t) => {
  const { svg } = chart(t, { ...setup, cantMode: "uncertainty", cantToleranceDegrees: 5 });
  const fixed = { ...setup, cantMode: "specific", cantDegrees: -15 };
  renderTrajectoryChart(svg, calculate(profile, settings, fixed), fixed, profile);
  assert.equal(svg.dataset.cantMode, "specific");
  assert.equal(svg.querySelector(".cant-envelope, .cant-target-uncertainty"), null);
  assert.equal(svg.querySelector(".back-error-label").textContent, "ERROR · —");
  const options = { ...setup, zeroModel: "calculated", zeroRange: 150.3, targetRange: 150.3,
    sceneLimit: 150.4, cantMode: "uncertainty", cantToleranceDegrees: 90 };
  const solution = calculate({ ...profile, muzzleVelocity: 100 }, settings, options);
  assert.equal(solution.cantUncertainty.complete, false);
  renderTrajectoryChart(svg, solution, options, profile);
  assert.equal(svg.querySelector(".cant-envelope, .cant-target-uncertainty"), null);
  assert.equal(svg.querySelector(".back-error-label").textContent, "ERROR · UNBOUNDED");
  assert.match(svg.querySelector("#chart-description").textContent, /no partial uncertainty band/);
  assert.ok(svg.querySelector(".trajectory"));
});

test("zero-width uncertainty keeps all SVG geometry finite", (t) => {
  const { svg } = chart(t, { ...setup, cantMode: "uncertainty", cantToleranceDegrees: 0 });
  for (const element of svg.querySelectorAll("polygon, path, line, circle"))
    assert.doesNotMatch(element.outerHTML, /NaN|Infinity/);
  assert.equal(svg.querySelector(".cant-target-uncertainty").dataset.lateralMinCm,
    svg.querySelector(".cant-target-uncertainty").dataset.lateralMaxCm);
  assert.equal(svg.querySelector(".back-error-label").textContent, "ERROR · ±0.00 cm");
});

test("back-wall measurements and side labels share three distinct colors", async (t) => {
  const { svg } = chart(t, { ...setup, zeroModel: "calculated", zeroRange: setup.targetRange,
    cantMode: "uncertainty", cantToleranceDegrees: 5 });
  const document = svg.ownerDocument;
  const style = document.createElement("style");
  style.textContent = await readFile(new URL("../public/style.css", import.meta.url), "utf8");
  document.head.append(style);
  const computed = (selector) => document.defaultView.getComputedStyle(svg.querySelector(selector));
  const colors = [];
  for (const [line, kind] of [[".back-height-offset", "height"], [".back-lateral-offset", "lateral"], [".back-error-offset", "error"]]) {
    const color = computed(line).color;
    colors.push(color);
    assert.equal(computed(`.back-${kind}-label`).color, color);
    assert.equal(computed(`.back-${kind}-key`).color, color);
    assert.equal(computed(line).stroke, "currentColor");
    assert.equal(computed(`.back-${kind}-label`).fill, "currentColor");
  }
  assert.equal(new Set(colors).size, 3);
  assert.equal(computed(".back-readout-value").fontSize, "15px");
});

test("an asymmetric ERROR label shows each bound relative to actual corrected impact, never a fabricated ± width", (t) => {
  const options = { ...setup, cantMode: "uncertainty", cantToleranceDegrees: 5 };
  const { svg, solution } = chart(t, options);
  // Deliberately asymmetric fixture, with a nonzero nominal solver residual.
  const target = { ...solution.correctedFlight.target, lateral: 0.001 };
  const result = { ...solution, correctedFlight: { ...solution.correctedFlight, target },
    cantUncertainty: { ...solution.cantUncertainty,
      target: { ...solution.cantUncertainty.target, lateralMin: -0.024, lateralMax: 0.061 } } };
  renderTrajectoryChart(svg, result, options, profile);
  assert.equal(svg.querySelector(".back-error-label").textContent, "ERROR · −2.50 / +6.00 cm");
  assert.equal(Number(svg.querySelector(".back-error-offset").dataset.errorMinCm), -2.5);
  assert.equal(Number(svg.querySelector(".back-error-offset").dataset.errorMaxCm), 6);
  assert.match(svg.querySelector(".back-readout title").textContent, /not the total width/);
});

test("long numeric bounds are kept inside the readout gutter without shrinking every label", (t) => {
  const options = { ...setup, cantMode: "uncertainty", cantToleranceDegrees: 5 };
  const { svg, solution } = chart(t, options);
  const result = { ...solution, cantUncertainty: { ...solution.cantUncertainty,
    target: { ...solution.cantUncertainty.target, lateralMin: -1234.56, lateralMax: 9876.54 } } };
  renderTrajectoryChart(svg, result, options, profile);
  const value = svg.querySelector(".back-error-label .back-readout-value");
  assert.equal(value.textContent, "−123456.00 / +987654.00 cm");
  assert.equal(value.getAttribute("lengthAdjust"), "spacingAndGlyphs");
  const width = Number(svg.getAttribute("viewBox").split(" ")[2]);
  assert.ok(Number(value.getAttribute("x")) + Number(value.getAttribute("textLength")) <= width - 16);
  assert.equal(svg.querySelector(".back-height-label .back-readout-value").getAttribute("textLength"), null);
});
