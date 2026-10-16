// Provenance for entries extracted from installed mods (`npm run extract -- --mods DIR`).
export const modById = (mods = []) => new Map(mods.map((mod) => [mod.id, mod]));

export const modName = (mod) => (mod.version ? `${mod.name} ${mod.version}` : mod.name);

// Search text: the package folder and display name, plus "mod" so a search
// for "mod" lists every modded entry.
export const modSearchText = (item, mods) =>
  item?.mod ? `mod ${item.mod} ${mods.get(item.mod)?.name ?? ""}` : "";

export const modSuffix = (item, mods) =>
  item?.mod ? ` · Mod: ${mods.get(item.mod)?.name ?? item.mod}` : "";

export function modNote(item, mods) {
  if (!item?.mod) return "";
  const mod = mods.get(item.mod);
  const scripts = item.modScripts?.length
    ? ` Its prefab uses mod scripts (${item.modScripts.join(", ")}) that can change firing or ballistics at runtime; values assume they do not.`
    : "";
  return `From mod ${mod ? modName(mod) : item.mod}.${scripts}`;
}

export function modSummary(data) {
  if (!data.mods) return "";
  const patched = data.mods.filter((mod) => mod.gameHooks?.ballistics?.length);
  const unresolved = data.mods.filter((mod) => mod.gameHooks?.unresolvedHarmonyPatches && !mod.gameHooks.ballistics?.length);
  const parts = [`${data.mods.length} installed mod package${data.mods.length === 1 ? "" : "s"} read.`];
  if (patched.length)
    parts.push(`Patching ballistic game code (not modeled): ${patched.map((mod) => `${modName(mod)} (${mod.gameHooks.ballistics.join(", ")})`).join("; ")}.`);
  if (unresolved.length)
    parts.push(`Runtime Harmony patches with targets not determinable offline: ${unresolved.map(modName).join(", ")}.`);
  return parts.join(" ");
}
