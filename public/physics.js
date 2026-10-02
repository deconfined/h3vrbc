// Port of the inspected 120p3 BallisticProjectile free-flight update.
// World coordinates follow Unity: x right, y up, z forward.
export const MODEL = "h3vr-120p3-free-flight";
const f = Math.fround;
const magnitude = (x, y, z) => f(Math.sqrt(f(f(f(x * x) + f(y * y)) + f(z * z))));
const MAX_STEPS = 200000;
const MIN_SPEED = f(0.1);
const DEG = Math.PI / 180;

export function evaluateCurve(curve, input) {
  const keys = curve.keys;
  const x = f(input);
  if (x <= keys[0].time) return keys[0].value;
  if (x >= keys.at(-1).time) return keys.at(-1).value;
  let index = 0;
  while (keys[index + 1].time < x) index++;
  const a = keys[index];
  const b = keys[index + 1];
  if (!Number.isFinite(a.outSlope) || !Number.isFinite(b.inSlope))
    return a.value;
  const duration = b.time - a.time;
  const t = (x - a.time) / duration;
  const t2 = t * t;
  const t3 = t2 * t;
  return f(
    (2 * t3 - 3 * t2 + 1) * a.value +
      (t3 - 2 * t2 + t) * duration * a.outSlope +
      (-2 * t3 + 3 * t2) * b.value +
      (t3 - t2) * duration * b.inSlope,
  );
}

function stringHash(value) {
  let first = 352654597;
  let second = first;
  for (let i = 0; i < value.length; i += 2) {
    first = (((first << 5) + first) ^ value.charCodeAt(i)) | 0;
    if (i + 1 < value.length)
      second = (((second << 5) + second) ^ value.charCodeAt(i + 1)) | 0;
  }
  return (first + Math.imul(second, 1566083941)) | 0;
}

function pairHash(first, second) {
  const hash = (Math.imul((17 * 31 + stringHash(first)) | 0, 31) + stringHash(second)) | 0;
  const remainder = ((hash % 10000) + 10000) % 10000;
  return f(remainder / 5000 - 1);
}

export function muzzleEffects(settings, options) {
  const devices = options.attachments;
  if (!devices.length)
    return { dropMoa: 0, verticalDriftMoa: 0, horizontalDriftMoa: 0, pitchDegrees: 0, yawDegrees: 0 };
  const weapon = options.weapon;
  if (!weapon || !weapon.hashId || !Number.isInteger(weapon.accuracyClass))
    throw new Error("Select a weapon with verified identity and accuracy data before adding muzzle devices.");
  const entry = (id) => {
    const value = settings.accuracyClasses.find((item) => item.id === id);
    if (!value) throw new Error(`No source mechanical-accuracy entry for class ${id}.`);
    return value;
  };
  const weaponEntry = entry(weapon.accuracyClass);
  // DefaultMuzzleState only supplies a fallback when the registered list is EMPTY.
  // With devices, native attachment interfaces establish suppression/braking.
  const damped = devices.some((item) => item.kind === "suppressor" || item.kind === "brake");
  let product = damped ? f(weaponEntry.dropMult) : 1;
  for (const device of devices) {
    if (!device.hashId) throw new Error(`No verified source hash identity for ${device.name}.`);
    product = f(product * f(entry(device.accuracyClass).dropMult));
  }
  const dropMoa = Math.max(0, Math.min(product, f(product - 1)));
  const last = devices.at(-1);
  const deviceDrift = f(entry(last.accuracyClass).driftMult);
  const weaponDrift = f(damped ? weaponEntry.driftMult : 1);
  const horizontalDriftMoa = f(weaponDrift * f(pairHash(last.hashId, weapon.hashId) * deviceDrift));
  const verticalDriftMoa = f(weaponDrift * f(pairHash(weapon.hashId, last.hashId) * deviceDrift));
  const pitchDegrees = f(f(dropMoa * f(0.016666699200868607)) + f(verticalDriftMoa * f(0.016666699200868607)));
  const yawDegrees = f(horizontalDriftMoa * f(0.016666699200868607));
  return { dropMoa, verticalDriftMoa, horizontalDriftMoa, pitchDegrees, yawDegrees };
}

