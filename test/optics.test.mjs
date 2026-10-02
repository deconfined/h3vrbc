import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compatibleOpticMounts, opticGeometry, searchOptics, slidingOpticMount } from "../public/optics.js";
import { chamber, mountProfile, optic, pose, weapon } from "./helpers/optics.mjs";

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("optic search and type matching do not mutate catalogues or infer adapter compatibility", () => {
  const list = [optic, { ...optic, id: "Side", name: "Side scope", mountType: 4, mountTypeName: "Russian" }];
  assert.deepEqual(searchOptics(list, " TEST picatinny "), [optic]);
  assert.deepEqual(searchOptics(list, "russian"), [list[1]]);
  assert.deepEqual(searchOptics(list, "nomatch"), []);
  assert.deepEqual(compatibleOpticMounts(weapon, optic), [{ mount: mountProfile, index: 0 }]);
  assert.deepEqual(compatibleOpticMounts(weapon, list[1]), []);
  assert.equal(list.length, 2);
});

test("rail midpoint is the default; endpoints change setback, not bare-muzzle height", () => {
  assert.equal(slidingOpticMount(mountProfile), true);
  const middle = opticGeometry(weapon, chamber, optic, mountProfile);
  assert.equal(middle.reason, null);
  close(middle.sightHeight, 0.05);
  close(middle.sightSetback, 0.4);
  close(opticGeometry(weapon, chamber, optic, mountProfile, 0).sightSetback, 0.5);
  close(opticGeometry(weapon, chamber, optic, mountProfile, 1).sightSetback, 0.3);
  const fixed = { ...mountProfile, rear: mountProfile.front };
  assert.equal(slidingOpticMount(fixed), false);
  close(opticGeometry(weapon, chamber, optic, fixed, null).sightSetback, 0.3);
  close(opticGeometry(weapon, chamber, optic, fixed, NaN).sightSetback, 0.3, "Fixed mounts ignore disabled rail controls");
});

test("mount scaling scales prefab offsets but not PIP's world-metre camera offset", () => {
  const scaled = { ...mountProfile, scaleModifier: 2 };
  const result = opticGeometry(weapon, chamber, optic, scaled);
  close(result.sightHeight, 0.08);
  close(result.sightSetback, 0.5);
  close(opticGeometry(weapon, chamber, { ...optic, canScaleToMount: false }, scaled).sightSetback, 0.4);
  const cameraOffset = { ...optic, cameraOffsetRearLens: 0.165, opticalPose: pose([0, 0.03, 0.055]) };
  close(opticGeometry(weapon, chamber, cameraOffset, scaled).sightSetback, 0.355);
});

test("geometry projects into the selected barrel's bore frame, not global Y/Z", () => {
  const rotated = (position) => ({ ...pose(position), forward: [1, 0, 0] });
  const barrel = { ...chamber, muzzlePose: rotated([0.4, 0, 0]) };
  const mount = { ...mountProfile, front: [0.2, 0.02, 0], rear: [0, 0.02, 0], pose: rotated([0, 0, 0]) };
  const result = opticGeometry(weapon, barrel, optic, mount);
  close(result.sightHeight, 0.05);
  close(result.sightSetback, 0.4);
  const second = { ...chamber, muzzlePose: pose([0, 0.01, 0.2]) };
  close(opticGeometry(weapon, second, optic, mountProfile).sightHeight, 0.04);
  close(opticGeometry(weapon, second, optic, mountProfile).sightSetback, 0.2);
});

test("unknown, unsupported or explicitly invalid geometry stays null rather than guessed", () => {
  const cases = [
    [weapon, chamber, optic, null],
    [weapon, chamber, optic, { ...mountProfile, type: 4 }],
    [weapon, chamber, optic, mountProfile, null],
    [weapon, chamber, optic, mountProfile, NaN],
    [weapon, chamber, optic, mountProfile, -0.1],
    [weapon, chamber, optic, mountProfile, 1.1],
    [weapon, { ...chamber, muzzlePose: null }, optic, mountProfile],
    [weapon, chamber, { ...optic, geometryUnavailable: "Live pose needed." }, mountProfile],
    [weapon, chamber, { ...optic, opticalPose: pose([0.01, 0.03, -0.1]) }, mountProfile],
    [weapon, chamber, optic, { ...mountProfile, parentPose: { ...pose(), scale: [2, 2, 2] } }],
    [weapon, chamber, optic, { ...mountProfile, pose: { ...pose(), up: [1, 0, 0] } }],
    [weapon, chamber, { ...optic, rootPose: { ...pose(), scale: [2, 2, 2] } }, mountProfile],
  ];
  for (const args of cases) {
    const result = opticGeometry(...args);
    assert.equal(result.sightHeight, null);
    assert.equal(result.sightSetback, null);
    assert.ok(result.reason);
  }
});

let data;
try {
  data = JSON.parse(await readFile(new URL("../public/data/h3vr.json", import.meta.url), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
test("local extraction includes every audited optic view and traceable real mount defaults", { skip: !data?.optics && "Regenerate local data for optic integration checks" }, () => {
  assert.equal(data.optics.length, 83);
  assert.equal(new Set(data.optics.map((item) => item.id)).size, 83);
  assert.equal(new Set(data.optics.map((item) => item.attachmentId)).size, 81);
  assert.equal(data.optics.filter((item) => item.kind === "scope").length, 57);
  assert.equal(data.optics.filter((item) => item.kind === "reflex").length, 26);
  for (const item of data.optics) {
    assert.ok(item.source.bundle && item.source.assetName && item.source.pathId);
    assert.ok(item.opticalPose || item.geometryUnavailable);
    assert.ok(["game", "unadjusted"].includes(item.zeroModel));
  }
  const rifle = data.weapons.find((item) => item.id === "M4Carbine");
  const acog = data.optics.find((item) => item.attachmentId === "ScopeAcog4x32");
  const result = opticGeometry(rifle, rifle.chambers[0], acog, compatibleOpticMounts(rifle, acog)[0].mount);
  assert.equal(result.reason, null);
  close(result.sightHeight, 0.06989004462951454);
  close(result.sightSetback, 0.5656499452888966);
  const classic = data.optics.find((item) => item.attachmentId === "ScopeClassic3-12x42mm");
  close(classic.cameraOffsetRearLens, 0.16500000655651093);
  close(classic.opticalPose.position[2], 0.06050007045268724);
  assert.equal(data.optics.find((item) => item.attachmentId === "ScopePVS14").zeroModel, "unadjusted");
  assert.match(data.optics.find((item) => item.attachmentId === "Telescopescope").geometryUnavailable, /extension/);
});
