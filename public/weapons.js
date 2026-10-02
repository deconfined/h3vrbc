// Stock weapon presets use serialized geometry and verified FVRFireArm.Fire callers.
export function searchWeapons(weapons, caliberById, query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return weapons.filter((weapon) => {
    const caliberIds = new Set([
      weapon.caliberId,
      ...(weapon.chambers ?? []).map((chamber) => chamber.caliberId),
    ]);
    const names = [...caliberIds].map((id) => caliberById.get(id)?.name ?? "");
    const text = `${weapon.name} ${weapon.id} ${names.join(" ")}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function weaponPreset(weapon, chamberIndex = 0, chargePercent = 0) {
  const chamber = weapon.chambers?.[chamberIndex];
  const warnings = [];
  const barrelLength = Number.isFinite(chamber?.barrelLength) && chamber.barrelLength >= 0
    ? chamber.barrelLength : null;
  const chamberMultiplier = Number.isFinite(chamber?.multiplier) && chamber.multiplier > 0
    ? chamber.multiplier : null;
  if (barrelLength === null)
    warnings.push(weapon.presetUnavailable ?? "No verified chamber-to-muzzle geometry. Enter the distance manually.");
  if (chamberMultiplier === null)
    warnings.push("No positive chamber velocity multiplier. Enter it manually.");

  const rule = weapon.shotRule;
  let velocityMultiplier = null;
  if (rule?.kind === "constant" && Number.isFinite(rule.value) && rule.value > 0) {
    velocityMultiplier = rule.value;
  } else if (rule?.kind === "sticky" && Number.isFinite(rule.bonus) && rule.bonus >= 0
    && Number.isFinite(chargePercent) && chargePercent >= 0 && chargePercent <= 100) {
    const f = Math.fround;
    velocityMultiplier = f(1 + f(f(rule.bonus) * f(chargePercent / 100)));
    warnings.push("Charge applies to the primary sticky shot; any additional salvo shots use 1×.");
  } else {
    warnings.push(rule?.reason ?? "No verified shot velocity multiplier. Enter it manually.");
  }
  return {
    chamber,
    caliberId: chamber?.caliberId ?? weapon.caliberId,
    barrelLength,
    chamberMultiplier,
    velocityMultiplier,
    warnings,
  };
}