function context(profile, settings, options) {
  const barrelFactor = evaluateCurve(options.caliber.barrelCurve, f(f(options.barrelLength) * f(39.37009811401367)));
  const muzzleSpeed = f(f(f(f(profile.muzzleVelocity) * f(options.chamberMultiplier)) * f(options.velocityMultiplier)) * barrelFactor);
  if (!(muzzleSpeed > 0) || !Number.isFinite(muzzleSpeed))
    throw new Error("The supplied launch multipliers produce no positive muzzle velocity.");
  const radius = f(f(profile.diameter) * f(0.5));
  return {
    profile, options, dragCurve: settings.dragCurve, barrelFactor, muzzleSpeed,
    effects: muzzleEffects(settings, options),
    inclinationCos: f(Math.cos(options.inclinationDegrees * DEG)),
    inclinationSin: f(Math.sin(options.inclinationDegrees * DEG)),
    area: f(f(Math.PI) * f(Math.pow(radius, 2))),
    density: f(f(1.225000023841858) * f(profile.airDragMultiplier)),
    mass: f(profile.mass), maxDistance: f(Math.min(profile.maxRange, options.sceneLimit)),
    fixedStep: f(options.fixedStep), firstStep: f(options.firstStep),
  };
}

function trace(ctx, pitch, yaw, ranges) {
  const { profile: p, options: o } = ctx;
  const cp = f(Math.cos(pitch)), sp = f(Math.sin(pitch));
  const cy = f(Math.cos(yaw)), sy = f(Math.sin(yaw));
  const ci = ctx.inclinationCos, si = ctx.inclinationSin;
  // The optical origin is the pivot. Spawn offset is along the unperturbed muzzle.
  const muzzleForward = f(f(f(o.sightSetback - f(0.005)) * cp) + f(f(o.sightHeight) * sp));
  const muzzleUp = f(f(f(o.sightSetback - f(0.005)) * sp) - f(f(o.sightHeight) * cp));
  const muzzleAlong = f(muzzleForward * cy);
  let x = f(muzzleForward * sy);
  let y = f(f(muzzleAlong * si) + f(muzzleUp * ci));
  let z = f(f(muzzleAlong * ci) - f(muzzleUp * si));
  // Transform.Rotate uses local Euler(x=downward bias,y=rightward bias,z=0).
  const cd = f(Math.cos(ctx.effects.pitchDegrees * DEG));
  const sd = f(Math.sin(ctx.effects.pitchDegrees * DEG));
  const cw = f(Math.cos(ctx.effects.yawDegrees * DEG));
  const sw = f(Math.sin(ctx.effects.yawDegrees * DEG));
  const baseForward = f(f(cp * f(cd * cw)) + f(sp * sd));
  const up = f(f(sp * f(cd * cw)) - f(cp * sd));
  const baseRight = f(cd * sw);
  const along = f(f(baseForward * cy) - f(baseRight * sy));
  const right = f(f(baseRight * cy) + f(baseForward * sy));
  let vx = f(ctx.muzzleSpeed * right);
  let vy = f(ctx.muzzleSpeed * f(f(along * si) + f(up * ci)));
  let vz = f(ctx.muzzleSpeed * f(f(along * ci) - f(up * si)));
  const projectedRange = () => f(f(z * ci) + f(y * si));
  const projectedHeight = () => f(f(y * ci) - f(z * si));
  let distance = 0, time = 0, index = 0, moving = true;
  const samples = [];
  const initial = { range: projectedRange(), height: projectedHeight(), lateral: x, time: 0, speed: ctx.muzzleSpeed };
  let reason = "Simulation step limit exceeded; use a faster or shorter direct-flight setup.";
  for (let step = 0; step < MAX_STEPS && moving && index < ranges.length; step++) {
    const dt = step === 0 ? ctx.firstStep : ctx.fixedStep;
    const oldX = x, oldY = y, oldZ = z;
    const oldRange = projectedRange(), oldHeight = projectedHeight();
    const speedBefore = magnitude(vx, vy, vz);
    if (speedBefore < MIN_SPEED || f(o.worldHeight + y) < -350) {
      moving = false;
      reason = "Projectile stopped at its speed or world-height boundary.";
    } else {
      vy = f(vy + f(f(f(-f(o.gravity)) * dt) * f(p.gravityMultiplier)));
      const speed = magnitude(vx, vy, vz);
      const nx = speed > 0.00001 ? f(vx / speed) : 0;
      const ny = speed > 0.00001 ? f(vy / speed) : 0;
      const nz = speed > 0.00001 ? f(vz / speed) : 0;
      const cd = evaluateCurve(ctx.dragCurve, f(speed * f(0.002915449906140566)));
      const dragFactor = f(f(f(f(ctx.density * f(0.5)) * cd) * ctx.area) / ctx.mass);
      const dx = f(f(-vx * dragFactor) * speed);
      const dy = f(f(-vy * dragFactor) * speed);
      const dz = f(f(-vz * dragFactor) * speed);
      const remaining = Math.max(0, Math.min(speed, f(speed - f(magnitude(dx, dy, dz) * dt))));
      vx = f(nx * remaining); vy = f(ny * remaining); vz = f(nz * remaining);
    }
    if ((vy < 0 && p.deletesOnStraightDown && magnitude(vx, 0, vz) < MIN_SPEED && f(o.worldHeight + y) < o.catchHeight) || f(o.worldHeight + y) < -350) {
      reason = "Projectile reached its scene catch-height or world-height boundary.";
      break;
    }
    x = f(x + f(f(vx * dt) * f(p.flightVelocityMultiplier)));
    y = f(y + f(f(vy * dt) * f(p.flightVelocityMultiplier)));
    z = f(z + f(f(vz * dt) * f(p.flightVelocityMultiplier)));
    distance = f(distance + magnitude(f(x - oldX), f(y - oldY), f(z - oldZ)));
    const rangeNow = projectedRange(), heightNow = projectedHeight();
    while (index < ranges.length && ranges[index] <= rangeNow) {
      const range = ranges[index++];
      if (range < oldRange || rangeNow === oldRange) continue;
      const fraction = (range - oldRange) / (rangeNow - oldRange);
      samples.push({ range, height: f(oldHeight + (heightNow - oldHeight) * fraction), lateral: f(oldX + (x - oldX) * fraction), time: time + dt * fraction, speed: magnitude(vx, vy, vz) });
    }
    time += dt;
    // Random extension uses its minimum; Fire is not range-clipped mid-tick.
    if (step > 0 && distance > ctx.maxDistance) {
      moving = false;
      reason = "Projectile exceeded the travelled-range limit (including the final full tick).";
    }
    if (step > 0 && (rangeNow <= oldRange || f(f(vz * ci) + f(vy * si)) <= 0)) {
      moving = false;
      reason = "Projectile no longer advances toward the target.";
    }
  }
  return { samples, initial, endpoint: { range: projectedRange(), height: projectedHeight(), lateral: x, time, speed: magnitude(vx, vy, vz) }, reason };
}

