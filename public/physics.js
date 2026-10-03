// Port of the inspected 120p3 BallisticProjectile free-flight update.
// World coordinates follow Unity: x right, y up, z forward.
export const MODEL = "h3vr-120p3-free-flight";
const f = Math.fround;
const magnitude = (x, y, z) => f(Math.sqrt(f(f(f(x * x) + f(y * y)) + f(z * z))));
const MAX_STEPS = 200000;
const MIN_SPEED = f(0.1);
const DEG = Math.PI / 180;

// FistVR.FVRFireArm::Fire (RVA 428892) spawns each projectile from the current
// muzzle transform displaced by transform.forward * 0.004999999888241291, i.e.
// the projectile starts 5 mm BEHIND the muzzle. Range is measured from the
// optical origin, so the muzzle's effective setback is reduced by that recess.
const SPAWN_RECESS_METRES = f(0.004999999888241291);

// Unity's Random.insideUnitCircle is uniform on the unit disc, so one sample has
// E|v|^2 = 1/2 and the mean of the three samples Fire draws has E|v|^2 = 1/6.
// Used to express the game's own three-sample mean as a fraction of its bound.
const DISPERSION_SAMPLE_RMS = Math.sqrt(1 / 6);

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

// FistVR.FVRFireArm::Fire (RVA 428892) adds one angular dispersion term to the
// launch, built from three components that are all in degrees:
//
//   round.ProjectileSpread + firearm.m_internalMechanicalMOA
//                          + GetCombinedMuzzleDeviceAccuracy()
//
// multiplied by the mean of three Random.insideUnitCircle samples, and applied
// straight into the same Transform.Rotate as the fixed drop and drift bias. Both
// mechanical components are Random.Range(class.MinDegrees, class.MaxDegrees) * 0.5
// (AM::GetFireArmMechanicalSpread, RVA 888235) drawn ONCE when the object spawns
// -- FVRFireArm::Awake (RVA 422720) and MuzzleDevice::Awake (RVA 2418581) -- so
// they are fixed for a session yet not reproducible across sessions. Unlike fixed
// drift, the firearm contributes its mechanical term even with no device fitted.
//
// This model therefore reports the authored bounds of that random draw, never a
// predicted group. minDegrees/maxDegrees bracket it; the upper bound is the
// full-disc radius of Fire's own three-sample mean.
export function dispersion(settings, options, profile) {
  const half = (degrees) => f(f(degrees) * f(0.5));
  const entry = (id) => {
    const value = settings.accuracyClasses?.find((item) => item.id === id);
    if (!value) throw new Error(`No source mechanical-accuracy entry for class ${id}.`);
    return { min: half(value.minDegrees), max: half(value.maxDegrees) };
  };
  // Anything the dataset does not certify is excluded from the bound and named
  // in `missing`, so an understated cone is never presented as a complete one.
  const missing = [];
  const weapon = options.weapon ?? null;
  // Unlike fixed drift, the firearm contributes its mechanical term even with
  // no device fitted, so it matters whenever a weapon is selected at all.
  const firearm = weapon && Number.isInteger(weapon.accuracyClass)
    ? entry(weapon.accuracyClass) : null;
  if (weapon && !firearm) missing.push("selected weapon accuracy class");
  const devices = (options.attachments ?? []).map((device) => {
    if (!device || !Number.isInteger(device.accuracyClass))
      throw new Error(`No verified source accuracy class for ${device?.name ?? "a muzzle device"}.`);
    return entry(device.accuracyClass);
  });
  const sum = (list, key) => list.reduce((total, item) => f(total + item[key]), f(0));
  const roundKnown = Number.isFinite(profile.spreadDegrees) && profile.spreadDegrees >= 0;
  if (!roundKnown) missing.push("round spread");
  const roundDegrees = roundKnown ? profile.spreadDegrees : 0;
  const minDegrees = f(f(roundDegrees) + f(firearm?.min ?? 0) + sum(devices, "min"));
  const maxDegrees = f(f(roundDegrees) + f(firearm?.max ?? 0) + sum(devices, "max"));
  return {
    roundDegrees, roundKnown, firearm, devices, missing,
    minDegrees, maxDegrees,
    // Both are already degrees: a MOA is 1/60 degree, so no radian conversion.
    minMoa: minDegrees * 60, maxMoa: maxDegrees * 60,
    incomplete: missing.length > 0,
    // A per-object random draw, so the group is not predictable from game data.
    reproducible: false,
  };
}

