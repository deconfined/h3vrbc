// Orthographic 30° projection in the sight-relative frame. Each axis has its
// own display scale: this is an explanatory diagram, not a to-scale scene.
const SVG_NS = "http://www.w3.org/2000/svg";
const WIDTH = 1040;
const HEIGHT = 440;
const PLOT_LEFT = 136;
const PLOT_RIGHT = 736;
const READOUT_X = 760;
const COS = Math.sqrt(3) / 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
// Widest plausible advance for the 9px monospace callout type. Deliberately
// generous: overestimating only widens the panel slightly, whereas
// underestimating lets a value run past its edge.
const CHAR_WIDTH = 5.9;
// Gap between a row's key and its right-aligned value. Counted in the width the
// panel reserves, not just in the squeeze test, or the two disagree and every
// long row gets squeezed even though the line as a whole would have fit.
const VALUE_GAP = 6;
const fmt = (value, digits = 2) => Number(value).toFixed(digits);
const tick = (value, signed = false) => {
  const rounded = Number(value.toFixed(1));
  return `${signed && rounded > 0 ? "+" : ""}${rounded}`;
};

// Exact inverse of the sight-frame projection trace() integrates in, so this
// re-expresses a sample in a shooter-relative frame: origin at the shooter,
// base plane level with them, range measured horizontally. The round therefore
// sits visibly above or below that plane whenever the sight line is inclined.
//
//   sight range  = z·cos(I) + y·sin(I)      height = y·cos(I) − z·sin(I)
//   ⇒ altitude   = h·cos(I) + r·sin(I)     forward = r·cos(I) − h·sin(I)
//
// A level sight line (I = 0) is the identity, so the two frames only differ
// when the shot actually is inclined.
// The achievable impact region combines two independent sources, and they are
// not the same kind of thing:
//
//   * Dial granularity is a CHOICE. Only two clicks bracket the solved
//     adjustment, so the reachable impacts are four points: the elevation band
//     crossed with the windage band. Nothing in between is dialled.
//   * Dispersion is a random draw made once at launch. Its contribution is a
//     disc of the envelope radius around whichever of those four points the
//     group actually lands on.
//
// The union is therefore the rectangle of reachable points dilated by the disc:
// a rounded rectangle. Sampling it explicitly keeps the rounded ends honest
// instead of approximating with a rectangle plus a circle.
export function impactRegion(coneRadius, band) {
  const finite = (values) => values.filter((value) => Number.isFinite(value));
  const heights = [];
  const laterals = [];
  if (band?.elevation) heights.push(band.elevation.lower, band.elevation.upper);
  heights.push(0);
  if (band?.windage) laterals.push(band.windage.lower, band.windage.upper);
  else if (band?.windageUnavailable) laterals.push(0, band.windageUnavailable.lateral);
  laterals.push(0);
  // Never let a missing or malformed band put NaN into the geometry: this chart
  // is required to render finite numbers, and a partially populated solution
  // should degrade to a plain cone rather than an unreadable path.
  const safeHeights = finite(heights);
  const safeLaterals = finite(laterals);
  const hMin = Math.min(...safeHeights), hMax = Math.max(...safeHeights);
  const lMin = Math.min(...safeLaterals), lMax = Math.max(...safeLaterals);
  return {
    radius: Number.isFinite(coneRadius) ? Math.max(0, coneRadius) : 0,
    heightMin: hMin, heightMax: hMax, lateralMin: lMin, lateralMax: lMax,
    // True when the dial band is a flat spot rather than a span, so the caller
    // can tell a plain cone from a genuinely two-click band.
    hasDialBand: Boolean(band?.elevation && (band.elevation.upper > band.elevation.lower)
      || (band?.windage && band.windage.upper > band.windage.lower)
      || band?.windageUnavailable),
  };
}

// Boundary of impactRegion, relative to the corrected impact point. Callers
// rebase onto the impact, which also carries the range the projection needs.
export function impactRegionPoints(region, samplesPerArc = 10) {
  const { radius, heightMin, heightMax, lateralMin, lateralMax } = region;
  const points = [];
  const corner = (height, lateral, fromAngle, toAngle) => {
    for (let i = 0; i <= samplesPerArc; i++) {
      const angle = fromAngle + (toAngle - fromAngle) * i / samplesPerArc;
      points.push({ height: height + radius * Math.sin(angle), lateral: lateral + radius * Math.cos(angle) });
    }
  };
  // Straight edges between corners, then the four rounded corners in order.
  corner(heightMax, lateralMax, 0, Math.PI / 2);
  corner(heightMax, lateralMin, Math.PI / 2, Math.PI);
  corner(heightMin, lateralMin, Math.PI, Math.PI * 1.5);
  corner(heightMin, lateralMax, Math.PI * 1.5, Math.PI * 2);
  return points;
}

export function toShooterFrame(point, inclinationDegrees = 0) {
  const radians = inclinationDegrees * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  // Keep every other field. Flight samples also carry time and speed, and the
  // marker interpolates on those, so dropping them would break playback.
  return {
    ...point,
    range: point.range * cosine - point.height * sine,
    height: point.height * cosine + point.range * sine,
  };
}

export function createUncorrectedAimReference(solution, options) {
  const basePitch = solution.boreAngle;
  const baseYaw = solution.boreYaw;
  const pitch = solution.correctedFlight?.boreAngle;
  const yaw = solution.correctedFlight?.boreYaw;
  const cantDegrees = solution.correctedFlight?.cantDegrees ?? 0;
  if (![basePitch, baseYaw, pitch, yaw, cantDegrees].every(Number.isFinite))
    throw new Error("The uncorrected aim reference requires finite base and corrected launch angles.");
  // The integrator's bore frame is B(pitch, yaw) = Ry(yaw) Rx(-pitch).
  // Carry the original optic ray into the corrected sight frame with the gun:
  // B(corrected) B(base)^-1 [0, 0, 1]. Merely drawing the zero-height axis would
  // show the CORRECTED sight ray, which necessarily contains corrected POI.
  const dp = pitch - basePitch;
  const sb = Math.sin(baseYaw), cb = Math.cos(baseYaw);
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const direction = {
    range: sy * sb + cy * Math.cos(dp) * cb,
    height: Math.sin(dp) * cb,
    lateral: -cy * sb + sy * Math.cos(dp) * cb,
  };
  // Roll is shared by the base/corrected weapon poses: C Bc Bb^-1 C^-1 z.
  // C^-1 leaves the sight ray unchanged, so roll the resulting lateral/up pair.
  if (cantDegrees !== 0) {
    const roll = cantDegrees * Math.PI / 180, c = Math.cos(roll), s = Math.sin(roll);
    const lateral = direction.lateral;
    direction.lateral = lateral * c + direction.height * s;
    direction.height = direction.height * c - lateral * s;
  }
  const atDistance = (distance) => ({
    range: distance * direction.range,
    height: distance * direction.height,
    lateral: distance * direction.lateral,
  });
  const zeroDistance = options.zeroModel !== "unadjusted" && Number.isFinite(solution.settingRange) && solution.settingRange > 0
    ? solution.settingRange : null;
  // Extend to the selected range plane when forward-facing. For a nearly
  // sideways/backward reference, draw a finite segment rather than divide by
  // a near-zero forward component or pretend that it reaches the range plane.
  const distanceEnd = Math.max(zeroDistance ?? 0,
    direction.range > 0.000001 ? options.targetRange / direction.range : options.targetRange);
  return { direction, origin: atDistance(0), endpoint: atDistance(distanceEnd),
    zeroPoint: zeroDistance === null ? null : atDistance(zeroDistance), zeroDistance };
}

