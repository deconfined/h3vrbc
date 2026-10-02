import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { muzzleEffects } from "../public/physics.js";
import { muzzleGeometry, searchMuzzleDevices } from "../public/muzzle-devices.js";

const pose = (position = [0, 0, 0], scale = [1, 1, 1], forward = [0, 0, 1]) => ({ position, scale, forward, up: [0, 1, 0] });
const mount = (position, extra = {}) => ({ front: position, rear: [...position], pose: pose(position), parentPose: pose(), parentToThis: false, scaleModifier: 1, ...extra });
const chamber = { position: [0, 0, 0], barrelLength: 1 };
const weapon = { chambers: [chamber], muzzlePose: pose([0, 0, 1]), muzzleMounts: [mount([0, 0, 0.9])] };
const device = { id: "Suppressor", name: "Test Suppressor", kind: "suppressor", componentClass: "Suppressor", accuracyClass: 100,
  rootPose: pose(), muzzleOffset: [0, 0, 0.2], muzzleForward: [0, 0, 1], muzzleUp: [0, 1, 0],
  canScaleToMount: true, bidirectional: false, muzzleMounts: [] };
const close = (actual, expected, tolerance = 0.0000001) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test("device search covers names, IDs, type and accuracy class, with independent type filters", () => {
  const devices = [device, { ...device, id: "Extension", name: "Long Tube", kind: "device", componentClass: "MuzzleDevice", accuracyClass: 122 },
    { ...device, id: "Cobra", name: "Cobra Compensator", kind: "brake", componentClass: "MuzzleBrake", accuracyClass: 110 }];
  const settings = { accuracyClasses: [{ id: 100, name: "SuppressorPrecision" }, { id: 122, name: "BarrelExtensionLong" }, { id: 110, name: "MuzzleBrakeWeak" }] };
  assert.deepEqual(searchMuzzleDevices(devices, settings, "PRECISION test"), [device]);
  assert.equal(searchMuzzleDevices(devices, settings, "extension")[0].id, "Extension");
  assert.equal(searchMuzzleDevices(devices, settings, "", "brake")[0].id, "Cobra");
  assert.deepEqual(searchMuzzleDevices(devices, settings, "suppressor", "brake"), []);
  assert.equal(searchMuzzleDevices(devices, settings, "unknown").length, 0);
  assert.equal(searchMuzzleDevices(devices, settings, "").length, 3);
});

test("stock mounting uses the mount root and new muzzle, not bare length plus device length", () => {
  const before = JSON.stringify({ weapon, device });
  const result = muzzleGeometry(weapon, chamber, [device]);
  assert.equal(result.reason, null);
  close(result.barrelLength, 1.1);
  close(result.forwardShift, 0.1);
  close(result.upShift, 0);
  assert.notEqual(result.barrelLength, chamber.barrelLength + device.muzzleOffset[2]);
  assert.equal(JSON.stringify({ weapon, device }), before, "Composition must not mutate source profiles");
  assert.deepEqual(muzzleGeometry(weapon, chamber, []), { barrelLength: 1, forwardShift: 0, upShift: 0, reason: null });
});

test("root scale modifier, non-scalable devices and vertical offsets affect actual muzzle geometry", () => {
  const scaledWeapon = { ...weapon, muzzleMounts: [mount([0, 0, 0.9], { scaleModifier: 1.5 })] };
  const vertical = { ...device, muzzleOffset: [0, -0.01, 0.2] };
  const scaled = muzzleGeometry(scaledWeapon, chamber, [vertical]);
  close(scaled.forwardShift, 0.2);
  close(scaled.upShift, -0.015);
  close(scaled.barrelLength, Math.hypot(1.2, 0.015));
  const unscaled = muzzleGeometry(scaledWeapon, chamber, [{ ...vertical, canScaleToMount: false }]);
  close(unscaled.forwardShift, 0.1);
  close(unscaled.upShift, -0.01);
});

test("submounts are moved from their authored root frame and use the root mount's scale, not their own modifier", () => {
  const scaledWeapon = { ...weapon, muzzleMounts: [mount([0, 0, 0.9], { scaleModifier: 1.4 })] };
  const original = pose([10, 4, 1], [1, 1, 1], [1, 0, 0]);
  const extension = { ...device, name: "Extender", kind: "device", rootPose: original,
    muzzleMounts: [mount([10.3, 4, 1], { pose: pose([10.3, 4, 1], [1, 1, 1], [1, 0, 0]),
      scaleModifier: 0.01, followsRootParent: true })] };
  const result = muzzleGeometry(scaledWeapon, chamber, [extension, device]);
  assert.equal(result.reason, null);
  close(result.barrelLength, 1.6);
  close(result.forwardShift, 0.6);
  close(result.upShift, 0);
  assert.match(muzzleGeometry(weapon, chamber, [device, extension]).reason, /no verified forward submount/);
});