function atRange(ctx, pitch, yaw, range) {
  return trace(ctx, pitch, yaw, [range]).samples[0] ?? null;
}

function solvePitch(ctx, range, yaw) {
  const seed = Math.atan2(ctx.options.sightHeight, range + ctx.options.sightSetback) + ctx.effects.pitchDegrees * DEG;
  const limit = Math.PI / 4;
  let previousAngle = Math.max(-limit, Math.min(limit, seed));
  let previous = atRange(ctx, previousAngle, yaw, range);
  if (!previous) throw new Error(`No reachable low-angle firing solution at ${range.toFixed(1)} m with these projectile and scene limits.`);
  if (Math.abs(previous.height) < 0.0000001) return previousAngle;
  const sign = previous.height < 0 ? 1 : -1;
  let step = 0.001;
  while (step <= Math.PI / 2) {
    const angle = Math.max(-limit, Math.min(limit, seed + sign * step));
    const sample = atRange(ctx, angle, yaw, range);
    if (sample && (sample.height >= 0) !== (previous.height >= 0)) {
      let low = Math.min(previousAngle, angle), high = Math.max(previousAngle, angle);
      for (let i = 0; i < 28; i++) {
        const middle = (low + high) / 2;
        const current = atRange(ctx, middle, yaw, range);
        if (!current) throw new Error(`No continuous direct-flight solution at ${range.toFixed(1)} m.`);
        if (current.height >= 0) high = middle; else low = middle;
      }
      return (low + high) / 2;
    }
    if (sample) { previousAngle = angle; previous = sample; }
    if (Math.abs(angle) === limit) break;
    step *= 2;
  }
  throw new Error(`No reachable low-angle firing solution at ${range.toFixed(1)} m with these projectile and scene limits.`);
}

