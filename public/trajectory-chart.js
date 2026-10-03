// Orthographic 30° projection in the sight-relative frame. Each axis has its
// own display scale: this is an explanatory diagram, not a to-scale scene.
const SVG_NS = "http://www.w3.org/2000/svg";
const WIDTH = 1040;
const HEIGHT = 440;
const PLOT_LEFT = 136;
const PLOT_RIGHT = 736;
const READOUT_X = 760;
const COS = Math.sqrt(3) / 2;
const fmt = (value, digits = 2) => Number(value).toFixed(digits);
const tick = (value, signed = false) => {
  const rounded = Number(value.toFixed(1));
  return `${signed && rounded > 0 ? "+" : ""}${rounded}`;
};

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
// sampled ellipse on the back wall rather than a lateral bar. It is measured in
// centimetres like every other wall measurement, and it is deliberately NOT fed
// into the layout bounds: at long range the cone is far wider than the lateral
// drift, and letting it resize the wall would flatten the flight it annotates.
// When the cone is wider than the drawn wall it is omitted and the readout keeps
// the number, the same treatment the uncorrected POA ray already gets.
export function createDispersionCone(impact, radius, bounds = null) {
  if (!Number.isFinite(radius) || radius <= 0) return null;
  if (bounds && Math.abs(radius) > bounds.lateralLimit) return null;
  const heightMin = bounds ? bounds.heightMin : impact.height - radius;
  const heightMax = bounds ? bounds.heightMax : impact.height + radius;
  if (bounds && (impact.height + radius < heightMin || impact.height - radius > heightMax)) return null;
  return { impact, radius, bounds, heightMin, heightMax };
}