// Lateral/vertical half-extent of the full-disc dispersion bound at a range,
// and the same figure for the expected radius of Fire's three-sample mean.
// Linear in range because the source applies the offset as a launch rotation.
export function dispersionAtRange(model, range) {
  const bound = range * Math.tan(model.maxDegrees * DEG);
  return {
    boundRadius: bound,
    typicalRadius: bound * DISPERSION_SAMPLE_RMS,
    boundDiameter: 2 * bound,
  };
}

function withCant(ctx, degrees) {
  return { ...ctx, cantDegrees: degrees, cantCos: f(Math.cos(degrees * DEG)), cantSin: f(Math.sin(degrees * DEG)) };
}

function context(profile, settings, options) {
  const barrelFactor = evaluateCurve(options.caliber.barrelCurve, f(f(options.barrelLength) * f(39.37009811401367)));
  const muzzleSpeed = f(f(f(f(profile.muzzleVelocity) * f(options.chamberMultiplier)) * f(options.velocityMultiplier)) * barrelFactor);
  if (!(muzzleSpeed > 0) || !Number.isFinite(muzzleSpeed))
    throw new Error("The supplied launch multipliers produce no positive muzzle velocity.");
  const radius = f(f(profile.diameter) * f(0.5));
  return withCant({
    profile, options, dragCurve: settings.dragCurve, barrelFactor, muzzleSpeed,
    effects: muzzleEffects(settings, options),
    inclinationCos: f(Math.cos(options.inclinationDegrees * DEG)),
    inclinationSin: f(Math.sin(options.inclinationDegrees * DEG)),
    area: f(f(Math.PI) * f(Math.pow(radius, 2))),
    density: f(f(1.225000023841858) * f(profile.airDragMultiplier)),
    mass: f(profile.mass), maxDistance: f(Math.min(profile.maxRange, options.sceneLimit)),
    fixedStep: f(options.fixedStep), firstStep: f(options.firstStep),
  }, options.cantMode === "specific" ? options.cantDegrees : 0);
}

