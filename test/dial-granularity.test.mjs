import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import * as formatModule from "../public/format.js";
import { calculate, clickDegrees, dialBand } from "../public/physics.js";
import { impactRegion, impactRegionPoints, renderTrajectoryChart } from "../public/trajectory-chart.js";

const data = JSON.parse(await readFile(new URL("../public/data/h3vr.json", import.meta.url), "utf8"));
const close = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (tolerance ${tolerance})`);
};
const hasDataset = Boolean(data);
// A real optic with both axes serialized, standing in for the selected preset.
const sampleOptic = hasDataset
  ? data.optics.find((item) => item.adjustmentTicks?.elevation && item.adjustmentTicks?.windage) ?? null
  : null;
const optionsFor = (round, weapon, caliber) => ({
  weapon, attachments: [], caliber, zeroModel: "game", zeroRange: 1000,
  barrelLength: 0.6, chamberMultiplier: 1, velocityMultiplier: 1,
  sightHeight: 0.075, sightSetback: 0.6, inclinationDegrees: 0,
  targetRange: 600, rangeStep: 300, gravity: 9.8100004196167,
  fixedStep: data.settings.fixedDeltaTime, firstStep: data.settings.fixedDeltaTime,
  sceneLimit: 2500, worldHeight: 1.6, catchHeight: -50,
  // As the app supplies it: the selected optic's own tick sizes.
  adjustmentTicks: sampleOptic?.adjustmentTicks ?? null,
});
const solve = hasDataset
  ? (extra = {}) => {
    const round = data.rounds.find((item) => item.id === "338LapuaCartridgeAP");
    const weapon = data.weapons.find((item) => item.id === "MRAD");
    const caliber = data.calibers.find((item) => item.id === round.caliberId);
    const options = { ...optionsFor(round, weapon, caliber), ...extra };
    return { solution: calculate(round, data.settings, options), options, round };
  }
  : null;

// A device whose mechanical accuracy class is the widest in the dataset, so the
// dispersion comparison is made against a meaningful case.
const widestDevice = hasDataset
  ? data.muzzleDevices
    .filter((item) => item.hashId && Number.isInteger(item.accuracyClass))
    .map((item) => ({ item, spread: data.settings.accuracyClasses.find((entry) => entry.id === item.accuracyClass) }))
    .filter((pair) => pair.spread)
    .sort((a, b) => b.spread.maxDegrees - a.spread.maxDegrees)[0]?.item ?? null
  : null;
// Any device that produces a lateral bias, so a missing windage adjustment has
// something to be unable to correct.
const driftingDevice = hasDataset
  ? data.muzzleDevices.find((item) => item.hashId && item.accuracyClass && item.driftMult !== 1) ?? widestDevice
  : null;


test("the click size is a per-optic property, not a single constant", { skip: !hasDataset && "Run npm run extract for install integration checks" }, () => {
  // One turn of the tuning component moves one authored tick. The tick is scaled
  // by ZeroScaling in PIPScopeController.UpdateScopeParams before being stored in
  // scopeAdjustmentDegrees, so the extractor resolves it to degrees per optic.
  const clicks = [];
  for (const optic of data.optics) {
    for (const axis of ["elevation", "windage"]) {
      const degrees = clickDegrees(optic.adjustmentTicks, axis);
      if (degrees != null) clicks.push({ optic: optic.name, axis, degrees, ...optic.adjustmentTicks[axis] });
    }
  }
  assert.ok(clicks.length > 100, `expected a per-optic value on most optics, saw ${clicks.length}`);
  // Across the shipped set this spans a wide range, so any single hardcoded click
  // would be wrong for most of them.
  const mrad = clicks.map((entry) => entry.degrees * (Math.PI / 180) * 1000);
  const min = Math.min(...mrad), max = Math.max(...mrad);
  assert.ok(min < 0.1, `the finest optic should resolve below 0.1 mrad, saw ${min.toFixed(4)}`);
  assert.ok(max > 4, `the coarsest optic should be several mrad, saw ${max.toFixed(2)}`);
  assert.ok(max / min > 30, "click sizes must vary by more than an order of magnitude");
  // The MOA-authored optics are the clean check on the scaling factors.
  const moa = clicks.find((entry) => entry.unit === "MOA" && entry.degrees < 0.01);
  assert.ok(moa, "expected a MOA-authored optic");
  close(moa.degrees * 60, moa.perTick, 1e-6);
  const mradUnit = clicks.find((entry) => entry.unit === "mrad" && entry.degrees < 0.01);
  assert.ok(mradUnit, "expected an mrad-authored optic");
  close(mradUnit.degrees * (Math.PI / 180) * 1000, mradUnit.perTick, 1e-6);
  // An optic that does not serialize one must yield null, never a default.
  assert.equal(clickDegrees(null, "elevation"), null);
  assert.equal(clickDegrees({}, "elevation"), null);
  assert.equal(clickDegrees({ elevation: { degrees: 0 } }, "elevation"), null);
});

test("dialBand refuses to guess when no click size is known", () => {
  assert.equal(dialBand(0.1, 600, null), null);
  assert.equal(dialBand(0.1, 600, 0), null);
  const band = dialBand(0.1, 600, 0.008);
  assert.ok(band, "a supplied click size must be used");
  close(band.stepMoa, 0.008 * 60, 1e-9);
});

test("a dial band is one-sided and always exactly one click wide", () => {
  // Solved adjustment far from a click.
  const band = dialBand(0.1, 600, 0.01);
  // The source constant is the float32 image of 1/240 degree, so the click is
  // 0.2500005 MOA rather than a clean 0.25. Kept faithful; reported to 2 dp.
  close(band.stepMoa, 0.6, 1e-9);
  close(band.upperClickMoa - band.lowerClickMoa, band.stepMoa, 1e-9);
  // Both reachable clicks bracket the solved value.
  assert.ok(band.lowerClickMoa <= band.solvedMoa && band.solvedMoa <= band.upperClickMoa);
  // Residuals: nearer click at most half a click, farther up to a full one.
  assert.ok(band.best <= 0.3 + 1e-9, `best residual ${band.best} exceeds half a click`);
  assert.ok(band.worst <= 0.6 + 1e-9);
  assert.ok(band.worst > band.best);
  // Whether the band straddles the aim point depends on where the solved value
  // falls in the click interval, not on the click size: past half a click, the
  // nearer residual already exceeds half, so either click lands on the other
  // side of the corrected impact.
  // The two residuals are delta and delta - one click, so unless the solved
  // value lands exactly on a click they have opposite signs: the two reachable
  // impacts always straddle the aim point. That is why the nearest click is the
  // one to dial, and why the band is one-sided rather than a symmetric tolerance.
  const straddling = dialBand(0.01 * 24.3, 600, 0.01);
  assert.ok(straddling.best > 0);
  assert.ok(Math.sign(straddling.lower) !== Math.sign(straddling.upper),
    "two reachable clicks must bracket the aim point whenever the solved value is off-grid");
  assert.ok(Math.abs(straddling.best / straddling.stepMoa - 0.3) < 1e-6);
  assert.ok(Math.abs(straddling.worst / straddling.stepMoa - 0.7) < 1e-6);
  // Landing exactly on a click leaves nothing. Expressed in the grid's own units:
  // a clean 0.25 MOA is not exactly the 60th click of this float32 constant.
  const exact = dialBand(0.01 * 60, 600, 0.01);
  close(exact.best, 0, 1e-12);
  // A negative adjustment mirrors symmetrically.
  const negative = dialBand(-0.1, 600, 0.01);
  close(negative.best, band.best, 1e-12);
  close(negative.worst, band.worst, 1e-12);
});

test("dial residuals convert to impact offsets linear in range", () => {
  const near = dialBand(0.1, 300, 0.01);
  const far = dialBand(0.1, 1200, 0.01);
  close(far.lower, 4 * near.lower, 1e-12);
  close(far.upper, 4 * near.upper, 1e-12);
  // Exactly the 60th click, expressed in the grid's own units so the residual is
  // genuinely zero rather than a clean 0.25 MOA rounded onto a float grid.
  const onAClick = dialBand(0.01 * 60, 600, 0.01);
  close(onAClick.best, 0, 1e-12);
  close(onAClick.lower, 0, 1e-12);
  assert.ok(Math.sign(onAClick.upper) !== Math.sign(onAClick.lower));
  close(near.upper - near.lower, 300 * Math.tan(0.01 * Math.PI / 180), 1e-7);
});

test("dispersion and granularity are independent, and either can dominate", { skip: !hasDataset && "Run npm run extract for install integration checks" }, () => {
  // The obvious question about combining the two. Each is an angle projected
  // onto range: dispersion is a random draw made once at launch, granularity is
  // a choice between two reachable clicks. Neither is derived from the other, so
  // the reported region is simply both of them together. Which one dominates is a
  // property of the setup, not of distance: both grow linearly with range, and
  // the solved correction they are measured against changes far more slowly.
  const clickSize = (solution) => Math.max(
    ...[solution.dial.elevation.lower, solution.dial.elevation.upper].map(Math.abs)) * 100;
  const bare = solve({ attachments: [], targetRange: 600 }).solution;
  const click = clickSize(bare);
  const clickMrad = clickDegrees(sampleOptic.adjustmentTicks, "elevation") * (Math.PI / 180) * 1000;
  // Stated against the optic actually selected rather than a guessed figure.
  assert.ok(click > 0, "the selected optic must supply a click size");
  assert.ok(clickMrad > 0.05 && clickMrad < 5, `resolved click ${clickMrad.toFixed(3)} mrad is implausible`);
  console.log(`      (selected optic click: ${clickMrad.toFixed(3)} mrad = ${click.toFixed(2)} cm at 600 m)`);
  const bareRatio = bare.targetSpread.boundDiameter * 100 / click;
  // Same order of magnitude for a bare precision rifle: neither can be ignored.
  assert.ok(bareRatio > 1 && bareRatio < 8,
    `bare dispersion is ${bareRatio.toFixed(1)}x a click, so both matter`);
  // A device's mechanical spread pushes it an order of magnitude clear.
  const fitted = solve({ attachments: [widestDevice], targetRange: 600 }).solution;
  const fittedRatio = fitted.targetSpread.boundDiameter * 100 / clickSize(fitted);
  assert.ok(fittedRatio > bareRatio * 3,
    `with a device fitted dispersion is ${fittedRatio.toFixed(1)}x a click`);
});

test("an optic without windage leaves the whole lateral correction undialled", { skip: !hasDataset && "Run npm run extract for install integration checks" }, () => {
  // Needs a lateral bias to be unable to correct, so fit a drifting device.
  const { options, round } = solve({ attachments: [driftingDevice] });
  const withWindage = calculate(round, data.settings, options);
  assert.equal(withWindage.dial.windageAdjustable, true);
  assert.ok(withWindage.dial.windage, "an adjustable optic gets a windage granularity band");
  assert.equal(withWindage.dial.windageUnavailable, undefined);

  const without = calculate(round, data.settings, { ...options, windageAdjustable: false });
  assert.ok(Math.abs(without.target.lateral) > 0.01, "fixture must actually drift sideways");
  assert.equal(without.dial.windageAdjustable, false);
  assert.equal(without.dial.windage, null);
  // The error is the base shot's own lateral offset, not a click-sized residual.
  close(without.dial.windageUnavailable.lateral, without.target.lateral, 1e-12);
  // Still several times a click, but not orders of magnitude: this optic's tick is
  // coarse (a fraction of a milliradian), so the undialled correction is only a
  // few times the click size rather than dwarfing it.
  const forced = Math.abs(without.dial.windageUnavailable.lateral) * 100;
  const click = Math.max(Math.abs(without.dial.elevation.lower), Math.abs(without.dial.elevation.upper)) * 100;
  assert.ok(forced > click * 2,
    `no-windage error ${forced.toFixed(1)} cm against a ${click.toFixed(2)} cm click`);
  // Elevation is unaffected: it is always a choice between two clicks.
  close(without.dial.elevation.best, withWindage.dial.elevation.best, 1e-12);
});

test("the achievable region is the click rectangle widened by the dispersion disc", () => {
  const band = { elevation: { lower: -0.02, upper: 0.03 }, windage: { lower: -0.01, upper: 0.01 } };
  const region = impactRegion(0.05, band);
  assert.equal(region.radius, 0.05);
  assert.equal(region.heightMin, -0.02);
  assert.equal(region.heightMax, 0.03);
  assert.equal(region.lateralMin, -0.01);
  assert.equal(region.lateralMax, 0.01);
  assert.equal(region.hasDialBand, true);

  // Every boundary point is the rectangle corner arcs plus straight edges, so
  // each must sit one radius outside the rectangle in exactly one axis.
  // Every sampled point lies on a corner arc, so it is exactly one radius
  // outside the rectangle corner in both axes at once.
  for (const point of impactRegionPoints(region, 6)) {
    const outHeight = point.height > region.heightMax ? point.height - region.heightMax
      : point.height < region.heightMin ? region.heightMin - point.height : 0;
    const outLateral = point.lateral > region.lateralMax ? point.lateral - region.lateralMax
      : point.lateral < region.lateralMin ? region.lateralMin - point.lateral : 0;
    close(Math.hypot(outHeight, outLateral), region.radius, 1e-9);
  }
  // A cone with no dial band collapses to a circle.
  const plain = impactRegion(0.05, {});
  assert.equal(plain.heightMin, 0);
  assert.equal(plain.heightMax, 0);
  assert.equal(plain.hasDialBand, false);
  // Malformed input must not put NaN into the geometry.
  const broken = impactRegion(undefined, { elevation: { lower: NaN, upper: NaN } });
  for (const value of [broken.radius, broken.heightMin, broken.heightMax, broken.lateralMin, broken.lateralMax])
    assert.ok(Number.isFinite(value));
});

test("the serialized tick resolves to the right number of milliradians", () => {
  const { MRAD_PER_DEG, clickMradFromDegrees } = formatModule;
  // Radians per degree is (pi/180); multiplying by (180/pi) instead is milliradians
  // per radian and inflates every click by 1000x, which silently rounds every
  // realistic correction to zero clicks.
  close(MRAD_PER_DEG, 17.4532925, 1e-6);
  close(clickMradFromDegrees(0.5 / 60), 0.1454441, 1e-6);
  // An mrad-authored 0.1 click: the serialized value is that many milliradians in degrees.
  close(clickMradFromDegrees(0.1 / MRAD_PER_DEG), 0.1, 1e-6);
  close(clickMradFromDegrees(0.2765), 4.8258, 1e-3);
  // Unknown must stay distinguishable from zero.
  assert.equal(clickMradFromDegrees(null), null);
  assert.equal(clickMradFromDegrees(undefined), null);
  assert.equal(clickMradFromDegrees(0), null);
  assert.equal(clickMradFromDegrees(-1), null);

  // Every click the game actually ships, resolved and round-tripped.
  for (const optic of data.optics) {
    for (const axis of ["elevation", "windage"]) {
      const entry = optic.adjustmentTicks?.[axis];
      const mrad = clickMradFromDegrees(entry?.degrees);
      if (mrad == null) continue;
      assert.ok(mrad > 0.05 && mrad < 5, `${optic.name} ${axis} resolved to ${mrad} mrad`);
      // A correction in the ordinary range must reach at least one click on any
      // optic fine enough to express it. The coarsest optics legitimately cannot:
      // a 4.8 mrad-per-click optic has no setting at all for a 2 mrad correction,
      // and saying "no adjustment" there is the honest answer, not a rounding bug.
      if (mrad <= 2) assert.ok(Math.round(2 / mrad) >= 1,
        `${optic.name} ${axis}: a 2 mrad correction would round to ${Math.round(2 / mrad)} clicks`);
      else assert.equal(Math.round(2 / mrad), 0,
        `${optic.name} ${axis} is too coarse for a 2 mrad correction`);
    }
  }
});

test("a displayed adjustment is a whole number of clicks, in both units", () => {
  const { MOA_PER_MRAD, digitsFor, formatDialedSetting } = formatModule;
  // 1 MOA is 1/60 degree; the mrad conversion is the one the range card uses.
  close(MOA_PER_MRAD, 3.4377468, 1e-6);
  // The click sizes actually present in the game.
  for (const click of [0.0727, 0.1, 0.1454, 0.2, 0.25, 0.2909, 0.5, 1.0, 4.83]) {
    // A solved value part-way between clicks snaps to a whole number of them.
    // The callout is the negated correction, so a negative correction is the one
    // that raises the optic and reads as a positive click count.
    const shown = formatDialedSetting(-click * 7.4, click);
    assert.equal(shown.snapped, true);
    close(shown.clicks, 7, 1e-9);
    assert.match(shown.suffix, /^7 clicks · /);
    // Printed at a precision the click can actually be dialled to.
    const digits = shown.mrad.split(".")[1]?.length ?? 0;
    assert.ok(digits >= 1 && digits <= 3, `click ${click} printed at ${digits} decimals`);
    close(Number(shown.mrad), 7 * click, Math.pow(10, -digits) * 0.6);
    // The MOA line is the same number in the other unit, not a rescaling.
    const moaDigits = shown.moa.split(".")[1]?.length ?? 0;
    close(Number(shown.moa), 7 * click * MOA_PER_MRAD, Math.pow(10, -moaDigits) * 0.6);
  }
  // Digits track the click: coarse optics print fewer places.
  assert.ok(digitsFor(4.83) <= digitsFor(0.0727));
  assert.ok(digitsFor(0.0727) <= 3);
  // A positive correction is the one that lowers the optic, so it reads negative
  // and carries the mirrored click count.
  const positive = formatDialedSetting(0.1454 * 3.4, 0.1454);
  assert.equal(positive.clicks, -3);
  assert.match(positive.suffix, /^3 clicks · /);
  assert.ok(Number(positive.mrad) < 0, `expected a lowered optic, got ${positive.mrad}`);
  // No serialized tick: report the solved value, unsnapped, and say so.
  const unknown = formatDialedSetting(2.028, null, { zeroLabel: "no elevation adjustment" });
  assert.equal(unknown.snapped, false);
  assert.equal(unknown.mrad, "-2.028");
  close(Number(unknown.moa), -2.028 * MOA_PER_MRAD, 0.01);
  assert.match(unknown.suffix, /scope setting/);
  // A centred axis says so instead of quoting zero clicks.
  const centred = formatDialedSetting(0, 0.1454, { zeroLabel: "no elevation adjustment" });
  assert.equal(centred.clicks, 0);
  assert.equal(centred.mrad, "0.00");
  assert.equal(centred.suffix, "no elevation adjustment");
});

test("the chart draws the combined region and a DIAL readout", { skip: !hasDataset && "Run npm run extract for install integration checks" }, () => {
  // A fine tick so the region fits inside the wall and is actually drawn; a
  // coarse one is legitimately suppressed as off-wall.
  const fine = { elevation: { unit: "mrad", perTick: 0.1, degrees: 0.1 * (Math.PI / 180) },
    windage: { unit: "mrad", perTick: 0.1, degrees: 0.1 * (Math.PI / 180) } };
  const { solution, options, round } = solve({ adjustmentTicks: fine });
  const render = (result) => {
    const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
    const svg = dom.window.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 1040 440");
    dom.window.document.body.append(svg);
    renderTrajectoryChart(svg, result, options, round);
    return { dom, svg };
  };
  const adjustable = render(solution);
  const group = adjustable.svg.querySelector(".dispersion-cone");
  assert.ok(group);
  // The drawn outline is the click rectangle widened by the disc, so its outer
  // vertical extent is the rectangle span plus a radius at each end.
  const radiusCm = Number(group.getAttribute("data-radius-cm"));
  const heightSpan = Number(group.getAttribute("data-height-max-cm")) - Number(group.getAttribute("data-height-min-cm"));
  const lateralSpan = Number(group.getAttribute("data-lateral-max-cm")) - Number(group.getAttribute("data-lateral-min-cm"));
  assert.ok(heightSpan > 0, "the click band must widen the vertical extent");
  assert.ok(lateralSpan > 0, "the click band must widen the lateral extent");
  assert.equal(radiusCm, solution.targetSpread.boundRadius * 100, 1e-9);
  const outline = [...group.querySelectorAll("polygon, path")].map((node) => node.getAttribute("points") || node.getAttribute("d"));
  for (const geometry of outline) assert.doesNotMatch(geometry, /NaN/);
  const readout = [...adjustable.svg.querySelectorAll(".back-readout-label")].map((node) => node.textContent);
  assert.equal(readout.length, 5);
  assert.match(readout.at(-1), /^DIAL · /);
  assert.match(readout.at(-1), /MOA/);
  assert.doesNotMatch(adjustable.svg.textContent, /NaN|Infinity/);
  adjustable.dom.window.close();

  const fixed = render(calculate(round, data.settings, { ...options, windageAdjustable: false }));
  const noWindage = [...fixed.svg.querySelectorAll(".back-readout-label")].map((node) => node.textContent).at(-1);
  assert.match(noWindage, /^DIAL · no windage, /, "the readout must name the missing capability, not a number");
  const title = fixed.svg.querySelector(".dispersion-cone title").textContent;
  assert.match(title, /no windage adjustment/);
  fixed.dom.window.close();
});