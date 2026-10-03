// Number presentation for the setup readouts. Kept apart from app.js so it can be
// unit tested directly: app.js starts the application on import and needs a DOM.
export const fmt = (value, digits = 2) => Number(value).toFixed(digits);
// -0 is reachable by rounding a tiny negative, and would print as "-0.00".
const normaliseZero = (value) => (value === 0 ? 0 : value);

// 1 MOA is 1/60 degree. From mrad: (mrad/1000) radians, divided by DEG for
// degrees, x60 for MOA. The 1000 must stay in the denominator.
export const MOA_PER_MRAD = 60 / (1000 * (Math.PI / 180));

// Degrees to milliradians. Radians per degree is (pi/180), so the factor is
// (pi/180)*1000 -- NOT (180/pi)*1000, which is milliradians per radian and a
// thousand times too large.
export const MRAD_PER_DEG = (Math.PI / 180) * 1000;

// The tuning click, as milliradians, from an optic's serialized degrees-per-tick.
// Returns null when the optic serializes no tick, so callers can tell "unknown"
// apart from "zero".
export function clickMradFromDegrees(degrees) {
  return Number.isFinite(degrees) && degrees > 0 ? degrees * MRAD_PER_DEG : null;
}

// Enough decimals for the last printed digit to mean something: about ten steps
// per unit, never more than three.
export function digitsFor(value) {
  return Math.max(0, Math.min(3, Math.ceil(-Math.log10(value / 10))));
}

// The scope-adjustment callouts must report a value the optic can actually be set
// to, not the solved ideal. The tuning grid is a per-optic tick, so the displayed
// figure is the nearest reachable click at a precision derived from that click: the
// finest optic in the game resolves 0.073 mrad and most are 0.145 mrad, so a third
// decimal place claims more than any of them can be dialled.
//
// The callout shows the negated solved correction. Snapping to the click grid is
// symmetric about zero, so negating before or after rounding gives the same
// answer. A click of null means the optic serializes no tick, and the solved value
// is reported at the previous precision rather than snapped to a guess.
export function formatDialedSetting(solvedMrad, clickMrad, { zeroLabel = "no adjustment", scopeLabel = "scope setting" } = {}) {
  const displayed = -solvedMrad;
  const isZero = Math.abs(solvedMrad) < 1e-7;
  if (!(clickMrad > 0))
    return { mrad: fmt(normaliseZero(displayed), 3), moa: fmt(normaliseZero(displayed * MOA_PER_MRAD), 2), snapped: false, clicks: null, suffix: isZero ? zeroLabel : scopeLabel };
  const clicks = Math.round(displayed / clickMrad);
  const dialled = clicks * clickMrad;
  return {
    mrad: fmt(normaliseZero(dialled), digitsFor(clickMrad)),
    moa: fmt(normaliseZero(dialled * MOA_PER_MRAD), digitsFor(clickMrad * MOA_PER_MRAD)),
    snapped: true,
    clicks: normaliseZero(clicks),
    suffix: isZero ? zeroLabel
      : `${Math.abs(clicks)} click${Math.abs(clicks) === 1 ? "" : "s"} · ${scopeLabel}`,
  };
}