export function createBackPlaneOffsets(reference, impact, bounds = null) {
  const { origin, direction } = reference;
  if (!direction.range) return null;
  const distance = (impact.range - origin.range) / direction.range;
  if (!Number.isFinite(distance) || distance < 0) return null;
  const poa = { range: impact.range, height: origin.height + distance * direction.height,
    lateral: origin.lateral + distance * direction.lateral };
  // Test against the actual finite wall in world coordinates, not the SVG
  // bounding box of its isometric projection. Do not clamp an off-wall ray.
  if (![poa.height, poa.lateral, impact.height, impact.lateral].every(Number.isFinite)) return null;
  if (bounds && (poa.height < bounds.heightMin || poa.height > bounds.heightMax
    || Math.abs(poa.lateral) > bounds.lateralLimit)) return null;
  const corner = { range: impact.range, height: impact.height, lateral: poa.lateral };
  return { poa, corner, impact, height: impact.height - poa.height, lateral: impact.lateral - poa.lateral };
}

// The dispersion cone is isotropic in the sight frame, so it is drawn as a
// sampled ellipse on the impact plane rather than a lateral bar. It is measured in
// centimetres like every other wall measurement, and it is deliberately NOT fed
// into the layout bounds: at long range the cone is far wider than the lateral
// drift, and letting it resize the wall would flatten the flight it annotates.
// When the cone is wider than the drawn wall it is omitted and the readout keeps
// the number, the same treatment the uncorrected POA ray already gets.
// Fit-test for the impact region, so it is only drawn where the back wall can
// actually show it. Like the cone it replaces, it is deliberately kept out of
// the layout bounds: at long range the region is far wider than the lateral
// drift, and letting it resize the wall would flatten the flight it annotates.
export function createImpactRegion(impact, region, bounds = null) {
  if (!region) return null;
  if (bounds) {
    if (Math.abs(region.lateralMin) > bounds.lateralLimit || Math.abs(region.lateralMax) > bounds.lateralLimit)
      return null;
    if (region.heightMax > bounds.heightMax || region.heightMin < bounds.heightMin) return null;
  }
  return { impact, region, bounds };
}

export function clipReferenceToHeight(reference, heightMin, heightMax) {
  const { origin, endpoint } = reference;
  const delta = endpoint.height - origin.height;
  let start = 0, end = 1;
  if (delta === 0) {
    if (origin.height < heightMin || origin.height > heightMax) return null;
  } else {
    const a = (heightMin - origin.height) / delta, b = (heightMax - origin.height) / delta;
    start = Math.max(0, Math.min(a, b));
    end = Math.min(1, Math.max(a, b));
    if (end < start) return null;
  }
  const at = (fraction) => Object.fromEntries(["range", "height", "lateral"]
    .map((axis) => [axis, origin[axis] + fraction * (endpoint[axis] - origin[axis])]));
  return { origin: at(start), endpoint: at(end), clipped: start !== 0 || end !== 1 };
}

export function createIsometricLayout(points, rangeEnd, referencePoints = []) {
  const allPoints = [...points, ...referencePoints];
  if (!(rangeEnd > 0) || !Number.isFinite(rangeEnd) || !points.length
    || allPoints.some((point) => ![point.range, point.height, point.lateral].every(Number.isFinite)))
    throw new Error("The trajectory chart requires finite flight samples and a positive chart range.");
  const rangeStart = Math.min(0, ...allPoints.map((point) => point.range));
  const lower = Math.min(0, ...points.map((point) => point.height));
  const upper = Math.max(0, ...points.map((point) => point.height));
  const padding = Math.max((upper - lower) * 0.12, 0.025);
  const heightMin = lower - padding;
  // The ceiling is the plotted projectile apex (or the zero-height sight
  // plane for flat flight), never the original optic ray's height.
  const heightMax = upper;
  const lateralLimit = Math.max(0.05, ...allPoints.map((point) => Math.abs(point.lateral) * 1.12));
  const raw = ({ range, height = 0, lateral = 0 }) => {
    const forward = range / rangeEnd * 600;
    const right = lateral / lateralLimit * 80;
    const up = height / (heightMax - heightMin) * 160;
    return [COS * (forward + right), -0.5 * forward + 0.5 * right - up];
  };
  const floor = [
    { range: rangeStart, lateral: -lateralLimit }, { range: rangeEnd, lateral: -lateralLimit },
    { range: rangeEnd, lateral: lateralLimit }, { range: rangeStart, lateral: lateralLimit },
  ];
  const rangePlane = [
    { range: rangeEnd, lateral: -lateralLimit, height: heightMin },
    { range: rangeEnd, lateral: lateralLimit, height: heightMin },
    { range: rangeEnd, lateral: lateralLimit, height: heightMax },
    { range: rangeEnd, lateral: -lateralLimit, height: heightMax },
  ];
  const bounds = [...points, ...floor, ...rangePlane,
    ...rangePlane.map((point) => ({ ...point, range: rangeStart }))].map(raw);
  const minX = Math.min(...bounds.map(([x]) => x));
  const maxX = Math.max(...bounds.map(([x]) => x));
  const minY = Math.min(...bounds.map(([, y]) => y));
  const maxY = Math.max(...bounds.map(([, y]) => y));
  // Preserve the diagram's space and reserve a separate right-hand gutter for
  // the impact-plane measurements, rather than writing over the flight or wall.
  const scale = Math.min((PLOT_RIGHT - PLOT_LEFT) / (maxX - minX), (HEIGHT - 96) / (maxY - minY));
  const project = (point) => {
    const [x, y] = raw(point);
    return [(PLOT_LEFT + PLOT_RIGHT) / 2 + (x - (minX + maxX) / 2) * scale,
      HEIGHT / 2 + (y - (minY + maxY) / 2) * scale];
  };
  return { project, floor, rangePlane, rangeStart, rangeEnd, heightMin, heightMax, lateralLimit };
}

