import { dataset, weapon } from "./optics.mjs";

export const profile = dataset.rounds[0];
export const settings = { ...dataset.settings, accuracyClasses: [
  { id: 33, dropMult: 0.9, driftMult: 2 }, { id: 100, dropMult: 1.1, driftMult: 2 },
] };
export const device = { name: "Mk12", hashId: "SuppressorMk12", kind: "suppressor", accuracyClass: 100 };
export const setup = {
  weapon: { ...weapon, hashId: "M4Carbine", accuracyClass: 33 }, attachments: [],
  caliber: dataset.calibers[0], zeroModel: "game", zeroRange: 100,
  barrelLength: 0.4, chamberMultiplier: 1, velocityMultiplier: 1,
  sightHeight: 0.05, sightSetback: 0.5, targetRange: 300, rangeStep: 100,
  gravity: 9.81, fixedStep: 0.01, firstStep: 0.01, sceneLimit: 2000,
  worldHeight: 1.6, catchHeight: -50, inclinationDegrees: 0,
};
