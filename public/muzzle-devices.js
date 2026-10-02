// Catalog discovery and certified stock mount composition, not a live-VR pose.
export const deviceKindLabel = (device) =>
  device.kind === "suppressor" ? "Suppressor" : device.kind === "brake" ? "Brake / compensator" : "Other muzzle device";

export function searchMuzzleDevices(devices, settings, query, kind = "") {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return devices.filter((device) => {
    const accuracy = settings.accuracyClasses?.find((item) => item.id === device.accuracyClass);
    const text = `${device.name} ${device.id} ${deviceKindLabel(device)} ${device.componentClass} ${accuracy?.name ?? ""}`.toLowerCase();
    return (!kind || device.kind === kind) && terms.every((term) => text.includes(term));
  });
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
    throw new Error("Missing or non-orthogonal source mount pose.");
  return [cross(pose.up, pose.forward), pose.up, pose.forward];
}
const direction = (axes, local) => local.map((_, i) => axes.reduce((sum, axis, j) => sum + axis[i] * local[j], 0));
const point = (pose, local) => direction(frame(pose), local.map((value, i) => value * pose.scale[i])).map((value, i) => value + pose.position[i]);
const localPoint = (pose, position) => frame(pose).map((axis, i) => dot(subtract(position, pose.position), axis) / pose.scale[i]);

function moveMount(mount, originalRoot, mountedRoot) {
  const rotate = (value) => direction(frame(mountedRoot), frame(originalRoot).map((axis) => dot(value, axis)));
  return {
    ...mount,
    front: point(mountedRoot, localPoint(originalRoot, mount.front)),
    rear: point(mountedRoot, localPoint(originalRoot, mount.rear)),
    pose: { ...mount.pose, position: point(mountedRoot, localPoint(originalRoot, mount.pose.position)),
      forward: rotate(mount.pose.forward), up: rotate(mount.pose.up) },
  };
}

export function muzzleGeometry(weapon, chamber, devices) {
  try {
    if (!devices.length)
      return { barrelLength: chamber?.barrelLength ?? null, forwardShift: 0, upShift: 0, reason: null };
    if (!weapon || weapon.chambers?.length !== 1 || !vector(chamber?.position))
      throw new Error("Automatic device geometry requires a verified single-barrel weapon and chamber position.");
    const bore = frame(weapon.muzzlePose);
    if (weapon.muzzleMounts?.length !== 1)
      throw new Error("No unique stock muzzle mount; physical compatibility is not verified.");
    const rootMount = weapon.muzzleMounts[0];
    if (typeof rootMount.parentToThis !== "boolean")
      throw new Error("No verified mounting parent rule.");
    const parentPose = rootMount.parentToThis ? rootMount.pose : rootMount.parentPose;
    if (!unitScale(parentPose))
      throw new Error("Scaled mounting parent requires measured geometry.");
    if (!(rootMount.scaleModifier > 0) || !Number.isFinite(rootMount.scaleModifier))
      throw new Error("No positive source mount scale modifier.");
    let mount = rootMount;
    let muzzle;
    for (let i = 0; i < devices.length; i++) {
      const device = devices[i];
      const axes = frame(mount.pose);
      if (!vector(mount.front) || !vector(mount.rear) || Math.hypot(...subtract(mount.front, mount.rear)) > TOLERANCE)
        throw new Error("Sliding muzzle mount requires its live attachment position.");
      if (!unitScale(device.rootPose) || !vector(device.muzzleOffset) || !vector(device.muzzleForward) || !vector(device.muzzleUp))
        throw new Error(`Missing or scaled source muzzle geometry for ${device.name}. Regenerate the dataset if needed.`);
      if (typeof device.canScaleToMount !== "boolean" || typeof device.bidirectional !== "boolean")
        throw new Error(`No verified scaling/orientation rules for ${device.name}.`);
      frame(device.rootPose);
      const muzzleAxes = frame({ position: [0, 0, 0], forward: device.muzzleForward, up: device.muzzleUp });
      if (device.bidirectional)
        throw new Error(`${device.name} has reversible mounting; its live orientation must be verified.`);
      // AttachToMount aligns the attachment ROOT, not the interface transform.
      // ScaleToMount uses GetRootMount().ScaleModifier, including on submounts.
      const scale = device.canScaleToMount ? rootMount.scaleModifier : 1;
      const mounted = { position: mount.front, forward: axes[2], up: axes[1], scale: [scale, scale, scale] };
      const forward = direction(axes, muzzleAxes[2]);
      const up = direction(axes, muzzleAxes[1]);
      if (dot(forward, bore[2]) < 1 - TOLERANCE || dot(up, bore[1]) < 1 - TOLERANCE)
        throw new Error("Mounted muzzle is not forward/bore-aligned; this centerline model cannot reproduce its orientation.");
      muzzle = point(mounted, device.muzzleOffset);
      if (i < devices.length - 1) {
        if (device.muzzleMounts?.length !== 1 || device.muzzleMounts[0].followsRootParent !== true)
          throw new Error(`${device.name} has no verified forward submount for the next device.`);
        mount = moveMount(device.muzzleMounts[0], device.rootPose, mounted);
      }
    }
    const shift = subtract(muzzle, weapon.muzzlePose.position);
    if (Math.abs(dot(shift, bore[0])) > TOLERANCE)
      throw new Error("Off-axis mounting requires lateral geometry not supported by this centered model.");
    return { barrelLength: Math.hypot(...subtract(muzzle, chamber.position)),
      forwardShift: dot(shift, bore[2]), upShift: dot(shift, bore[1]), reason: null };
  } catch (error) {
    return { barrelLength: null, forwardShift: null, upShift: null, reason: error.message };
  }
}