test("unknown, sliding, reversible, off-axis and non-aligned mounts never get guessed geometry", () => {
  const cases = [
    [null, device, /verified single-barrel/],
    [{ ...weapon, chambers: [chamber, chamber] }, device, /single-barrel/],
    [{ ...weapon, muzzleMounts: [] }, device, /unique stock muzzle mount/],
    [{ ...weapon, muzzleMounts: [mount([0, 0, 0.9], { rear: [0, 0, 0.8] })] }, device, /Sliding/],
    [{ ...weapon, muzzleMounts: [mount([0, 0, 0.9], { parentPose: pose([0, 0, 0], [2, 2, 2]) })] }, device, /Scaled mounting parent/],
    [{ ...weapon, muzzleMounts: [mount([0, 0, 0.9], { scaleModifier: 0 })] }, device, /scale modifier/],
    [weapon, { ...device, rootPose: undefined }, /Missing or scaled/],
    [weapon, { ...device, bidirectional: true }, /reversible/],
    [weapon, { ...device, muzzleOffset: [0.01, 0, 0.2] }, /Off-axis/],
    [weapon, { ...device, muzzleForward: [0, 0, -1] }, /not forward/],
  ];
  for (const [rifle, attachment, message] of cases) {
    const result = muzzleGeometry(rifle, chamber, [attachment]);
    assert.match(result.reason, message);
    assert.equal(result.barrelLength, null);
    assert.equal(result.forwardShift, null);
    assert.equal(result.upShift, null);
  }
});

let localData;
try {
  localData = JSON.parse(await readFile(new URL("../public/data/h3vr.json", import.meta.url), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const localOptions = { skip: !localData && "Run npm run extract for install integration checks" };

test("all 84 catalogued devices have verified chart/hash data and are available, including non-suppressors", localOptions, () => {
  const devices = localData.muzzleDevices;
  assert.equal(devices.length, 84);
  assert.equal(new Set(devices.map((item) => item.id)).size, 84);
  assert.equal(devices.filter((item) => item.kind === "suppressor").length, 58);
  assert.equal(devices.filter((item) => item.kind === "brake").length, 10);
  assert.equal(devices.filter((item) => item.kind === "device").length, 16);
  assert.equal(searchMuzzleDevices(devices, localData.settings, "").length, 84);
  const rifle = localData.weapons.find((item) => item.id === "M4Carbine");
  for (const attachment of devices) {
    assert.ok(attachment.hashId);
    assert.ok(attachment.source.bundle && attachment.source.assetName && attachment.source.pathId);
    attachment.muzzleForward.forEach((value, axis) => close(value, [0, 0, 1][axis]));
    const effects = muzzleEffects(localData.settings, { weapon: rifle, attachments: [attachment] });
    for (const value of Object.values(effects)) assert.ok(Number.isFinite(value), attachment.id);
  }
  const p7 = devices.find((item) => item.id === "SuppressorP7M8");
  assert.equal(muzzleEffects(localData.settings, { weapon: rifle, attachments: [p7] }).horizontalDriftMoa, 0);
  const nonzero = devices.filter((item) => localData.settings.accuracyClasses.find((entry) => entry.id === item.accuracyClass).driftMult !== 0);
  assert.equal(nonzero.length, 83, "One source None-class suppressor has no authored fixed drift");
});

test("actual M4 + Mk12 and extender/Mk12 geometry compose from certified prefabs", localOptions, () => {
  const rifle = localData.weapons.find((item) => item.id === "M4Carbine");
  const suppressor = localData.muzzleDevices.find((item) => item.id === "SuppressorMk12");
  const extension = localData.muzzleDevices.find((item) => item.id === "BarrelExtenderThinLong");
  const mounted = muzzleGeometry(rifle, rifle.chambers[0], [suppressor]);
  assert.equal(mounted.reason, null);
  close(mounted.barrelLength, 0.5015700061258377);
  close(mounted.forwardShift, 0.1304500252008438);
  close(mounted.upShift, -0.00008002668619155884);
  const stacked = muzzleGeometry(rifle, rifle.chambers[0], [extension, suppressor]);
  assert.equal(stacked.reason, null);
  close(stacked.barrelLength, 0.7200700078632958);
  close(stacked.forwardShift, 0.34895002841949463);
});