function trace(ctx, pitch, yaw, ranges) {
  const { profile: p, options: o } = ctx;
  const cp = f(Math.cos(pitch)), sp = f(Math.sin(pitch));
  const cy = f(Math.cos(yaw)), sy = f(Math.sin(yaw));
  const ci = ctx.inclinationCos, si = ctx.inclinationSin;
  // The optical origin is the pivot. Spawn offset is along the unperturbed muzzle.
  const setback = f(o.sightSetback - SPAWN_RECESS_METRES);
  const muzzleForward = f(f(setback * cp) + f(f(o.sightHeight) * sp));
  const muzzleUp = f(f(setback * sp) - f(f(o.sightHeight) * cp));
  const muzzleAlong = f(muzzleForward * cy);
  const muzzleRight = f(muzzleForward * sy);
  // Positive cant tilts weapon-up toward the shooter's right. Roll the entire
  // muzzle pose around the sight ray, then incline it; gravity stays world-down.
  const spawnRight = ctx.cantDegrees === 0 ? muzzleRight : f(f(muzzleRight * ctx.cantCos) + f(muzzleUp * ctx.cantSin));
  const spawnUp = ctx.cantDegrees === 0 ? muzzleUp : f(f(muzzleUp * ctx.cantCos) - f(muzzleRight * ctx.cantSin));
  let x = spawnRight;
  let y = f(f(muzzleAlong * si) + f(spawnUp * ci));
  let z = f(f(muzzleAlong * ci) - f(spawnUp * si));
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
  const launchRight = ctx.cantDegrees === 0 ? right : f(f(right * ctx.cantCos) + f(up * ctx.cantSin));
  const launchUp = ctx.cantDegrees === 0 ? up : f(f(up * ctx.cantCos) - f(right * ctx.cantSin));
  let vx = f(ctx.muzzleSpeed * launchRight);
  let vy = f(ctx.muzzleSpeed * f(f(along * si) + f(launchUp * ci)));
  let vz = f(ctx.muzzleSpeed * f(f(along * ci) - f(launchUp * si)));
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

// Newton refinement of the 2x2 residual (height, lateral) at the target range.
// Returns the solved angles, or null when it cannot converge inside the
// iteration/angle budget so the caller can fall back to bracketing.
function newtonAim(ctx, range, pitch, yaw) {
  // Inclined shots project single-precision world positions back onto the
  // sight line. Allow for cancellation/quantization at roughly eight float32
  // ULPs of range, rather than demanding a sub-ULP trajectory crossing.
  const tolerance = Math.max(0.000001, range * 0.000001);
  for (let i = 0; i < 8; i++) {
    const sample = atRange(ctx, pitch, yaw, range);
    if (!sample) return null;
    if (Math.abs(sample.height) <= tolerance && Math.abs(sample.lateral) <= tolerance) return { pitch, yaw };
    const delta = 0.0001;
    const raised = atRange(ctx, pitch + delta, yaw, range);
    const turned = atRange(ctx, pitch, yaw + delta, range);
    if (!raised || !turned) return null;
    const a = (raised.height - sample.height) / delta;
    const b = (turned.height - sample.height) / delta;
    const c = (raised.lateral - sample.lateral) / delta;
    const d = (turned.lateral - sample.lateral) / delta;
    const determinant = a * d - b * c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 0.000001) return null;
    pitch += (-sample.height * d + sample.lateral * b) / determinant;
    yaw += (sample.height * c - sample.lateral * a) / determinant;
    if (Math.abs(pitch) > Math.PI / 4 || Math.abs(yaw) > Math.PI / 4) return null;
  }
  return null;
}

// An uncanted aim unit vector expressed in weapon-local pitch/yaw. Exactly the
// inverse of the roll used to seed the coupled canted solve.
function localAim(vector, ctx) {
  const x = vector.x * ctx.cantCos + vector.y * ctx.cantSin;
  const y = vector.y * ctx.cantCos - vector.x * ctx.cantSin;
  return { pitch: Math.atan2(y, Math.hypot(x, vector.z)), yaw: Math.atan2(x, vector.z) };
}

function aimVector(pitch, yaw) {
  return {
    x: Math.cos(pitch) * Math.sin(yaw), y: Math.sin(pitch), z: Math.cos(pitch) * Math.cos(yaw),
  };
}

// `previous` is the solution for the adjacent lower range. Its uncanted aim
// vector is a far better starting estimate than the geometric seed, so a range
// card costs a few Newton traces per row instead of a full bracketing scan.
// Bracketing stays as the fallback, so a warm start can never change which
// solution is found or turn an unsolvable case into a fabricated one.
function solveAim(ctx, range, previous = null) {
  // The vector is a unit aim direction, so only finiteness marks it usable --
  // any integer test would reject every seed carrying a nonzero yaw bias.
  const seeded = previous?.vector;
  const warm = seeded && [seeded.x, seeded.y, seeded.z].every(Number.isFinite)
    ? localAim(seeded, ctx) : null;
  const refined = warm ? newtonAim(ctx, range, warm.pitch, warm.yaw) : null;
  if (refined) return { ...refined, vector: aimVector(refined.pitch, refined.yaw), seeded: true };
  let pitch, yaw, vector;
  if (ctx.cantDegrees !== 0) {
    // A sideways weapon makes pitch-only height bracketing singular. Seed the
    // coupled solver by expressing an uncanted solution in weapon-local axes.
    const seed = solveAim(withCant(ctx, 0), range);
    vector = seed.vector;
    const local = localAim(vector, ctx);
    pitch = local.pitch;
    yaw = local.yaw;
  } else {
    yaw = -ctx.effects.yawDegrees * DEG;
    pitch = solvePitch(ctx, range, yaw);
    vector = aimVector(pitch, yaw);
  }
  const solved = newtonAim(ctx, range, pitch, yaw)
    ?? (() => {
      throw new Error(`No continuous low-angle two-axis firing solution at ${range.toFixed(1)} m.`);
    })();
  return { ...solved, vector: aimVector(solved.pitch, solved.yaw), seeded: false };
}

