import { MODEL } from "../../public/physics.js";

export const pose = (position = [0, 0, 0]) => ({ position, scale: [1, 1, 1], forward: [0, 0, 1], up: [0, 1, 0] });
export const mountProfile = { name: "Top rail", type: 0, typeName: "Picatinny",
  front: [0, 0.02, 0.2], rear: [0, 0.02, 0], pose: pose(), parentPose: pose(), parentToThis: false, scaleModifier: 1 };
export const chamber = { name: "Chamber", caliberId: 13, barrelLength: 0.4, multiplier: 1,
  position: [0, 0, 0], muzzlePose: pose([0, 0, 0.4]) };
export const weapon = { id: "Rifle", name: "Test Rifle", caliberId: 13, chambers: [chamber],
  sightMounts: [mountProfile], muzzlePose: chamber.muzzlePose, shotRule: { kind: "constant", value: 1 } };
export const source = { bundle: "fixture", assetName: "testscope", pathId: "42" };
export const optic = { id: "Scope:42", attachmentId: "Scope", name: "Test Scope", kind: "scope", componentClass: "PIPScopeController",
  mountType: 0, mountTypeName: "Picatinny", rootPose: pose(), opticalPose: pose([0, 0.03, -0.1]),
  canScaleToMount: true, bidirectional: true, zeroModel: "game", defaultZeroRange: 100,
  zeroDistances: [25, 50, 100, 200], originRule: "PIP camera intersection + clamped rear-lens offset", source };
const curve = (value) => ({ keys: [{ time: 0, value, inSlope: 0, outSlope: 0 }] });
export const dataset = {
  schemaVersion: 2, model: MODEL, source: { unityVersion: "5.6", assemblySha256: "test", inputs: [] },
  settings: { fixedDeltaTime: 0.01, dragCurve: curve(0), gravityModes: [{ name: "Realistic", value: 9.81 }] },
  calibers: [{ id: 13, name: "Test caliber", barrelCurve: curve(1), opticDropCurve: curve(0) }],
  weapons: [weapon,
    { ...weapon, id: "Fixed", name: "Fixed mount rifle", sightMounts: [{ ...mountProfile, rear: mountProfile.front }] },
    { ...weapon, id: "Multiple", name: "Multiple mount rifle", sightMounts: [mountProfile, { ...mountProfile, name: "Second rail" }] },
    { ...weapon, id: "NoMount", name: "Unrailed rifle", sightMounts: [] },
    { ...weapon, id: "Combo", name: "Twin barrel", chambers: [chamber, { ...chamber, name: "Second barrel", muzzlePose: pose([0, 0.01, 0.2]) }] }],
  optics: [optic,
    { ...optic, id: "Reflex:43", attachmentId: "Reflex", name: "Test Reflex", kind: "reflex", componentClass: "ReflexSightController", defaultZeroRange: 10 },
    { ...optic, id: "Night:44", attachmentId: "Night", name: "Night clip-on", zeroModel: "unadjusted", defaultZeroRange: null, zeroDistances: [] },
    { ...optic, id: "Dynamic:45", attachmentId: "Dynamic", name: "Extendable telescope", geometryUnavailable: "Depends on live extension." }],
  scenes: [{ file: "level0", name: "IndoorRange", maxRange: 1000, catchHeight: -50 }],
  rounds: [{ id: "556x45mmCartridgeFMJ", name: "Test FMJ", caliberId: 13, roundClass: "FMJ", numProjectiles: 1,
    mass: 0.01, diameter: 0.01, muzzleVelocity: 800, flightVelocityMultiplier: 1, airDragMultiplier: 1,
    gravityMultiplier: 1, maxRange: 5000, maxRangeRandom: 0, deletesOnStraightDown: true, source }],
  muzzleDevices: [], excluded: [],
};
