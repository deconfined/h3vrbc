// Centred-optic setups and the result fingerprint pinned against the model
// before lateral offsets existed (commit 4754a03), shared by the test and the
// script that produced test/fixtures/centred-optic-4754a03.json.
const curve = (value) => ({ keys: [{ time: 0, value, inSlope: 0, outSlope: 0 }] });
export const settings = {
  dragCurve: curve(0.3),
  accuracyClasses: [
    { id: 33, minDegrees: 0, maxDegrees: 0, dropMult: 0.8999999761581421, driftMult: 2 },
    { id: 100, minDegrees: 0, maxDegrees: 0, dropMult: 1.100000023841858, driftMult: 2 },
  ],
};
export const profile = {
  name: "Test", id: "Test", muzzleVelocity: 800, mass: 0.01, diameter: 0.01, spreadDegrees: 0,
  flightVelocityMultiplier: 1, airDragMultiplier: 1, gravityMultiplier: 1,
  maxRange: 5000, maxRangeRandom: 0, deletesOnStraightDown: true,
};
const weapon = { name: "M4Carbine", hashId: "M4Carbine", accuracyClass: 33 };
const suppressor = { name: "Mk12", hashId: "SuppressorMk12", accuracyClass: 100, kind: "suppressor" };
const base = {
  weapon, attachments: [], caliber: { barrelCurve: curve(1), opticDropCurve: curve(-0.04) },
  zeroModel: "game", zeroRange: 100, barrelLength: 0.5, chamberMultiplier: 1, velocityMultiplier: 1,
  sightHeight: 0.07, sightSetback: 0.4, inclinationDegrees: 0, targetRange: 400, rangeStep: 50,
  gravity: 9.8100004196167, fixedStep: 0.01, firstStep: 0.01, sceneLimit: 5000, worldHeight: 1000, catchHeight: -50,
};

export function centredCases() {
  const cases = [];
  for (const zeroModel of ["game", "geometric", "unadjusted", "calculated"])
    for (const cant of [{}, { cantMode: "specific", cantDegrees: 9 }, { cantMode: "uncertainty", cantToleranceDegrees: 3 }])
      for (const extra of [{}, { inclinationDegrees: -15, attachments: [suppressor] }, { inclinationDegrees: 20, sightSetback: 0 }, { sightSetback: -0.05 }])
        cases.push({ ...base, zeroModel, ...cant, ...extra });
  return cases;
}

// Every quantity a sideways offset could disturb, through JSON so signed zeros
// compare as the dataset stores them.
export function fingerprint(result) {
  const row = (item) => item && [item.range, item.height, item.lateral, item.time, item.elevationMrad, item.windageMrad];
  return JSON.parse(JSON.stringify({
    boreAngle: result.boreAngle, boreYaw: result.boreYaw, settingRange: result.settingRange,
    setting: row(result.rows.find((item) => item.isSetting)), at200: row(result.rows.find((item) => item.range === 200)),
    target: row(result.target),
    corrected: [result.correctedFlight.boreAngle, result.correctedFlight.boreYaw,
      result.correctedFlight.target.height, result.correctedFlight.target.lateral],
    uncertainty: result.cantUncertainty?.target ?? null,
  }));
}