function validate(profile, options) {
  if (!["none", "specific", "uncertainty"].includes(options.cantMode)) throw new Error("Unknown weapon cant mode.");
  if (!Number.isFinite(options.cantDegrees) || Math.abs(options.cantDegrees) > 90)
    throw new Error("Specific weapon cant must be finite and between -90° and +90°.");
  if (!Number.isFinite(options.cantToleranceDegrees) || options.cantToleranceDegrees < 0 || options.cantToleranceDegrees > 90)
    throw new Error("Cant uncertainty must be finite and between 0° and 90°.");
  if ((options.cantMode !== "specific" && options.cantDegrees !== 0)
    || (options.cantMode !== "uncertainty" && options.cantToleranceDegrees !== 0))
    throw new Error("Specific weapon cant and cant uncertainty are mutually exclusive; inactive angles must be zero.");
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

function cantUncertainty(ctx, aim, plotRanges, nominal) {
  const tolerance = ctx.options.cantToleranceDegrees;
  const angles = tolerance === 0 ? [0] : Array.from({ length: 21 }, (_, i) => tolerance * (i - 10) / 10);
  const ranges = [...new Set([...plotRanges, ctx.options.targetRange])].sort((a, b) => a - b);
  const samples = angles.map((degrees) => {
    if (degrees === 0) return { cantDegrees: 0, points: nominal.points, target: nominal.target, reason: null };
    // Do NOT re-solve for each tilt: uncertainty means the displayed dial
    // settings are held fixed while the weapon accidentally rolls.
    const flight = trace(withCant(ctx, degrees), aim.pitch, aim.yaw, ranges);
    const byRange = new Map(flight.samples.map((point) => [point.range, point]));
    const target = byRange.get(ctx.options.targetRange) ?? null;
    return { cantDegrees: degrees, points: [flight.initial, ...plotRanges.map((range) => byRange.get(range)).filter(Boolean)],
      target, reason: target ? null : flight.reason };
  });
  const missing = samples.filter((sample) => !sample.target);
  const result = { toleranceDegrees: tolerance, boreAngle: aim.pitch, boreYaw: aim.yaw,
    samples, complete: missing.length === 0, sections: [], target: null,
    unreachableAngles: missing.map((sample) => sample.cantDegrees) };
  if (missing.length) return result; // Never present a partial band as bounded uncertainty.
  const maps = samples.map((sample) => new Map(sample.points.slice(1).map((point) => [point.range, point])));
  result.sections = [samples.map((sample) => sample.points[0]),
    ...plotRanges.filter((range) => maps.every((map) => map.has(range))).map((range) => maps.map((map) => map.get(range)))];
  const targets = samples.map((sample) => sample.target);
  result.target = {
    heightMin: Math.min(...targets.map((point) => point.height)), heightMax: Math.max(...targets.map((point) => point.height)),
    lateralMin: Math.min(...targets.map((point) => point.lateral)), lateralMax: Math.max(...targets.map((point) => point.lateral)),
    lateralMinMrad: Math.min(...targets.map((point) => Math.atan2(point.lateral, point.range) * 1000)),
    lateralMaxMrad: Math.max(...targets.map((point) => Math.atan2(point.lateral, point.range) * 1000)),
  };
  return result;
}

const fmtRange = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(2));

// Report ranges in the units the user entered. A horizontal request is solved in
// the along-sight-line range it converts to, and echoing that back would show a
// number they never typed.
function statedRange(options) {
  return Number.isFinite(options.enteredRange) ? options.enteredRange : options.targetRange;
}