export function dispersionConePoints(cone, samples = 32) {
  return Array.from({ length: samples }, (_, i) => {
    const angle = 2 * Math.PI * i / samples;
    return {
      ...cone.impact,
      height: cone.impact.height + cone.radius * Math.sin(angle),
      lateral: cone.impact.lateral + cone.radius * Math.cos(angle),
    };
  });
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
  // the back-wall measurements, rather than writing over the flight or wall.
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

export function renderTrajectoryChart(chart, solution, options, round) {
  const flight = solution.correctedFlight;
  if (!flight?.points?.length || !flight.target)
    throw new Error("The trajectory chart requires a simulated corrected flight.");
  const document = chart.ownerDocument;
  const element = (type, attributes = {}, text) => {
    const node = document.createElementNS(SVG_NS, type);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const aimReference = createUncorrectedAimReference(solution, options);
  const { zeroPoint } = aimReference;
  const uncertainty = solution.cantUncertainty?.complete ? solution.cantUncertainty : null;
  // Reference geometry may extend the horizontal range/lateral bounds, but
  // only projectile samples set the height range and apex-based ceiling.
  const layout = createIsometricLayout([...flight.points, flight.target,
    ...(uncertainty ? uncertainty.samples.flatMap((sample) => sample.points) : [])],
    Math.max(options.targetRange, aimReference.endpoint.range),
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
    ? `The uncorrected POA marker lies on the back wall at the selected range. Separate vertical and lateral guides lead from it to corrected POI: height change ${fmt(backOffsets.height * 100)} cm, lateral change ${fmt(backOffsets.lateral * 100)} cm. Visible labels give the magnitudes of these geometric offsets, not dial settings.`
    : `The uncorrected POA ray does not intersect the back wall inside its displayed bounds, so no wall marker or offset guides are shown. ${planeOffsets ? `The side readout still gives its actual selected-range plane offsets: height change ${fmt(planeOffsets.height * 100)} cm, lateral change ${fmt(planeOffsets.lateral * 100)} cm, without clamping the off-wall intersection.` : "There is no finite forward plane intersection to measure."}`;
  const zeroDescription = zeroPoint
    ? `${calculatedZero ? "Calculated base zero" : "Nominal base optic zero"} at ${options.zeroRange} m (${fmt(aimReference.zeroDistance)} m along the original optic ray) marks the uncorrected point-of-aim ray with zero additional elevation and windage dial adjustments. In the corrected sight frame this reference has height ${fmt(zeroPoint.height * 100)} cm and lateral offset ${fmt(zeroPoint.lateral * 100)} cm. ${calculatedZero ? "The base setting solves a projectile crossing for the original setup, before the selected-range correction." : "The nominal base zero is not a guaranteed projectile crossing for this round and setup."} The corrected flight is solved for ${options.targetRange} m, not necessarily this base-zero distance.`
    : "No base zero adjustment is applied, so no optic-zero point is shown.";
  const heightDescription = `The height ceiling is the plotted projectile apex, ${fmt(heightMax * 100)} cm, including sampled cant flights when enabled. Original POA geometry cannot stretch the height scale; its ray is clipped to this height range.${visibleReference?.clipped ? " An arrowhead at the clipped end indicates that the uncorrected POA continues off the plot." : ""} ${zeroPoint && !visibleZero ? "The base-zero point is outside the flight-height view and its marker is omitted, not moved onto the boundary." : "A base-zero marker is shown only if it fits this height range."}`;
  const cantDescription = uncertainty
    ? `The purple uncertainty envelope samples ${uncertainty.samples.length} weapon cant angles from -${uncertainty.toleranceDegrees}° to +${uncertainty.toleranceDegrees}°, including zero, with the nominal dial settings held fixed. It is a sampled geometric envelope, not a probabilistic confidence interval. Target lateral bounds are ${fmt(uncertainty.target.lateralMin * 100)} to ${fmt(uncertainty.target.lateralMax * 100)} cm.`
    : solution.cantUncertainty ? "Some sampled cant angles cannot reach the selected range; no partial uncertainty band is displayed."
    : `The solution incorporates ${fmt(flight.cantDegrees ?? 0, 1)}° weapon cant; positive cant tilts weapon-up right. Dial corrections are measured in the weapon's tilted elevation/windage axes.`;
  const readoutDescription = "The color-coded readout beside the back wall uses RISE when corrected impact is above or level with uncorrected POA, and DROP when it is below. Its value and DRIFT are the magnitudes of the actual selected-range plane offsets, even when that POA is off the visible wall. CONE is the full-disc bound of the game's launch dispersion at this range, not a measured group. ERROR is the sampled lateral cant uncertainty about corrected nominal impact: ± denotes the error on each side, not the total width; asymmetric bounds are shown separately. Missing forward intersections are unavailable, and disabled or unbounded uncertainty is never reported as zero error.";
  const coneModel = solution.targetSpread;
  const coneRadius = coneModel?.boundRadius;
  const coneDescription = coneRadius
    ? `The group cone is the full-disc bound of the game's own launch dispersion at this range: ${fmt(coneRadius * 200, 1)} cm across, from ${fmt(solution.spread.maxMoa, 3)} MOA of authored round, firearm and device mechanical spread. It is an angular bound on a random per-weapon draw, not a predicted group and not reproducible between sessions.${solution.spread.incomplete ? ` This bound omits the un-certified ${solution.spread.missing.join(" and ")} term, so the true figure is at least this wide.` : ""} It is drawn as a sampled ellipse on the back wall, not to the exaggerated lateral scale.`
    : "Dispersion is not available for this setup.";
  chart.setAttribute("viewBox", `0 0 ${WIDTH} ${HEIGHT}`);
  chart.setAttribute("data-view", "isometric");
  chart.setAttribute("data-flight", "corrected");
  chart.setAttribute("data-cant-mode", options.cantMode ?? "none");
  chart.setAttribute("data-height-max-cm", heightMax * 100);
  chart.setAttribute("data-cone-radius-cm", coneRadius == null ? "" : coneRadius * 100);
  chart.replaceChildren(
    element("title", { id: "chart-title" }, `${round.name}: corrected isometric trajectory at ${options.targetRange} m, ${options.zeroModel === "unadjusted" ? "no base zero adjustment" : `${options.zeroRange} m base optic setting`}, ${fmt(options.inclinationDegrees, 1)}° firing angle`),
    element("desc", { id: "chart-description" },
      `The projectile path is simulated after applying ${fmt(solution.target.elevationMrad, 3)} mrad elevation and ${fmt(solution.target.windageMrad, 3)} mrad windage aim correction for ${options.targetRange} meters along the ${fmt(options.inclinationDegrees, 1)}° sight line; the top scope adjustments use the opposite signs. Corrected endpoint height is ${fmt(flight.target.height * 100)} cm and lateral offset is ${fmt(flight.target.lateral * 100)} cm (positive is right), within the numerical solver's tolerance of aim. ${cantDescription} ${heightDescription} Zero height and lateral offset define corrected aim. The straight dashed line is the original uncorrected POA ray, rotated with the weapon into the corrected sight frame using both base and solved launch angles; it is not the corrected aim axis. ${zeroDescription} ${backDescription} ${readoutDescription} The projectile endpoint marks the selected range, not a target object; no flight is extrapolated beyond it. Range-card offsets and times describe the base, uncorrected shot, which is a different flight from the corrected one plotted here. Isometric sight-relative view with independently exaggerated height and lateral scales. The grid is the zero-height corrected sight plane, not terrain. The blue dashed projection shows the corrected flight's lateral displacement on that plane. The nominal base optic setting is not an imposed trajectory crossing.`),
    polygon(layout.floor, "chart-plane"),
    polygon(layout.rangePlane.map((point) => ({ ...point, range: options.targetRange })), "range-plane"),
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
    marker.append(element("title", {}, `Uncorrected POA on the back wall: ${pointTitle(poa)}`));
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
    // Put the width ruler below the impact region, but still on the back wall,
    // so ERROR never masks the DRIFT measurement at nominal impact height.
    const guideHeight = heightMin + (Math.min(bounds.heightMin, flight.target.height) - heightMin) / 2;
    const ends = [bounds.lateralMin, bounds.lateralMax].map((lateral) => ({ ...flight.target, height: guideHeight, lateral }));
    errorGuide = { ends, min: bounds.lateralMin - flight.target.lateral, max: bounds.lateralMax - flight.target.lateral };
    const width = line(ends[0], ends[1], "cant-target-width back-error-offset");
    width.setAttribute("data-error-min-cm", errorGuide.min * 100);
    width.setAttribute("data-error-max-cm", errorGuide.max * 100);
    width.append(element("title", {}, "Sampled lateral cant error width. This ruler is lowered on the back wall for readability; its height is not an impact height."));
    region.append(width);
    for (const end of ends) {
      const [x, y] = project(end);
      region.append(element("line", { x1: x - 2, x2: x + 2, y1: y - 3.5, y2: y + 3.5, class: "cant-target-width" }));
    }
    chart.append(region);
  }
  chart.append(element("path", { d: path(flight.points), class: "trajectory" }));
  const cone = createDispersionCone(flight.target, coneRadius, layout);
  if (cone) {
    const group = element("g", { class: "dispersion-cone", "data-radius-cm": cone.radius * 100 });
    group.append(element("title", {}, coneDescription));
    group.append(polygon(dispersionConePoints(cone), "dispersion-cone-fill"));
    group.append(element("path", { d: path(dispersionConePoints(cone, 64)) + " Z", class: "dispersion-cone-edge" }));
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
  const wallCenterY = project({ range: options.targetRange, height: (heightMin + heightMax) / 2, lateral: 0 })[1];
  // Four measurement rows now share the gutter, so cap the first row lower.
  const firstRowY = Math.max(84, Math.min(HEIGHT - 126, wallCenterY - 32));
  const readout = element("g", { class: "back-readout", "data-range-m": options.targetRange });
  readout.append(element("title", {}, readoutDescription), element("text", {
    x: READOUT_X, y: firstRowY - 30, class: "back-readout-heading",
  }, `${tick(options.targetRange)} m / BACK WALL`));
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
  return { ...layout, aimReference, visibleReference, planeOffsets, backOffsets, errorGuide };
}
