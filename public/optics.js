// Forward-facing, direct stock mounting; midpoint is the editable rail default.
export function searchOptics(optics, query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return optics.filter((optic) => {
    const text = `${optic.name} ${optic.attachmentId} ${optic.kind} ${optic.componentClass} ${optic.mountTypeName}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function compatibleOpticMounts(weapon, optic) {
  return (weapon?.sightMounts ?? []).map((mount, index) => ({ mount, index }))
    .filter(({ mount }) => optic && mount.type === optic.mountType);
}

const TOLERANCE = 0.00001;
const vector = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const subtract = (a, b) => a.map((value, i) => value - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unitScale = (pose) => vector(pose?.scale) && pose.scale.every((value) => Math.abs(value - 1) < TOLERANCE);

function frame(pose) {
  if (!vector(pose?.position) || !vector(pose?.forward) || !vector(pose?.up)
    || Math.abs(dot(pose.forward, pose.forward) - 1) > TOLERANCE
    || Math.abs(dot(pose.up, pose.up) - 1) > TOLERANCE
    || Math.abs(dot(pose.forward, pose.up)) > TOLERANCE)
    throw new Error("Missing or non-orthogonal optic/mount pose. Regenerate the dataset if needed.");
  return [cross(pose.up, pose.forward), pose.up, pose.forward];
}
const direction = (axes, local) => local.map((_, i) => axes.reduce((sum, axis, j) => sum + axis[i] * local[j], 0));

export function slidingOpticMount(mount) {
  return vector(mount?.front) && vector(mount?.rear)
    && Math.hypot(...subtract(mount.front, mount.rear)) > TOLERANCE;
}

export function opticGeometry(weapon, chamber, optic, mount, railPosition = 0.5) {
  try {
    if (!optic) throw new Error("Select an optic or enter sight geometry manually.");
    if (optic.geometryUnavailable) throw new Error(optic.geometryUnavailable);
    if (!weapon || !chamber) throw new Error("Select a weapon and chamber to derive bare-muzzle sight geometry.");
    const muzzle = Object.hasOwn(chamber, "muzzlePose") ? chamber.muzzlePose
      : weapon.chambers?.length === 1 ? weapon.muzzlePose : null;
    const bore = frame(muzzle);
    if (!mount || !Number.isInteger(optic.mountType) || mount.type !== optic.mountType)
      throw new Error("No selected direct mount of the optic's type. Adapters and risers require manual geometry.");
    if (typeof mount.parentToThis !== "boolean" || !unitScale(mount.parentToThis ? mount.pose : mount.parentPose))
      throw new Error("Unknown or scaled mounting parent requires manual sight geometry.");
    if (!unitScale(optic.rootPose) || !optic.opticalPose)
      throw new Error("Missing or scaled source optic geometry requires manual measurements.");
    frame(optic.rootPose);
    const optical = frame(optic.opticalPose);
    const axes = frame(mount.pose);
    if (!vector(mount.front) || !vector(mount.rear))
      throw new Error("Missing source rail endpoints.");
    if (typeof optic.canScaleToMount !== "boolean" || typeof optic.bidirectional !== "boolean")
      throw new Error("No verified optic scaling/orientation rules.");
    const sliding = slidingOpticMount(mount);
    if (sliding && (!Number.isFinite(railPosition) || railPosition < 0 || railPosition > 1))
      throw new Error("Enter the rail position: 0% is rear, 100% is front; 50% assumes the midpoint.");
    const scale = optic.canScaleToMount ? mount.scaleModifier : 1;
    if (!(scale > 0) || !Number.isFinite(scale)) throw new Error("No positive source mount scale modifier.");
    const fraction = sliding ? railPosition : 0;
    const position = mount.rear.map((value, i) => value + (mount.front[i] - value) * fraction);
    // PIP ZeroToWorldPoint adds its camera offset in world metres. The
    // authored camera position scales with the attachment, but this scalar
    // does not. The extracted opticalPose already includes it at unit scale.
    const cameraOffset = optic.cameraOffsetRearLens ?? 0;
    if (!Number.isFinite(cameraOffset)) throw new Error("Invalid source camera offset.");
    const offset = direction(axes, optic.opticalPose.position.map((value, i) =>
      value * scale + optic.opticalPose.forward[i] * cameraOffset * (1 - scale)));
    const origin = position.map((value, i) => value + offset[i]);
    if (dot(direction(axes, optical[2]), bore[2]) < 1 - TOLERANCE
      || dot(direction(axes, optical[1]), bore[1]) < 1 - TOLERANCE)
      throw new Error("Canted, reversed or non-bore-aligned optics require a model beyond this centered sight geometry.");
    const delta = subtract(origin, muzzle.position);
    const lateral = dot(delta, bore[0]);
    if (Math.abs(lateral) > TOLERANCE)
      throw new Error(`Optical origin is ${(lateral * 100).toFixed(3)} cm off-axis; this centered model cannot reproduce lateral sight offset.`);
    const sightHeight = dot(delta, bore[1]);
    if (sightHeight < 0) throw new Error("An optical origin below the bore is outside the supported sight-height inputs.");
    return { sightHeight, sightSetback: -dot(delta, bore[2]), reason: null };
  } catch (error) {
    return { sightHeight: null, sightSetback: null, reason: error.message };
  }
}