export function convexHull(points) {
  const sorted = points.map((point) => [...point]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .filter((point, i, all) => i === 0 || point[0] !== all[i - 1][0] || point[1] !== all[i - 1][1]);
  if (sorted.length <= 2) return sorted;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = (values) => {
    const hull = [];
    for (const point of values) {
      while (hull.length >= 2 && cross(hull.at(-2), hull.at(-1), point) <= 0) hull.pop();
      hull.push(point);
    }
    return hull.slice(0, -1);
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

// Position along the flight at a given elapsed time. Samples are keyed by range
// and carry the time they were reached, so this walks the same polyline the
// chart draws and interpolates every field linearly within a segment. Because
// speed falls to drag, equal time steps cover shrinking distances, which is the
// real motion rather than an eased approximation.
export function sampleFlightAt(points, time) {
  if (!points.length) return null;
  if (!(time > 0)) return { ...points[0], time: 0 };
  const last = points.at(-1);
  if (time >= last.time) return { ...last };
  let i = 1;
  while (i < points.length - 1 && points[i].time < time) i += 1;
  const a = points[i - 1], b = points[i];
  const span = b.time - a.time;
  if (!(span > 0)) return { ...b };
  const k = (time - a.time) / span;
  const mix = (key) => a[key] + (b[key] - a[key]) * k;
  return { range: mix("range"), height: mix("height"), lateral: mix("lateral"), speed: mix("speed"), time };
}

// Elapsed time whose projected polyline comes closest to a point in SVG space.
// Lets the chart be scrubbed by clicking anywhere near the flight, without
// needing an axis. Snaps to the nearest segment so the marker stays on the line.
export function timeAtProjectedPoint(projected, x, y) {
  let best = null;
  for (let i = 1; i < projected.length; i++) {
    const [x1, y1] = projected[i - 1], [x2, y2] = projected[i];
    const dx = x2 - x1, dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    const k = lengthSquared > 0
      ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared)) : 0;
    const ox = x1 + k * dx - x, oy = y1 + k * dy - y;
    const distance = ox * ox + oy * oy;
    if (!best || distance < best.distance) best = { distance, index: i, k };
  }
  return best;
}

// Cone radius at the marker's own range. Dispersion is a single launch-angle
// offset in the source, so nothing accumulates: this is the same envelope the
// CONE readout reports at the target, evaluated where the marker currently is.
export function coneRadiusAt(spread, range) {
  if (!spread || !(spread.maxDegrees >= 0)) return 0;
  // The muzzle spawns a few millimetres behind the optical origin, so clamp the
  // near-zero end rather than report a negative radius.
  return Math.max(0, range) * Math.tan(spread.maxDegrees * Math.PI / 180);
}

export function renderTrajectoryChart(chart, solution, options, round) {
  const rawFlight = solution.correctedFlight;
  if (!rawFlight?.points?.length || !rawFlight.target)
    throw new Error("The trajectory chart requires a simulated corrected flight.");
  // Two frames are offered. "sight" keeps the drop visible against the line the
  // shooter is actually aiming down. "shooter" puts the base plane level with
  // the shooter, so an inclined shot rises above it and lands back on it. The
  // same sample set serves both, since the transform below is exactly invertible.
  const shooterFrame = options.referenceFrame === "shooter";
  const incline = options.inclinationDegrees ?? 0;
  const frame = (point) => shooterFrame ? toShooterFrame(point, incline) : point;
  // Built from the untransformed solution: the aim reference needs the
  // sight-relative bore angles, and only its finished geometry is reframed.
  const rawReference = createUncorrectedAimReference(solution, options);
  const aimReference = {
    ...rawReference,
    origin: frame(rawReference.origin),
    endpoint: frame(rawReference.endpoint),
    // The ray's unit direction is reported on the drawn geometry, so reframe it
    // with everything else rather than leaving a sight-frame value on screen.
    direction: frame(rawReference.direction),
  };
  const zeroPoint = rawReference.zeroPoint ? frame(rawReference.zeroPoint) : null;
  // trace() returns an `initial`, but the assembled correctedFlight carries it
  // as the first point instead; fall back rather than reframe undefined.
  const flight = shooterFrame
    ? {
      ...rawFlight,
      points: rawFlight.points.map(frame),
      target: frame(rawFlight.target),
      initial: frame(rawFlight.initial ?? rawFlight.points[0]),
    }
    : rawFlight;
  // The impact plane sits at the target's own forward distance in this frame,
  // which is the horizontal distance for a shooter-level view.
  const planeRange = shooterFrame ? flight.target.range : options.targetRange;
  // Frame-dependent wording for the accessible title/description. The numbers
  // are identical either way; only what they are measured against changes.
  const planeName = shooterFrame ? "the level plane through the shooter" : "the zero-height corrected sight plane";
  const heightName = shooterFrame ? "altitude above that level plane" : "height relative to the sight line";
  const frameName = shooterFrame ? "shooter-level" : "sight-relative";
  const viewNote = shooterFrame
    ? "Isometric shooter-level view. The base plane is level with the shooter, so an inclined shot rises above it and returns to it at the target; range is horizontal distance. Height and lateral scales are independently exaggerated and auto-scaled, not a to-scale scene."
    : "Isometric sight-relative view with independently exaggerated height and lateral scales. The grid is the zero-height corrected sight plane, not terrain.";
  const document = chart.ownerDocument;
  const element = (type, attributes = {}, text) => {
    const node = document.createElementNS(SVG_NS, type);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const uncertainty = solution.cantUncertainty?.complete ? solution.cantUncertainty : null;
  const bandPoints = uncertainty
    ? uncertainty.samples.flatMap((sample) => sample.points.map(frame))
    : [];
  // Reference geometry may extend the horizontal range/lateral bounds, but
  // only projectile samples set the height range and apex-based ceiling.
  const layout = createIsometricLayout([...flight.points, flight.target, ...bandPoints],
    Math.max(planeRange, aimReference.endpoint.range),
    [aimReference.origin, aimReference.endpoint, ...(zeroPoint ? [zeroPoint] : [])]);
  const { project, rangeStart, rangeEnd, heightMin, heightMax, lateralLimit } = layout;
  const visibleReference = clipReferenceToHeight(aimReference, heightMin, heightMax);
  const visibleZero = zeroPoint && zeroPoint.height >= heightMin && zeroPoint.height <= heightMax;
  const path = (points) => points.map((point, index) => {
    const [x, y] = project(point);
    return `${index ? "L" : "M"}${fmt(x, 3)},${fmt(y, 3)}`;
  }).join(" ");
  const polygon = (points, className) => element("polygon", {
    points: points.map((point) => project(point).map((value) => fmt(value, 3)).join(",")).join(" "),
    class: className,
  });
  const hullPolygon = (points, className) => {
    const hull = convexHull(points.map(project));
    return hull.length < 3 ? null : element("polygon", {
      points: hull.map((point) => point.map((value) => fmt(value, 3)).join(",")).join(" "), class: className,
    });
  };
  const line = (a, b, className) => {
    const [x1, y1] = project(a), [x2, y2] = project(b);
    return element("line", { x1, y1, x2, y2, class: className });
  };
  const text = (point, label, dx = 0, dy = 0, anchor = "start", className = "chart-axis") => {
    const [x, y] = project(point);
    return element("text", { x: x + dx, y: y + dy, "text-anchor": anchor, class: className }, label);
  };
  const pointTitle = (point) => `${tick(point.range)} m along sight line; height ${fmt(point.height * 100)} cm; lateral ${fmt(point.lateral * 100)} cm (positive is right).`;
  const calculatedZero = options.zeroModel === "calculated";
  const planeOffsets = createBackPlaneOffsets(aimReference, flight.target);
  const backOffsets = createBackPlaneOffsets(aimReference, flight.target, layout);
  const backDescription = backOffsets
    ? `The uncorrected POA marker lies on the impact plane at the selected range. Separate vertical and lateral guides lead from it to corrected POI: height change ${fmt(backOffsets.height * 100)} cm, lateral change ${fmt(backOffsets.lateral * 100)} cm. Visible labels give the magnitudes of these geometric offsets, not dial settings.`
    : `The uncorrected POA ray does not intersect the impact plane inside its displayed bounds, so no plane marker or offset guides are shown. ${planeOffsets ? `The side readout still gives its actual selected-range plane offsets: height change ${fmt(planeOffsets.height * 100)} cm, lateral change ${fmt(planeOffsets.lateral * 100)} cm, without clamping the off-wall intersection.` : "There is no finite forward plane intersection to measure."}`;
  const zeroDescription = zeroPoint
    ? `${calculatedZero ? "Calculated base zero" : "Nominal base optic zero"} at ${options.zeroRange} m (${fmt(aimReference.zeroDistance)} m along the original optic ray) marks the uncorrected point-of-aim ray with zero additional elevation and windage dial adjustments. In this ${frameName} frame the reference sits ${fmt(zeroPoint.height * 100)} cm of ${heightName} and ${fmt(zeroPoint.lateral * 100)} cm of lateral offset. ${calculatedZero ? "The base setting solves a projectile crossing for the original setup, before the selected-range correction." : "The nominal base zero is not a guaranteed projectile crossing for this round and setup."} The corrected flight is solved for ${options.targetRange} m, not necessarily this base-zero distance.`
    : "No base zero adjustment is applied, so no optic-zero point is shown.";
  const heightDescription = `The height ceiling is the plotted projectile apex, ${fmt(heightMax * 100)} cm, including sampled cant flights when enabled. Original POA geometry cannot stretch the height scale; its ray is clipped to this height range.${visibleReference?.clipped ? " An arrowhead at the clipped end indicates that the uncorrected POA continues off the plot." : ""} ${zeroPoint && !visibleZero ? "The base-zero point is outside the flight-height view and its marker is omitted, not moved onto the boundary." : "A base-zero marker is shown only if it fits this height range."}`;
  const cantDescription = uncertainty
    ? `The purple uncertainty envelope samples ${uncertainty.samples.length} weapon cant angles from -${uncertainty.toleranceDegrees}° to +${uncertainty.toleranceDegrees}°, including zero, with the nominal dial settings held fixed. It is a sampled geometric envelope, not a probabilistic confidence interval. Target lateral bounds are ${fmt(uncertainty.target.lateralMin * 100)} to ${fmt(uncertainty.target.lateralMax * 100)} cm.`
    : solution.cantUncertainty ? "Some sampled cant angles cannot reach the selected range; no partial uncertainty band is displayed."
    : `The solution incorporates ${fmt(flight.cantDegrees ?? 0, 1)}° weapon cant; positive cant tilts weapon-up right. Dial corrections are measured in the weapon's tilted elevation/windage axes.`;
  const readoutDescription = "The color-coded readout beside the impact plane uses RISE when corrected impact is above or level with uncorrected POA, and DROP when it is below. Its value and DRIFT are the magnitudes of the actual selected-range plane offsets, even when that POA is off the visible wall. CONE is the full-disc bound of the game's launch dispersion at this range, not a measured group. ERROR is the sampled lateral cant uncertainty about corrected nominal impact: ± denotes the error on each side, not the total width; asymmetric bounds are shown separately. Missing forward intersections are unavailable, and disabled or unbounded uncertainty is never reported as zero error.";
  const coneModel = solution.targetSpread;
  const coneRadius = coneModel?.boundRadius;
  const dial = solution.dial ?? {};
  const impactBand = {
    elevation: dial.elevation,
    windage: dial.windage,
    windageUnavailable: dial.windageUnavailable,
  };
  // The click size, stated in the unit the install authored it in.
  const clickFigure = (click) => click.degrees == null
    ? "an amount this optic does not serialize"
    : `${fmt(click.degrees * (Math.PI / 180) * 1000, 3)} mrad (authored as ${click.perTick}${click.unit ? ` ${click.unit}` : ""})`;
  const dialFigure = (band, axis) => band
    ? `${fmt(band.lower * 100, 1)} to ${fmt(band.upper * 100, 1)} cm ${axis} at the target, from clicks at ${fmt(band.lowerClickMoa, 2)} and ${fmt(band.upperClickMoa, 2)} MOA against a solved ${fmt(band.solvedMoa, 3)} MOA; ${fmt(band.best, 3)} MOA residual on the nearer click, ${fmt(band.worst, 3)} MOA on the other.`
    : null;
  const coneDescription = [
    coneRadius
      ? `The dispersion contribution is the full-disc bound of the game's own launch dispersion at this range: ${fmt(coneRadius * 200, 1)} cm across, from ${fmt(solution.spread.maxMoa, 3)} MOA of authored round, firearm and device mechanical spread. It is an angular bound on a random per-weapon draw, not a predicted group and not reproducible between sessions.${solution.spread.incomplete ? ` This bound omits the un-certified ${solution.spread.missing.join(" and ")} term, so the true figure is at least this wide.` : ""}`
      : "Dispersion is not available for this setup.",
    dial.elevation
      ? `Dial granularity moves the impact on the vertical axis. One turn of this optic's tuning component moves ${clickFigure(dial.clicks.elevation)}, so only the two clicks bracketing the solved adjustment are reachable: ${dialFigure(dial.elevation, "vertical")}`
      : dial.granularityUnknown
        ? "This optic does not serialize a tuning tick size, so no granularity band is claimed. The outline is the dispersion bound alone rather than a guessed click size."
        : null,
    dial.windage
      ? `Windage granularity does the same on the horizontal axis: ${dialFigure(dial.windage, "horizontal")}`
      : dial.windageUnavailable
        ? `This optic has no windage adjustment, so the lateral correction cannot be dialled at all. The round lands ${fmt(Math.abs(dial.windageUnavailable.lateral) * 100, 1)} cm ${dial.windageUnavailable.lateral > 0 ? "right" : "left"} of aim, which dwarfs both the granularity and the dispersion figures.`
        : null,
    "The two are independent: granularity is a choice between reachable clicks, dispersion is a random draw made once at launch, and the outline is the set of reachable clicks widened by the dispersion bound.",
    "It is drawn to the impact plane's scale, not the exaggerated lateral scale.",
  ].filter(Boolean).join(" ");
  chart.setAttribute("viewBox", `0 0 ${WIDTH} ${HEIGHT}`);
  chart.setAttribute("data-view", "isometric");
  chart.setAttribute("data-flight", "corrected");
  chart.setAttribute("data-cant-mode", options.cantMode ?? "none");
  chart.setAttribute("data-height-max-cm", heightMax * 100);
  chart.setAttribute("data-cone-radius-cm", coneRadius == null ? "" : coneRadius * 100);
  chart.replaceChildren(
    element("title", { id: "chart-title" }, `${round.name}: corrected isometric trajectory at ${options.targetRange} m, ${options.zeroModel === "unadjusted" ? "no base zero adjustment" : `${options.zeroRange} m base optic setting`}, ${fmt(options.inclinationDegrees, 1)}° firing angle, ${frameName} view`),
    element("desc", { id: "chart-description" },
      `The projectile path is simulated after applying ${fmt(solution.target.elevationMrad, 3)} mrad elevation and ${fmt(solution.target.windageMrad, 3)} mrad windage aim correction for ${options.targetRange} meters along the ${fmt(options.inclinationDegrees, 1)}° sight line; the top scope adjustments use the opposite signs. Corrected endpoint height is ${fmt(flight.target.height * 100)} cm and lateral offset is ${fmt(flight.target.lateral * 100)} cm (positive is right), within the numerical solver's tolerance of aim. ${cantDescription} ${heightDescription} Zero ${heightName} and lateral offset define corrected aim. The straight dashed line is the original uncorrected POA ray, rotated with the weapon into the corrected sight frame using both base and solved launch angles; it is not the corrected aim axis. ${zeroDescription} ${backDescription} ${readoutDescription} The projectile endpoint marks the selected range, not a target object; no flight is extrapolated beyond it. Range-card offsets and times describe the base, uncorrected shot, which is a different flight from the corrected one plotted here. ${viewNote} The blue dashed projection shows the corrected flight's lateral displacement on that plane. The nominal base optic setting is not an imposed trajectory crossing.`),
    polygon(layout.floor, "chart-plane"),
    polygon(layout.rangePlane.map((point) => ({ ...point, range: planeRange })), "range-plane"),
  );
  if (uncertainty) {
    const band = element("g", { class: "cant-envelope" });
    band.append(element("title", {}, cantDescription));
    for (let i = 1; i < uncertainty.sections.length; i++) {
      const polygon = hullPolygon([...uncertainty.sections[i - 1], ...uncertainty.sections[i]], "cant-envelope-slice");
      if (polygon) band.append(polygon);
    }
    chart.append(band);
  }
  const labels = [];
  // Keep the height ruler clear of the range origin and lateral-axis labels.
  const heightAxisOffset = -36;
  for (let i = 0; i <= 4; i++) {
    const range = rangeEnd * i / 4;
    const lateral = lateralLimit * (i / 2 - 1);
    const height = heightMin + (heightMax - heightMin) * i / 4;
    chart.append(line({ range, lateral: -lateralLimit }, { range, lateral: lateralLimit }, "chart-grid"),
      line({ range: rangeStart, lateral }, { range: rangeEnd, lateral }, "chart-grid"));
    labels.push(text({ range, lateral: -lateralLimit }, tick(range), -8, -7, "end"),
      text({ range: rangeStart, lateral: -lateralLimit, height }, tick(height * 100, true), heightAxisOffset - 10, 4, "end"));
    if (i % 2 === 0) labels.push(text({ range: rangeStart, lateral }, tick(lateral * 100, true), 0, 20, "middle"));
    const mark = { range: rangeStart, lateral: -lateralLimit, height };
    const [x, y] = project(mark);
    chart.append(element("line", { x1: x + heightAxisOffset - 4, x2: x + heightAxisOffset + 4, y1: y, y2: y, class: "chart-axis-line" }));
  }
  const [hx, hy] = project({ range: rangeStart, lateral: -lateralLimit, height: heightMin });
  const [, heightTop] = project({ range: rangeStart, lateral: -lateralLimit, height: heightMax });
  chart.append(element("line", { x1: hx + heightAxisOffset, x2: hx + heightAxisOffset, y1: hy, y2: heightTop, class: "chart-axis-line" }),
    line({ range: rangeStart, lateral: -lateralLimit }, { range: rangeEnd, lateral: -lateralLimit }, "chart-axis-line"),
    line({ range: rangeStart, lateral: -lateralLimit }, { range: rangeStart, lateral: lateralLimit }, "chart-axis-line"));
  labels.push(text({ range: rangeStart, lateral: -lateralLimit, height: heightMax }, "HEIGHT / cm", heightAxisOffset - 10, -13, "end"),
    text({ range: rangeEnd, lateral: -lateralLimit }, "RANGE / m", -12, -25, "end"),
    text({ range: rangeStart, lateral: lateralLimit }, "LATERAL +RIGHT / cm", 10, 40, "middle"));
  chart.append(element("path", { d: path(flight.points.map((point) => ({ ...point, height: 0 }))), class: "trajectory-shadow" }));
  if (visibleReference) {
    const poaRay = line(visibleReference.origin, visibleReference.endpoint, "sight-line");
    poaRay.setAttribute("data-height-clipped", visibleReference.clipped);
    poaRay.setAttribute("data-direction-height", aimReference.direction.height);
    poaRay.setAttribute("data-direction-lateral", aimReference.direction.lateral);
    poaRay.append(element("title", {}, "Uncorrected POA: the original optic ray with zero additional elevation and windage dial adjustments, rotated into the corrected sight frame with the weapon. Clipped to the projectile height range without changing its direction."));
    chart.append(poaRay);
    if (visibleReference.clipped) {
      const [x, y] = project(visibleReference.endpoint);
      // Use the full ray for orientation even when height clipping leaves
      // only its origin visible (a flat flight with an upward POA).
      const [ox, oy] = project(aimReference.origin), [ex, ey] = project(aimReference.endpoint);
      const angle = Math.atan2(ey - oy, ex - ox) * 180 / Math.PI;
      const arrow = element("path", { d: "M-9,-4 L0,0 L-9,4 Z", class: "sight-line-arrowhead",
        transform: `translate(${x},${y}) rotate(${angle})` });
      arrow.append(element("title", {}, "Uncorrected POA continues off the plot."));
      chart.append(arrow);
    }
  }
  for (let i = 40; i < flight.points.length - 1; i += 40) {
    const point = flight.points[i];
    chart.append(line(point, { ...point, height: 0 }, "projection-line"));
  }
  if (backOffsets) {
    const { poa, corner, impact, height, lateral } = backOffsets;
    const guides = element("g", { class: "back-offsets" });
    guides.append(element("title", {}, backDescription));
    const heightGuide = line(poa, corner, "back-offset back-height-offset");
    const lateralGuide = line(corner, impact, "back-offset back-lateral-offset");
    heightGuide.setAttribute("data-offset-cm", height * 100);
    lateralGuide.setAttribute("data-offset-cm", lateral * 100);
    heightGuide.append(element("title", {}, `Height change from uncorrected POA to corrected POI: ${fmt(height * 100)} cm.`));
    lateralGuide.append(element("title", {}, `Lateral change from uncorrected POA to corrected POI: ${fmt(lateral * 100)} cm.`));
    const [px, py] = project(poa);
    const marker = element("circle", { cx: px, cy: py, r: 4.5, class: "back-poa-point",
      "data-range-m": poa.range, "data-height-cm": poa.height * 100, "data-lateral-cm": poa.lateral * 100 });
    marker.append(element("title", {}, `Uncorrected POA on the impact plane: ${pointTitle(poa)}`));
    guides.append(heightGuide, lateralGuide, marker);
    chart.append(guides);
  }
  let errorGuide = null;
  if (uncertainty) {
    const bounds = uncertainty.target;
    const region = element("g", { class: "cant-target-uncertainty",
      "data-lateral-min-cm": bounds.lateralMin * 100, "data-lateral-max-cm": bounds.lateralMax * 100,
      "data-height-min-cm": bounds.heightMin * 100, "data-height-max-cm": bounds.heightMax * 100 });
    region.append(element("title", {}, cantDescription));
    const hull = hullPolygon(uncertainty.samples.map((sample) => sample.target), "cant-target-region");
    if (hull) region.append(hull);
    // Put the width ruler below the impact region, but still on the impact plane,
    // so ERROR never masks the DRIFT measurement at nominal impact height.
    const guideHeight = heightMin + (Math.min(bounds.heightMin, flight.target.height) - heightMin) / 2;
    const ends = [bounds.lateralMin, bounds.lateralMax].map((lateral) => ({ ...flight.target, height: guideHeight, lateral }));
    errorGuide = { ends, min: bounds.lateralMin - flight.target.lateral, max: bounds.lateralMax - flight.target.lateral };
    const width = line(ends[0], ends[1], "cant-target-width back-error-offset");
    width.setAttribute("data-error-min-cm", errorGuide.min * 100);
    width.setAttribute("data-error-max-cm", errorGuide.max * 100);
    width.append(element("title", {}, "Sampled lateral cant error width. This ruler is lowered on the impact plane for readability; its height is not an impact height."));
    region.append(width);
    for (const end of ends) {
      const [x, y] = project(end);
      region.append(element("line", { x1: x - 2, x2: x + 2, y1: y - 3.5, y2: y + 3.5, class: "cant-target-width" }));
    }
    chart.append(region);
  }
  chart.append(element("path", { d: path(flight.points), class: "trajectory" }));
  const region = createImpactRegion(flight.target, impactRegion(coneRadius, impactBand), layout);
  if (region) {
    // Rebase onto the impact: the projection needs its range, and the region is
    // expressed as offsets from it.
    const shape = impactRegionPoints(region.region).map((point) => ({ ...region.impact, ...point }));
    const group = element("g", { class: "dispersion-cone", "data-radius-cm": region.region.radius * 100,
      "data-height-min-cm": region.region.heightMin * 100, "data-height-max-cm": region.region.heightMax * 100,
      "data-lateral-min-cm": region.region.lateralMin * 100, "data-lateral-max-cm": region.region.lateralMax * 100 });
    group.append(element("title", {}, coneDescription));
    group.append(polygon(shape, "dispersion-cone-fill"));
    group.append(element("path", { d: path(shape) + " Z", class: "dispersion-cone-edge" }));
    chart.append(group);
  }
  const [tx, ty] = project(flight.target);
  const endpoint = element("circle", { cx: tx, cy: ty, r: 5, class: "range-point",
    "data-height-cm": flight.target.height * 100, "data-lateral-cm": flight.target.lateral * 100 });
  endpoint.append(element("title", {}, `Corrected trajectory sample: ${pointTitle(flight.target)}`));
  const first = flight.points[0];
  const [mx, my] = project(first);
  const muzzle = element("circle", { cx: mx, cy: my, r: 3, class: "muzzle-point" });
  muzzle.append(element("title", {}, `Projectile spawn: ${pointTitle(first)}`));
  if (visibleZero) {
    const [zx, zy] = project(zeroPoint);
    const zero = element("circle", { cx: zx, cy: zy, r: 6.5, class: "optic-zero-point",
      "data-zero-range-m": options.zeroRange, "data-sight-range-m": zeroPoint.range,
      "data-base-sight-range-m": aimReference.zeroDistance,
      "data-height-cm": zeroPoint.height * 100, "data-lateral-cm": zeroPoint.lateral * 100,
      "data-elevation-mrad": 0, "data-windage-mrad": 0 });
    zero.append(element("title", {}, zeroDescription));
    chart.append(zero);
    const label = `BASE ZERO · ${tick(options.zeroRange)} m`;
    const anchor = zx + 10 + label.length * 6 > READOUT_X - 18 ? "end" : "start";
    labels.push(text(zeroPoint, label, anchor === "end" ? -10 : 10, 22, anchor, "optic-zero-label"));
  }
  chart.append(muzzle, endpoint, ...labels);
  const wallCenterY = project({ range: planeRange, height: (heightMin + heightMax) / 2, lateral: 0 })[1];
  // The four measurement rows share the gutter, and the first row is capped so
  // they stay in the viewBox. The cap is also what reserves the chart's
  // lower-right quadrant: the flight controls are overlaid there, and the SVG
  // scales to its container, so that space cannot be addressed in SVG units.
  const firstRowY = Math.max(84, Math.min(HEIGHT * 0.36, wallCenterY - 32));
  const readout = element("g", { class: "back-readout", "data-range-m": planeRange });
  readout.append(element("title", {}, readoutDescription), element("text", {
    x: READOUT_X, y: firstRowY - 30, class: "back-readout-heading",
  }, `${tick(planeRange)} m / IMPACT PLANE`));
  // The dial row has to say which axis it is reporting, because the two failure
// modes are different in size as well as in kind: a granularity residual is at
// most one 0.25 MOA click, while an optic with no windage at all leaves the
// entire lateral correction undialled.
let dialValue = "—";
let dialAvailable = false;
if (!dial.windageAdjustable && dial.windageUnavailable) {
  dialValue = `no windage, ${fmt(Math.abs(dial.windageUnavailable.lateral) * 100, 0)} cm`;
  dialAvailable = true;
} else if (dial.elevation) {
  const elevation = `${fmt(dial.elevation.best, 2)} MOA`;
  dialValue = dial.windage
    ? `${elevation} · ${fmt(dial.windage.best, 2)} MOA`
    : elevation;
  dialAvailable = true;
}
  let errorValue = solution.cantUncertainty ? "UNBOUNDED" : "—";
  if (errorGuide) {
    const left = fmt(Math.abs(errorGuide.min) * 100), right = fmt(Math.abs(errorGuide.max) * 100);
    errorValue = left === right ? `±${right} cm` : `−${left} / +${right} cm`;
  }
  const measurements = [
    { name: planeOffsets ? planeOffsets.height < 0 ? "DROP" : "RISE" : "RISE/DROP", kind: "height",
      value: planeOffsets ? `${fmt(Math.abs(planeOffsets.height) * 100)} cm` : "—",
      available: Boolean(planeOffsets), title: backDescription },
    { name: "DRIFT", kind: "lateral", value: planeOffsets ? `${fmt(Math.abs(planeOffsets.lateral) * 100)} cm` : "—",
      available: Boolean(planeOffsets), title: backDescription },
    { name: "ERROR", kind: "error", value: errorValue, available: Boolean(solution.cantUncertainty),
      title: errorGuide ? `${cantDescription} The width ruler and ERROR label show lateral error about nominal corrected impact, not dial corrections. ± gives each side's error, not total width.`
        : solution.cantUncertainty ? cantDescription : "Cant uncertainty is not enabled. No uncertainty width is assumed." },
    { name: "CONE", kind: "cone",
      value: coneRadius ? `${solution.spread.incomplete ? "≥" : ""}${fmt(coneRadius * 200, 0)} cm` : "—",
      available: Boolean(coneRadius), title: coneDescription },
    { name: "DIAL", kind: "dial", value: dialValue, available: dialAvailable, title: coneDescription },
  ];
  measurements.forEach(({ name, kind, value, available, title }, i) => {
    const y = firstRowY + i * 32;
    const row = element("g", { class: `back-readout-row${available ? "" : " back-readout-unavailable"}` });
    row.append(element("title", {}, title), element("line", {
      x1: READOUT_X, x2: READOUT_X + 18, y1: y - 5, y2: y - 5,
      class: `back-readout-key back-${kind}-key`,
    }));
    const label = element("text", { x: READOUT_X + 28, y,
      class: `back-readout-label back-${kind}-label` });
    const valueX = READOUT_X + 124, valueWidth = WIDTH - 16 - valueX;
    const number = element("tspan", { x: valueX, class: "back-readout-value",
      ...(value.length * 9 > valueWidth ? { textLength: valueWidth, lengthAdjust: "spacingAndGlyphs" } : {}),
    }, value);
    label.append(element("tspan", {}, `${name} · `), number);
    row.append(label);
    readout.append(row);
  });
  chart.append(readout);

  // Flight marker. Starts parked at the muzzle and only moves when asked, so a
  // render is never animated by surprise and never animates under
  // prefers-reduced-motion. The marker is drawn from the same samples as the
  // trajectory polyline above, so it can never leave the line.
  const marker = element("g", { class: "flight-marker", "data-time-s": "0" });
  const dot = element("circle", { class: "flight-marker-dot", r: 5 });
  const callout = element("g", { class: "flight-callout" });
  const leader = element("line", { class: "flight-callout-leader" });
  const panel = element("rect", { class: "flight-callout-panel", rx: 3 });
  // Range is reported in whatever the chart's forward axis currently means, so
  // the callout can never contradict the axis it is drawn against. Altitude,
  // lateral and the sight-line gap are always shooter-relative.
  const fields = [
    ["range", shooterFrame ? "horiz range" : "range"], ["alt", "altitude"],
    ["lateral", "lateral"], ["speed", "speed"], ["gap", "sight-line gap"],
    ["cone", "cone"],
  ].map(([key, label]) => {
    const line = element("text", { class: "flight-callout-line", "data-field": key });
    const keyNode = element("tspan", { class: "flight-callout-key" }, `${label} `);
    const valueNode = element("tspan", { class: "flight-callout-value" }, "—");
    line.append(keyNode, valueNode);
    return { key, label, line, keyNode, valueNode };
  });
  callout.append(leader, panel, ...fields.map((field) => field.line));
  marker.append(dot, callout);
  marker.append(element("title", {},
    "Marker on the corrected flight. Playback shows the round's position in the shooter frame, its instantaneous speed, its gap from the straight sight line and the dispersion cone at that range."));
  chart.append(marker);

  const flightPoints = flight.points;
  // The sight-frame samples are kept alongside the drawn ones. Both carry
  // identical time keys, so sampling them at the same instant yields the same
  // segment, and the sight-line gap stays a sight-line measurement in either view.
  const sightPoints = rawFlight.points;
  const projectedFlight = flightPoints.map(project);
  const totalTime = flightPoints.at(-1).time;
  const shooterView = shooterFrame;
  // Read the gap from the sight line in its own frame even when the chart is
  // drawn shooter-level: the round leaving above the line and returning to it is
  // the accumulated error worth watching, and it is the trajectory itself.
  const state = { time: 0, rate: 1, playing: false, frame: null };

  function frameAt(time) {
    const point = sampleFlightAt(flightPoints, time);
    if (!point) return null;
    const sight = sampleFlightAt(sightPoints, time) ?? point;
    const [x, y] = project(point);
    const shooter = shooterView ? point : toShooterFrame(point, incline);
    const cone = coneRadiusAt(solution.spread, sight.range);
    return { point, x, y, shooter, cone, gapSight: sight.height };
  }

  function draw(time) {
    const current = frameAt(time);
    if (!current) return;
    state.time = Math.max(0, Math.min(totalTime, time));
    dot.setAttribute("cx", fmt(current.x, 3));
    dot.setAttribute("cy", fmt(current.y, 3));
    // Park the callout above the marker by default and flip it below when the
    // marker is in the top third, so the panel never leaves the viewport.
    const below = current.y < 150;
    const altitude = shooterView ? current.point.height : current.shooter.height;
    const values = {
      range: `${fmt(current.point.range, 1)} m`,
      alt: `${fmt(altitude, 2)} m ${Math.abs(altitude) < 0.005 ? "level" : altitude > 0 ? "up" : "down"}`,
      lateral: `${fmt(current.point.lateral * 100, 1)} cm ${Math.abs(current.point.lateral) < 0.00005 ? "centered" : current.point.lateral > 0 ? "right" : "left"}`,
      speed: `${fmt(current.point.speed, 1)} m/s`,
      gap: `${fmt(Math.abs(current.gapSight) * 100, 1)} cm ${Math.abs(current.gapSight) < 0.00005 ? "on line" : current.gapSight > 0 ? "above" : "below"}`,
      cone: `⌀ ${fmt(current.cone * 200, 1)} cm`,
    };
    // Size the panel to its contents instead of assuming a fixed width. Values
    // grow with range -- "sight-line gap 1234.5 cm below" is half again as long
    // as the shortest one -- so a fixed box clipped the longest rows. Estimate the
    // 9px monospace advance generously, then lay the values out right-aligned so
    // the keys keep a common left edge and the numbers line up as a column.
    const boxHeight = 20 + fields.length * 13;
    const content = Math.max(...fields.map((field) => (field.label.length + 1 + values[field.key].length) * CHAR_WIDTH));
    const boxWidth = clamp(Math.ceil(content) + 18 + VALUE_GAP, 132, 214);
    // Flip the panel to the other side of the marker based on the width now that
    // the width is known, so the flip decision and the clamp agree.
    const flip = current.x + 16 + boxWidth > WIDTH - 6;
    const panelX = current.x + (flip ? -16 - boxWidth : 16);
    const panelY = current.y + (below ? 30 : -30);
    const left = Math.max(6, Math.min(WIDTH - boxWidth - 6, panelX));
    const top = Math.max(6, Math.min(HEIGHT - boxHeight - 6, panelY - boxHeight / 2));
    panel.setAttribute("x", fmt(left, 3));
    panel.setAttribute("y", fmt(top, 3));
    panel.setAttribute("width", boxWidth);
    panel.setAttribute("height", boxHeight);
    leader.setAttribute("x1", fmt(current.x, 3));
    leader.setAttribute("y1", fmt(current.y, 3));
    leader.setAttribute("x2", fmt(flip ? left + boxWidth : left, 3));
    leader.setAttribute("y2", fmt(clamp(top + boxHeight / 2, top + 8, top + boxHeight - 8), 3));
    const valueX = left + boxWidth - 8;
    fields.forEach((field, index) => {
      const value = values[field.key];
      field.line.setAttribute("x", fmt(left + 8, 3));
      field.line.setAttribute("y", fmt(top + 20 + index * 13, 3));
      field.keyNode.removeAttribute("x");
      field.valueNode.textContent = value;
      field.valueNode.setAttribute("x", fmt(valueX, 3));
      field.valueNode.setAttribute("text-anchor", "end");
      // Last-resort guard, the same one the wall readout uses: if a value is
      // still wider than the space the keys leave, squeeze the glyph spacing
      // rather than let it run past the panel. Dropped again once it fits, so a
      // later shorter value is not left permanently squashed.
      const keyWidth = (field.label.length + 1) * CHAR_WIDTH;
      const available = valueX - (left + 8) - keyWidth - VALUE_GAP;
      const natural = value.length * CHAR_WIDTH;
      if (natural > available) {
        field.valueNode.setAttribute("textLength", fmt(Math.max(available, 12), 3));
        field.valueNode.setAttribute("lengthAdjust", "spacingAndGlyphs");
      } else {
        field.valueNode.removeAttribute("textLength");
        field.valueNode.removeAttribute("lengthAdjust");
      }
    });
    marker.setAttribute("data-time-s", state.time);
    marker.setAttribute("data-range-m", current.point.range);
    marker.setAttribute("data-altitude-m", altitude);
    marker.setAttribute("data-speed-mps", current.point.speed);
    marker.setAttribute("data-cone-radius-cm", current.cone * 100);
    marker.setAttribute("data-sight-gap-cm", current.gapSight * 100);
    chart.setAttribute("data-flight-time-s", totalTime);
    return current;
  }

  // Playback clock. Named advance, not tick: `tick` is already the range
  // formatter used above. The clock is only ever started from a user gesture,
  // so a render is never animated by surprise.
  const scheduler = chart.ownerDocument.defaultView;
  const hasClock = typeof scheduler?.requestAnimationFrame === "function";
  // A frame can be delayed a long way -- a backgrounded tab, a stalled frame, a
  // slow device. Applying the whole elapsed time in one step would teleport the
  // marker to the end and skip the shot entirely, so cap the step and let the
  // clock catch up over several frames instead. Real 60 Hz frames are ~16 ms,
  // well inside this, so normal playback is unaffected.
  const MAX_FRAME_SECONDS = 0.05;
  let handle = null;
  let lastStamp = null;
  const advance = (stamp) => {
    handle = null;
    if (!state.playing) return;
    // The first frame only establishes the time base; the second moves.
    if (lastStamp != null) {
      const elapsed = Math.min(Math.max(stamp - lastStamp, 0) / 1000, MAX_FRAME_SECONDS);
      draw(state.time + elapsed * state.rate);
    }
    lastStamp = stamp;
    if (state.time >= totalTime) { stop(); return; }
    handle = scheduler.requestAnimationFrame(advance);
  };
  const start = () => {
    if (!hasClock || !(totalTime > 0)) return false;
    if (state.time >= totalTime) draw(0);
    state.playing = true;
    lastStamp = null;
    handle = scheduler.requestAnimationFrame(advance);
    notify();
    return true;
  };
  const stop = () => {
    state.playing = false;
    lastStamp = null;
    // A frame handle of 0 is valid, so only cancel when one was really taken.
    if (handle !== null) scheduler.cancelAnimationFrame?.(handle);
    handle = null;
    notify();
  };
  const notify = () => state.onChange?.();
  const api = {
    totalTime,
    // Proxied onto the state the clock actually reads, so assigning a handler
    // from outside really does get called on every state change.
    get onChange() { return state.onChange; },
    set onChange(handler) { state.onChange = typeof handler === "function" ? handler : null; },
    get time() { return state.time; },
    get playing() { return state.playing; },
    get available() { return hasClock && totalTime > 0; },
    play: start,
    pause: stop,
    toggle() { return state.playing ? (stop(), false) : start(); },
    seek(time) { stop(); const result = draw(time); notify(); return result; },
    scrubTo(x, y) {
      const hit = timeAtProjectedPoint(projectedFlight, x, y);
      if (!hit) return null;
      const a = flightPoints[hit.index - 1], b = flightPoints[hit.index];
      return this.seek(a.time + (b.time - a.time) * hit.k);
    },
    setRate(rate) { state.rate = Number(rate) > 0 ? Number(rate) : 1; return state.rate; },
    destroy() { state.onChange = null; stop(); },
    marker,
  };
  draw(0);
  return { ...layout, aimReference, visibleReference, planeOffsets, backOffsets, errorGuide, flightMarker: api };
}