export function calculate(profile, settings, options) {
  options = { inclinationDegrees: 0, attachments: [], cantMode: "none", cantDegrees: 0, cantToleranceDegrees: 0, ...options };
  validate(profile, options);
  // Resolve dispersion before integrating anything: an uncertified accuracy
  // class is an input error, and the user should not wait out a full solve to
  // be told about it.
  const spread = dispersion(settings, options, profile);
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
  if (!byRange.has(options.targetRange)) throw new Error(`The current optic setup cannot reach ${fmtRange(statedRange(options))} m. ${flight.reason}`);
  let targetAim;
  // Ascending ranges, each solve seeded from the one below it. The card is the
  // dominant cost of a long calculation, and adjacent rows differ by one table
  // interval, so a chained Newton start converges in a couple of traces.
  const card = [...cardRanges].sort((a, b) => a - b);
  const solvedRows = [];
  // Report how many rows took the warm path. Every row but the first should,
  // and a shortfall means the seed was rejected rather than converged from.
  const solve = { rows: card.length, warmStarted: 0 };
  for (const range of card) {
    const aim = solveAim(ctx, range, solvedRows.at(-1)?.aim ?? null);
    if (aim.seeded) solve.warmStarted += 1;
    solvedRows.push({ range, aim });
  }
  const rows = solvedRows.map(({ range, aim: required }) => {
    const sample = byRange.get(range);
    if (!sample) throw new Error(`No primary-flight sample at ${range.toFixed(1)} m. ${flight.reason}`);
    if (range === options.targetRange) targetAim = required;
    const elevation = required.pitch - boreAngle, windage = required.yaw - boreYaw;
    return { ...sample, elevationMrad: elevation * 1000, elevationMoa: elevation / DEG * 60, windageMrad: windage * 1000, windageMoa: windage / DEG * 60, isTarget: range === options.targetRange, isSetting: range === settingCardRange };
  });
  const points = [flight.initial];
  for (const range of plotRanges) { const sample = byRange.get(range); if (sample) points.push(sample); }
  // Trace the actual solved launch, not a translated copy of the base flight.
  // Keep the original offsets/time and CSV as the pre-correction range card.
  const correctedTrace = trace(ctx, targetAim.pitch, targetAim.yaw, ranges);
  const correctedByRange = new Map(correctedTrace.samples.map((sample) => [sample.range, sample]));
  const correctedTarget = correctedByRange.get(options.targetRange);
  if (!correctedTarget) throw new Error(`The corrected flight cannot reach ${fmtRange(statedRange(options))} m. ${correctedTrace.reason}`);
  const correctedPoints = [correctedTrace.initial];
  for (const range of plotRanges) { const sample = correctedByRange.get(range); if (sample) correctedPoints.push(sample); }
  const correctedFlight = { points: correctedPoints, target: correctedTarget, boreAngle: targetAim.pitch, boreYaw: targetAim.yaw, cantDegrees: ctx.cantDegrees };
  const uncertainty = options.cantMode === "uncertainty" ? cantUncertainty(ctx, targetAim, plotRanges, correctedFlight) : null;
  // The dispersion offset is a launch rotation, so it moves the corrected shot's
  // group as well; measure the reported cone at the corrected impact range.
  const targetSpread = dispersionAtRange(spread, correctedTarget.range);
  for (const row of rows) {
    const at = dispersionAtRange(spread, row.range);
    row.spreadRadius = at.boundRadius;
    row.spreadTypicalRadius = at.typicalRadius;
  }
  return { muzzleSpeed: ctx.muzzleSpeed, barrelFactor: ctx.barrelFactor, boreAngle, boreYaw, authoredDrop, settingRange, muzzleEffects: ctx.effects, target: rows.find((row) => row.isTarget), rows, points, correctedFlight, cantUncertainty: uncertainty, maxDistance: ctx.maxDistance, spread, targetSpread, solve };
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
    ["Weapon cant mode", options.cantMode ?? "none"], ["Specific weapon cant degrees (positive right)", options.cantMode === "specific" ? options.cantDegrees : 0],
    ["Cant tolerance degrees (+/-)", solution.cantUncertainty?.toleranceDegrees ?? 0],
    ["Cant uncertainty complete", solution.cantUncertainty ? solution.cantUncertainty.complete : "not requested"],
    ["Cant uncertainty samples", solution.cantUncertainty?.samples.length ?? 0],
    ["Cant uncertainty interpretation", "Sampled corrected POI envelope about nominal 0-degree cant; nominal dials held fixed; not a statistical confidence interval"],
    ["Cant uncertainty unreachable angles degrees", solution.cantUncertainty?.unreachableAngles.join("; ") ?? ""],
    ["Corrected cant lateral min cm", solution.cantUncertainty?.target ? solution.cantUncertainty.target.lateralMin * 100 : ""],
    ["Corrected cant lateral max cm", solution.cantUncertainty?.target ? solution.cantUncertainty.target.lateralMax * 100 : ""],
    ["Corrected cant lateral min mrad", solution.cantUncertainty?.target?.lateralMinMrad ?? ""],
    ["Corrected cant lateral max mrad", solution.cantUncertainty?.target?.lateralMaxMrad ?? ""],
    ["Corrected cant height min cm", solution.cantUncertainty?.target ? solution.cantUncertainty.target.heightMin * 100 : ""],
    ["Corrected cant height max cm", solution.cantUncertainty?.target ? solution.cantUncertainty.target.heightMax * 100 : ""],
    ["Bore pitch relative to sight degrees", solution.boreAngle / DEG], ["Bore yaw relative to sight degrees", solution.boreYaw / DEG],
    ["Sight height m", options.sightHeight], ["Sight setback m", options.sightSetback], ["Effective chamber-to-muzzle distance m", options.barrelLength],
    ["Chamber multiplier", options.chamberMultiplier], ["Shot multiplier", options.velocityMultiplier],
    ["Fixed drop MOA", solution.muzzleEffects.dropMoa], ["Vertical device drift MOA", solution.muzzleEffects.verticalDriftMoa], ["Horizontal device drift MOA", solution.muzzleEffects.horizontalDriftMoa],
    ["Dispersion round spread degrees", solution.spread.roundDegrees],
    ["Dispersion firearm mechanical min degrees", solution.spread.firearm?.min ?? ""],
    ["Dispersion firearm mechanical max degrees", solution.spread.firearm?.max ?? ""],
    ["Dispersion device mechanical min degrees total", solution.spread.devices.reduce((total, item) => total + item.min, 0)],
    ["Dispersion device mechanical max degrees total", solution.spread.devices.reduce((total, item) => total + item.max, 0)],
    ["Dispersion total min degrees", solution.spread.minDegrees], ["Dispersion total max degrees", solution.spread.maxDegrees],
    ["Dispersion total min MOA", solution.spread.minMoa], ["Dispersion total max MOA", solution.spread.maxMoa],
    ["Dispersion complete", solution.spread.incomplete ? `no: no extracted value for ${solution.spread.missing.join(", ")}, so the bound omits that term` : "yes"],
    ["Dispersion interpretation", "Authored bounds of a per-object random draw made in Awake; not a predicted group and not reproducible across sessions. The three-sample mean used by Fire is bounded by the full-disc figure and has an expected radius of 0.408 of it."],
    ["Dispersion radius at selected range cm", solution.targetSpread.boundRadius * 100],
    ["Dispersion typical radius at selected range cm", solution.targetSpread.typicalRadius * 100],
    ["Projectile spawn recess behind muzzle m", SPAWN_RECESS_METRES],
    ["Ballistic gravity m/s^2", options.gravity], ["Fixed tick s", options.fixedStep], ["First fire tick s", options.firstStep], ["Scene limit m", options.sceneLimit], ["Model", MODEL],
    ["Flight interpretation", "Primary centerline; height/lateral offsets in the unrolled sight frame; positive elevation weapon-up, positive windage weapon-right; corrections solved in both axes"],
  ];
  return metadata.map((row) => row.map(quote).join(",")).join("\r\n") + "\r\n\r\n" +
    "range_m,height_cm,lateral_cm,elevation_mrad,elevation_MOA,windage_mrad,windage_MOA,time_s,velocity_state_m_per_s,dispersion_radius_cm,dispersion_typical_radius_cm\r\n" +
    solution.rows.map((row) => [row.range, row.height * 100, row.lateral * 100, row.elevationMrad, row.elevationMoa, row.windageMrad, row.windageMoa, row.time, row.speed, row.spreadRadius * 100, row.spreadTypicalRadius * 100].join(",")).join("\r\n") + "\r\n";
}