function solveAim(ctx, range) {
  let yaw = -ctx.effects.yawDegrees * DEG;
  let pitch = solvePitch(ctx, range, yaw);
  // Inclined shots project single-precision world positions back onto the
  // sight line. Allow for cancellation/quantization at roughly eight float32
  // ULPs of range, rather than demanding a sub-ULP trajectory crossing.
  const tolerance = Math.max(0.000001, range * 0.000001);
  for (let i = 0; i < 8; i++) {
    const sample = atRange(ctx, pitch, yaw, range);
    if (!sample) break;
    if (Math.abs(sample.height) <= tolerance && Math.abs(sample.lateral) <= tolerance) return { pitch, yaw };
    const delta = 0.0001;
    const raised = atRange(ctx, pitch + delta, yaw, range);
    const turned = atRange(ctx, pitch, yaw + delta, range);
    if (!raised || !turned) break;
    const a = (raised.height - sample.height) / delta;
    const b = (turned.height - sample.height) / delta;
    const c = (raised.lateral - sample.lateral) / delta;
    const d = (turned.lateral - sample.lateral) / delta;
    const determinant = a * d - b * c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 0.000001) break;
    pitch += (-sample.height * d + sample.lateral * b) / determinant;
    yaw += (sample.height * c - sample.lateral * a) / determinant;
    if (Math.abs(pitch) > Math.PI / 4 || Math.abs(yaw) > Math.PI / 4) break;
  }
  throw new Error(`No continuous low-angle two-axis firing solution at ${range.toFixed(1)} m.`);
}

function validate(profile, options) {
  for (const key of ["zeroRange", "targetRange", "rangeStep", "velocityMultiplier", "chamberMultiplier", "fixedStep", "sceneLimit"])
    if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`${key} must be positive and finite.`);
  for (const key of ["barrelLength", "sightHeight", "firstStep", "gravity"])
    if (!Number.isFinite(options[key]) || options[key] < 0) throw new Error(`${key} must be nonnegative and finite.`);
  for (const key of ["sightSetback", "worldHeight", "catchHeight", "inclinationDegrees"])
    if (!Number.isFinite(options[key])) throw new Error(`${key} must be finite.`);
  if (Math.abs(options.inclinationDegrees) > 90) throw new Error("Sight-line inclination must be between -90° and +90°.");
  if (!Array.isArray(options.attachments)) throw new Error("An ordered muzzle-device list is required.");
  if (options.zeroRange + options.sightSetback <= 0) throw new Error("The sight must be behind its nominal zero target.");
  if (!["game", "geometric", "unadjusted", "calculated"].includes(options.zeroModel)) throw new Error("Unknown sight zeroing rule.");
  if (!(profile.mass > 0) || !(profile.diameter > 0) || !(profile.flightVelocityMultiplier > 0)) throw new Error("This projectile has no supported positive mass, diameter or flight multiplier.");
  if (Math.ceil(options.targetRange / options.rangeStep) > 300) throw new Error("Range card is limited to 300 intervals. Increase the table interval.");
}

export function calculate(profile, settings, options) {
  options = { inclinationDegrees: 0, attachments: [], ...options };
  validate(profile, options);
  const ctx = context(profile, settings, options);
  const authoredDrop = options.zeroModel === "game" ? evaluateCurve(options.caliber.opticDropCurve, f(f(options.zeroRange) * f(0.0010000000474974513))) : 0;
  const mathematical = options.zeroModel === "calculated" ? solveAim(ctx, options.zeroRange) : null;
  const boreAngle = mathematical ? mathematical.pitch : options.zeroModel === "unadjusted" ? 0 : Math.atan2(options.sightHeight - authoredDrop, options.zeroRange + options.sightSetback);
  const boreYaw = mathematical ? mathematical.yaw : 0;
  const settingRange = options.zeroModel === "unadjusted" ? null : mathematical ? options.zeroRange : Math.hypot(options.zeroRange + options.sightSetback, authoredDrop - options.sightHeight);
  const cardRanges = new Set([options.targetRange]);
  for (let range = options.rangeStep; range < options.targetRange; range += options.rangeStep) cardRanges.add(range);
  let settingCardRange = null;
  if (settingRange !== null && settingRange <= options.targetRange) {
    for (const range of cardRanges) if (Math.abs(range - settingRange) < 0.005) settingCardRange = range;
    if (settingCardRange === null) { settingCardRange = settingRange; cardRanges.add(settingRange); }
  }
  const plotRanges = Array.from({ length: 200 }, (_, i) => (options.targetRange * (i + 1)) / 200);
  const ranges = [...new Set([...cardRanges, ...plotRanges])].sort((a, b) => a - b);
  const flight = trace(ctx, boreAngle, boreYaw, ranges);
  const byRange = new Map(flight.samples.map((sample) => [sample.range, sample]));
  if (!byRange.has(options.targetRange)) throw new Error(`The current optic setup cannot reach ${options.targetRange} m. ${flight.reason}`);
  const rows = [...cardRanges].sort((a, b) => a - b).map((range) => {
    const sample = byRange.get(range);
    if (!sample) throw new Error(`No primary-flight sample at ${range.toFixed(1)} m. ${flight.reason}`);
    const required = solveAim(ctx, range);
    const elevation = required.pitch - boreAngle, windage = required.yaw - boreYaw;
    return { ...sample, elevationMrad: elevation * 1000, elevationMoa: elevation / DEG * 60, windageMrad: windage * 1000, windageMoa: windage / DEG * 60, isTarget: range === options.targetRange, isSetting: range === settingCardRange };
  });
  const points = [flight.initial];
  for (const range of plotRanges) { const sample = byRange.get(range); if (sample) points.push(sample); }
  return { muzzleSpeed: ctx.muzzleSpeed, barrelFactor: ctx.barrelFactor, boreAngle, boreYaw, authoredDrop, settingRange, muzzleEffects: ctx.effects, target: rows.find((row) => row.isTarget), rows, points, maxDistance: ctx.maxDistance };
}

export function toCSV(solution, profile, options) {
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const metadata = [
    ["Round", profile.name], ["Round ID", profile.id], ["Weapon", options.weapon?.name ?? "Manual"],
    ["Weapon hash ID", options.weapon?.hashId ?? ""], ["Chamber / barrel", options.chamber?.name ?? "Manual"],
    ["Optic", options.optic?.name ?? "Manual"], ["Optic attachment ID", options.optic?.attachmentId ?? ""],
    ["Optic view", options.optic?.componentClass ?? ""], ["Optic direct mount", options.opticMount?.name ?? ""],
    ["Optic rail position percent (50 assumes midpoint)", options.opticRailPosition == null ? "" : options.opticRailPosition * 100],
    ["Sight geometry", options.sightGeometryMode ?? "User-entered sight geometry"],
    ["Muzzle devices in registration order", (options.attachments ?? []).map((item) => item.id).join("; ")],
    ["Muzzle geometry", options.muzzleGeometryMode ?? "User-entered effective geometry"],
    ["Mounted muzzle forward shift m", options.muzzleForwardShift ?? (options.attachments?.length ? "" : 0)],
    ["Mounted muzzle up shift m", options.muzzleUpShift ?? (options.attachments?.length ? "" : 0)],
    ["Zero model", options.zeroModel], ["Optic setting m", options.zeroRange],
    ["Sight-line inclination degrees", options.inclinationDegrees ?? 0], ["Range interpretation", "Distance along line of sight from optical origin"],
    ["Bore pitch relative to sight degrees", solution.boreAngle / DEG], ["Bore yaw relative to sight degrees", solution.boreYaw / DEG],
    ["Sight height m", options.sightHeight], ["Sight setback m", options.sightSetback], ["Effective chamber-to-muzzle distance m", options.barrelLength],
    ["Chamber multiplier", options.chamberMultiplier], ["Shot multiplier", options.velocityMultiplier],
    ["Fixed drop MOA", solution.muzzleEffects.dropMoa], ["Vertical device drift MOA", solution.muzzleEffects.verticalDriftMoa], ["Horizontal device drift MOA", solution.muzzleEffects.horizontalDriftMoa],
    ["Ballistic gravity m/s^2", options.gravity], ["Fixed tick s", options.fixedStep], ["First fire tick s", options.firstStep], ["Scene limit m", options.sceneLimit], ["Model", MODEL],
    ["Flight interpretation", "Primary centerline; height/lateral offsets from sight line; positive elevation up, positive windage right; corrections solved in both axes"],
  ];
  return metadata.map((row) => row.map(quote).join(",")).join("\r\n") + "\r\n\r\n" +
    "range_m,height_cm,lateral_cm,elevation_mrad,elevation_MOA,windage_mrad,windage_MOA,time_s,velocity_state_m_per_s\r\n" +
    solution.rows.map((row) => [row.range, row.height * 100, row.lateral * 100, row.elevationMrad, row.elevationMoa, row.windageMrad, row.windageMoa, row.time, row.speed].join(",")).join("\r\n") + "\r\n";
}
