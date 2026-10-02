import { MODEL, calculate, muzzleEffects, toCSV } from "./physics.js";
import { searchWeapons, weaponPreset } from "./weapons.js";
import { deviceKindLabel, muzzleGeometry, searchMuzzleDevices } from "./muzzle-devices.js";
import { compatibleOpticMounts, opticGeometry, searchOptics, slidingOpticMount } from "./optics.js";
import { createFavoriteStore } from "./favorites.js";
import { createInterfaceStore } from "./interface-state.js";

const $ = (id) => document.getElementById(id);
const form = $("setup-form");
const submit = form.querySelector('button[type="submit"]');
let data;
let caliberById;
let roundById;
let weaponById;
let muzzleDeviceById;
let opticById;
let muzzleDevices = [];
const favoriteStore = createFavoriteStore(document);
let favorites = [];
let favoritesEnabled = false;
const interfaceStore = createInterfaceStore(document);
let interfaceReady = false;
let interfaceTimer;
let lastInterfaceState;
const presetFields = [
  ["barrel-length", "barrelLength"],
  ["chamber-multiplier", "chamberMultiplier"],
  ["velocity-multiplier", "velocityMultiplier"],
];
let currentSolution = null;
let currentOptions = null;
const fmt = (value, digits = 2) => Number(value).toFixed(digits);
const option = (value, label) => {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
};

function revealField(field) {
  for (let section = field.closest("details"); section; section = section.parentElement?.closest("details")) {
    section.open = true;
  }
}

// Native validation runs before submit, so reveal collapsed fields in capture phase.
form.addEventListener("invalid", (event) => revealField(event.target), true);

function showSimulationNote() {
  const scene = data.scenes.find((item) => item.file === $("scene").value);
  $("simulation-note").textContent =
    `Scene catch height: ${fmt(scene.catchHeight, 1)} m world height. Scene travel limits and the round's projectile range can stop flight before the target; target range does not override them.`;
}

function invalidate(
  message = "Setup changed. Calculate to update the firing solution.",
) {
  currentSolution = null;
  $("solution").hidden = true;
  $("export-csv").disabled = true;
  $("calculation-error").textContent = message;
  $("calculation-error").hidden = false;
}

function selectedRound() {
  return roundById.get($("ammunition").value);
}

function selectedWeapon() {
  return weaponById.get($("weapon").value);
}

function selectedPreset() {
  const weapon = selectedWeapon();
  return weapon
    ? weaponPreset(weapon, Number($("weapon-chamber").value), $("shot-charge").valueAsNumber)
    : null;
}

function selectedOptic() {
  return opticById.get($("optic").value);
}

function selectedOpticMount() {
  return $("optic-mount").value === "" ? null
    : selectedWeapon()?.sightMounts?.[Number($("optic-mount").value)];
}

function selectedOpticGeometry() {
  return opticGeometry(selectedWeapon(), selectedPreset()?.chamber, selectedOptic(), selectedOpticMount(),
    $("optic-rail-position").valueAsNumber / 100);
}

function usesOpticGeometry(geometry) {
  return !geometry.reason && Number.isFinite($("sight-height").valueAsNumber)
    && Number.isFinite($("sight-setback").valueAsNumber)
    && Math.abs($("sight-height").valueAsNumber / 100 - geometry.sightHeight) < 1e-10
    && Math.abs($("sight-setback").valueAsNumber / 100 - geometry.sightSetback) < 1e-10;
}

function filterOptics() {
  const previous = $("optic").value;
  const matches = searchOptics(data.optics ?? [], $("optic-search").value);
  const selected = opticById.get(previous);
  const pinned = selected && !matches.some((item) => item.id === previous);
  const label = (item) => `${item.name} · ${item.kind === "scope" ? "PIP scope" : "Reflex"} · ${item.mountTypeName}`;
  $("optic").replaceChildren(option("", "Manual sight geometry"),
    ...(pinned ? [option(selected.id, `Selected: ${label(selected)}`)] : []),
    ...matches.map((item) => option(item.id, label(item))));
  $("optic").value = previous;
  $("optic-results").textContent = data.optics?.length
    ? `${matches.length} matching sight view${matches.length === 1 ? "" : "s"}.${pinned ? " Current selection kept outside the search." : ""}`
    : "No extracted optic presets. Regenerate the dataset to include scope and reflex geometry.";
}

function showOpticNote() {
  const optic = selectedOptic();
  $("restore-optic").hidden = !optic;
  $("optic-zero-distances").replaceChildren(...(optic?.zeroDistances ?? [])
    .filter((distance) => distance > 0).map((distance) => option(distance, `${distance} m`)));
  if (!optic) {
    $("optic-note").textContent = "Manual sight geometry; current values remain editable. Choose an optic and a direct weapon mount to fill stock defaults.";
    return;
  }
  const geometry = selectedOpticGeometry();
  const custom = !geometry.reason && !usesOpticGeometry(geometry);
  const mount = selectedOpticMount();
  const rail = slidingOpticMount(mount)
    ? ` Rail position ${fmt($("optic-rail-position").valueAsNumber, 1)}%; 50% assumes the midpoint, not a measured live pose.` : "";
  const zero = optic.defaultZeroRange > 0
    ? ` Authored default zero setting: ${optic.defaultZeroRange} m.` : " No positive authored zero setting; the current range input is retained.";
  $("optic-note").textContent = `${geometry.reason ? `${geometry.reason} Enter sight height/setback manually if appropriate for the centered model.`
    : custom ? "Manual sight geometry overrides; restore to reapply optic defaults."
      : `Stock direct-mount defaults: height ${fmt(geometry.sightHeight * 100, 3)} cm; setback ${fmt(geometry.sightSetback * 100, 3)} cm from the bare muzzle.`}
    ${rail}${zero} ${optic.zeroModel === "unadjusted" ? "This PIP optic has no base zero adjustment." : ""} Optical origin: ${optic.originRule ?? "unavailable"}. Source: ${optic.source.bundle}/${optic.source.assetName}. Forward-facing stock poses are not live animation measurements.`;
}

function showOpticMountControls() {
  $("optic-mount-group").hidden = !selectedOptic();
  const sliding = slidingOpticMount(selectedOpticMount());
  $("optic-rail-group").hidden = !sliding;
  $("optic-rail-position").disabled = !sliding;
}

function applyOpticGeometry() {
  if (selectedOptic()) {
    const geometry = selectedOpticGeometry();
    $("sight-height").value = geometry.sightHeight === null ? "" : geometry.sightHeight * 100;
    $("sight-setback").value = geometry.sightSetback === null ? "" : geometry.sightSetback * 100;
    if (geometry.reason) revealField($("sight-height"));
  }
  showOpticNote();
}

function refreshOpticMounts(reset = true) {
  const previous = $("optic-mount").value;
  const matches = compatibleOpticMounts(selectedWeapon(), selectedOptic());
  $("optic-mount").replaceChildren(option("", matches.length ? "Select a matching direct mount" : "No matching direct mount / manual geometry"),
    ...matches.map(({ mount, index }) => option(index, `${mount.name} · ${mount.typeName} · ${slidingOpticMount(mount) ? "Sliding rail" : "Fixed point"}`)));
  $("optic-mount").value = !reset && matches.some(({ index }) => String(index) === previous)
    ? previous : matches.length === 1 ? String(matches[0].index) : "";
  if (reset) $("optic-rail-position").value = "50";
  showOpticMountControls();
  if (reset) applyOpticGeometry();
  else showOpticNote();
}

function applyOpticDefaults() {
  const optic = selectedOptic();
  if (optic) {
    $("zero-model").value = optic.zeroModel;
    if (optic.defaultZeroRange > 0) $("zero-range").value = optic.defaultZeroRange;
  }
  applyOpticGeometry();
  showRoundFacts();
  invalidate();
}

function captureInterface() {
  return {
    values: Object.fromEntries([...form.querySelectorAll("input[id], select[id]")]
      .filter((field) => field.id !== "favorites-consent")
      .map((field) => [field.id, field.type === "checkbox" ? field.checked : field.value])),
    attachmentIds: muzzleDevices.map((device) => device.id),
    sections: Object.fromEntries([...document.querySelectorAll("details[id]")]
      .map((section) => [section.id, section.open])),
    scroll: {
      pageX: Math.max(0, document.defaultView.scrollX),
      pageY: Math.max(0, document.defaultView.scrollY),
      setupTop: document.querySelector(".setup-scroll").scrollTop,
      tableLeft: document.querySelector(".table-scroll").scrollLeft,
      tableTop: document.querySelector(".table-scroll").scrollTop,
    },
    calculated: currentSolution !== null,
  };
}

function interfaceNotice(message = "") {
  $("interface-status").textContent = message;
  $("interface-status").hidden = !message;
}

function persistInterface() {
  document.defaultView.clearTimeout(interfaceTimer);
  if (!favoritesEnabled || !interfaceReady) return;
  const state = captureInterface();
  const serialized = JSON.stringify(state);
  if (serialized === lastInterfaceState) return;
  try {
    interfaceStore.write(state);
    lastInterfaceState = serialized;
    interfaceNotice();
  } catch (error) {
    interfaceNotice(error.message);
  }
}

function scheduleInterfaceSave() {
  if (!favoritesEnabled || !interfaceReady) return;
  document.defaultView.clearTimeout(interfaceTimer);
  interfaceTimer = document.defaultView.setTimeout(persistInterface, 150);
}

function interfaceProblem(state) {
  for (const field of form.querySelectorAll("input[id], select[id]")) {
    if (Object.hasOwn(state.values, field.id)
      && typeof state.values[field.id] !== (field.type === "checkbox" ? "boolean" : "string"))
      return "The remembered interface could not be restored. Its saved settings are invalid.";
  }
  const values = state.values;
  const weapon = weaponById.get(values.weapon);
  const chamberIndex = Number(values["weapon-chamber"]);
  const round = roundById.get(values.ammunition);
  const optic = opticById.get(values.optic);
  if (typeof values.weapon !== "string" || typeof values.ammunition !== "string"
    || typeof values["weapon-chamber"] !== "string"
    || values.weapon && !weapon
    || !Number.isSafeInteger(chamberIndex) || chamberIndex < 0
    || (weapon?.chambers?.length ? !weapon.chambers[chamberIndex] : chamberIndex !== 0)
    || values.ammunition && (!round || weapon && round.caliberId !== weaponPreset(weapon, chamberIndex).caliberId)
    || state.attachmentIds.some((id) => !muzzleDeviceById.has(id)))
    return "The remembered setup could not be restored: a weapon, chamber, round or muzzle device is no longer available.";
  if (values.optic && (!optic || values["optic-mount"] && !compatibleOpticMounts(weapon, optic)
    .some(({ index }) => String(index) === values["optic-mount"])))
    return "The remembered setup could not be restored: an optic or direct weapon mount is no longer available.";
  for (const id of ["scene", "gravity", "zero-model", "muzzle-geometry-mode", "muzzle-kind"]) {
    if (![...$(id).options].some((item) => item.value === values[id]))
      return "The remembered setup could not be restored: a selected setting is no longer available.";
  }
  return null;
}

function restoreInterface(state) {
  const problem = interfaceProblem(state);
  if (problem) {
    interfaceNotice(problem);
    return false;
  }
  const values = state.values;
  $("weapon-search").value = "";
  $("ammo-search").value = "";
  $("muzzle-search").value = "";
  $("muzzle-kind").value = "";
  filterWeapons();
  $("weapon").value = values.weapon;
  muzzleDevices = [];
  $("muzzle-geometry-mode").value = "stock";
  changeWeapon();
  $("weapon-chamber").value = values["weapon-chamber"];
  $("shot-charge").value = values["shot-charge"] ?? "0";
  applyWeaponPreset();
  filterRounds();
  $("ammunition").value = values.ammunition;
  muzzleDevices = state.attachmentIds.map((id) => muzzleDeviceById.get(id));
  $("muzzle-geometry-mode").value = values["muzzle-geometry-mode"];
  refreshMuzzleSetup(true);
  $("optic-search").value = "";
  filterOptics();
  $("optic").value = values.optic ?? "";
  refreshOpticMounts(false);
  for (const field of form.querySelectorAll("input[id], select[id]")) {
    if (field.id === "favorites-consent" || !Object.hasOwn(values, field.id)) continue;
    if (field.type === "checkbox") field.checked = values[field.id];
    else field.value = values[field.id];
  }
  filterWeapons();
  filterRounds(true);
  refreshMuzzleSetup();
  filterMuzzleDevices(values["muzzle-device"]);
  filterOptics();
  showOpticMountControls();
  showOpticNote();
  renderFavorites(values["favorite-select"]);
  showRoundFacts();
  showSimulationNote();
  for (const [id, open] of Object.entries(state.sections)) {
    const section = $(id);
    if (section?.tagName === "DETAILS") section.open = open;
  }
  return true;
}

function initializeInterfacePersistence() {
  // Establish a baseline after restoration so opening a page never rewrites it.
  lastInterfaceState = JSON.stringify(captureInterface());
  interfaceReady = true;
  for (const type of ["input", "change", "click"]) form.addEventListener(type, scheduleInterfaceSave);
  document.addEventListener("toggle", scheduleInterfaceSave, true);
  document.addEventListener("scroll", scheduleInterfaceSave, true);
  document.defaultView.addEventListener("scroll", scheduleInterfaceSave);
  document.defaultView.addEventListener("pagehide", persistInterface);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistInterface();
  });
}

function favoriteProblem(favorite) {
  const weapon = weaponById.get(favorite.weaponId);
  if (!weapon) return "This favorite's weapon is unavailable in the current game data.";
  if (weapon.chambers?.length ? !weapon.chambers[favorite.chamberIndex] : favorite.chamberIndex !== 0)
    return "This favorite's chamber is unavailable in the current game data.";
  const round = roundById.get(favorite.roundId);
  if (!round) return "This favorite's round is unavailable in the current game data.";
  if (round.caliberId !== weaponPreset(weapon, favorite.chamberIndex).caliberId)
    return "This favorite's round no longer matches its weapon chamber.";
  const attachments = favorite.attachmentIds.map((id) => muzzleDeviceById.get(id));
  if (attachments.some((device) => !device))
    return "A muzzle device in this favorite is unavailable in the current game data.";
  if (attachments.length) {
    try {
      muzzleEffects(data.settings, { weapon, attachments });
    } catch (error) {
      return error.message;
    }
  }
  return null;
}

function renderFavorites(selectedId = $("favorite-select").value) {
  $("favorites-consent").checked = favoritesEnabled;
  $("favorites-controls").hidden = !favoritesEnabled;
  $("favorites-controls").disabled = !favoritesEnabled;
  $("save-favorite").disabled = !favoritesEnabled;
  $("favorite-select").replaceChildren(
    option("", favorites.length ? "Choose a saved setup" : "No saved setups yet"),
    ...favorites.map((favorite) => option(favorite.id, favorite.name)),
  );
  if (favorites.some((favorite) => favorite.id === selectedId)) $("favorite-select").value = selectedId;
  $("favorite-select").disabled = !favoritesEnabled || !favorites.length;
  const favorite = favorites.find((item) => item.id === $("favorite-select").value);
  const problem = favorite && favoriteProblem(favorite);
  $("load-favorite").disabled = !favoritesEnabled || !favorite || Boolean(problem);
  $("delete-favorite").disabled = !favoritesEnabled || !favorite;
  $("favorite-summary").textContent = favorite
    ? problem ?? [weaponById.get(favorite.weaponId).name,
      ...(weaponById.get(favorite.weaponId).chambers?.length > 1
        ? [weaponById.get(favorite.weaponId).chambers[favorite.chamberIndex].name] : []),
      roundById.get(favorite.roundId).name,
      favorite.attachmentIds.length
        ? favorite.attachmentIds.map((id) => muzzleDeviceById.get(id).name).join(" → ")
        : "Bare muzzle"].join(" · ")
    : favorites.length ? "Select a favorite to load or delete it." : "No saved setups yet.";
  scheduleInterfaceSave();
}

function saveFavorite() {
  if (!favoritesEnabled) return;
  const weapon = selectedWeapon();
  const round = selectedRound();
  if (!weapon || !round) {
    $("favorite-status").textContent = "Choose a weapon and a supported round before saving a favorite.";
    return;
  }
  const setup = {
    weaponId: weapon.id,
    chamberIndex: Number($("weapon-chamber").value),
    roundId: round.id,
    attachmentIds: muzzleDevices.map((device) => device.id),
  };
  const problem = favoriteProblem(setup);
  if (problem) {
    $("favorite-status").textContent = problem;
    return;
  }
  const existing = favorites.find((favorite) => favorite.weaponId === setup.weaponId
    && favorite.chamberIndex === setup.chamberIndex && favorite.roundId === setup.roundId
    && JSON.stringify(favorite.attachmentIds) === JSON.stringify(setup.attachmentIds));
  const name = $("favorite-name").value.trim() || `${weapon.name} · ${round.name}`.slice(0, 60);
  const favorite = {
    id: existing?.id ?? document.defaultView.crypto.randomUUID?.()
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    name,
    ...setup,
  };
  const next = existing
    ? favorites.map((item) => item.id === existing.id ? favorite : item)
    : [...favorites, favorite];
  try {
    favoriteStore.write(next);
    favorites = next;
    renderFavorites(favorite.id);
    $("favorite-status").textContent = `${existing ? "Updated" : "Saved"} “${name}”.`;
  } catch (error) {
    $("favorite-status").textContent = error.message;
  }
}

function loadFavorite() {
  if (!favoritesEnabled) return;
  const favorite = favorites.find((item) => item.id === $("favorite-select").value);
  if (!favorite) return;
  const problem = favoriteProblem(favorite);
  if (problem) {
    $("favorite-status").textContent = problem;
    return;
  }
  $("weapon-search").value = "";
  filterWeapons();
  $("weapon").value = favorite.weaponId;
  muzzleDevices = [];
  $("muzzle-geometry-mode").value = "stock";
  changeWeapon();
  $("weapon-chamber").value = String(favorite.chamberIndex);
  applyWeaponPreset();
  filterRounds();
  $("ammunition").value = favorite.roundId;
  refreshOpticMounts();
  muzzleDevices = favorite.attachmentIds.map((id) => muzzleDeviceById.get(id));
  refreshMuzzleSetup(true);
  showRoundFacts();
  $("weapon-section").open = true;
  if (muzzleDevices.length) $("muzzle-section").open = true;
  $("favorite-status").textContent = `Loaded “${favorite.name}”. Review the setup and calculate a new solution.`;
  invalidate("Favorite loaded. Calculate to update the firing solution.");
}

function initializeFavorites() {
  const saved = favoriteStore.read();
  favoritesEnabled = saved !== null;
  favorites = saved ?? [];
  renderFavorites();
  if (favoritesEnabled) $("favorite-status").textContent = "Cookie storage is on. Save the current setup or choose a favorite to load.";
  $("favorites-consent").addEventListener("change", () => {
    if ($("favorites-consent").checked) {
      try {
        favoriteStore.write([]);
        favoritesEnabled = true;
        renderFavorites();
        lastInterfaceState = undefined;
        persistInterface();
        $("favorite-status").textContent = "Cookie storage is on. Your interface is remembered automatically; you can also save favorite setups.";
      } catch (error) {
        renderFavorites();
        $("favorite-status").textContent = error.message;
      }
    } else {
      favoritesEnabled = false;
      document.defaultView.clearTimeout(interfaceTimer);
      favorites = [];
      $("favorite-name").value = "";
      renderFavorites();
      const errors = [];
      for (const store of [favoriteStore, interfaceStore]) {
        try { store.clear(); } catch (error) { errors.push(error.message); }
      }
      interfaceNotice();
      $("favorite-status").textContent = errors.length
        ? `Cookie storage is off. ${errors.join(" ")}`
        : "Cookie storage is off. All remembered settings and favorites have been deleted.";
    }
  });
  $("favorite-select").addEventListener("change", () => renderFavorites());
  $("favorite-name").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    saveFavorite();
  });
  $("save-favorite").addEventListener("click", saveFavorite);
  $("load-favorite").addEventListener("click", loadFavorite);
  $("delete-favorite").addEventListener("click", () => {
    if (!favoritesEnabled) return;
    const id = $("favorite-select").value;
    if (!favorites.some((favorite) => favorite.id === id)) return;
    try {
      const next = favorites.filter((favorite) => favorite.id !== id);
      favoriteStore.write(next);
      favorites = next;
      renderFavorites();
      $("favorite-status").textContent = "Favorite deleted.";
    } catch (error) {
      $("favorite-status").textContent = error.message;
    }
  });
}

function selectedMuzzleGeometry() {
  return muzzleGeometry(selectedWeapon(), selectedPreset()?.chamber, muzzleDevices);
}

function manualMuzzleGeometry() {
  return muzzleDevices.length > 0 && $("muzzle-geometry-mode").value === "manual";
}

function directional(value, unit, positive, negative, digits = 3) {
  return `${fmt(Math.abs(value), digits)} ${unit} ${Math.abs(value) < 0.0000001 ? "(centered)" : value > 0 ? positive : negative}`;
}

function previewMuzzleDevice() {
  const device = muzzleDeviceById.get($("muzzle-device").value);
  const weapon = selectedWeapon();
  $("add-muzzle-device").disabled = !device || !weapon?.hashId || !Number.isInteger(weapon.accuracyClass);
  if (!device) {
    $("muzzle-device-facts").textContent = "No matching devices. Clear the search or change the type filter.";
    return;
  }
  const accuracy = data.settings.accuracyClasses?.find((item) => item.id === device.accuracyClass);
  let bias = "Select a verified weapon to preview its device-specific POI bias and add devices.";
  if (weapon?.hashId && Number.isInteger(weapon.accuracyClass)) {
    try {
      const effects = muzzleEffects(data.settings, { weapon, attachments: [device] });
      bias = `On this weapon, alone: fixed launch yaw ${directional(effects.horizontalDriftMoa, "MOA", "right", "left")}; net vertical launch bias ${directional(effects.pitchDegrees * 60, "MOA", "down", "up")}.`;
    } catch (error) {
      bias = error.message;
      $("add-muzzle-device").disabled = true;
    }
  }
  $("muzzle-device-facts").textContent =
    `${deviceKindLabel(device)} · ${accuracy?.name ?? "Unknown accuracy class"}. ${bias} Add to loadout to apply. Source: ${device.source?.bundle ?? "unknown"}/${device.source?.assetName ?? device.id}.`;
}

function filterMuzzleDevices(savedId) {
  const previous = typeof savedId === "string" ? savedId : $("muzzle-device").value;
  const matches = searchMuzzleDevices(data.muzzleDevices ?? [], data.settings,
    $("muzzle-search").value, $("muzzle-kind").value);
  const selected = typeof savedId === "string" && muzzleDeviceById.get(savedId);
  const pinned = selected
    && !matches.some((device) => device.id === savedId);
  $("muzzle-device").replaceChildren(
    ...(pinned ? [option(savedId, `Selected: ${selected.name}`)] : []),
    ...matches.map((device) => option(device.id, device.name)),
  );
  if (pinned || matches.some((device) => device.id === previous)) $("muzzle-device").value = previous;
  if (!matches.length && !pinned) $("muzzle-device").append(option("", "No matching muzzle devices"));
  $("muzzle-results").textContent = `${matches.length} matching devices of ${(data.muzzleDevices ?? []).length} extracted. Search includes name, ID, type and accuracy class.`;
  previewMuzzleDevice();
}

function showMuzzleNote() {
  if (!muzzleDevices.length) {
    $("muzzle-note").textContent = "Bare muzzle: no added device bias. Geometry inputs describe the bare weapon.";
    return;
  }
  let bias;
  try {
    const effects = muzzleEffects(data.settings, { weapon: selectedWeapon(), attachments: muzzleDevices });
    bias = `Combined launch yaw ${directional(effects.horizontalDriftMoa, "MOA", "right", "left")}; drop ${fmt(effects.dropMoa, 3)} MOA down; vertical drift ${directional(effects.verticalDriftMoa, "MOA", "down", "up")}. Last registered device supplies fixed drift; drop multipliers combine.`;
  } catch (error) {
    bias = error.message;
  }
  const geometry = selectedMuzzleGeometry();
  if (geometry.reason) revealField($("muzzle-geometry-mode"));
  const description = manualMuzzleGeometry()
    ? "Measured geometry: enter the actual chamber-to-mounted-muzzle distance in Manual overrides and the two muzzle shifts here. Sight height/setback still describe the bare muzzle. Only centered, forward/bore-aligned mounting is supported. Confirm these values before calculating."
    : geometry.reason
      ? `${geometry.reason} Choose measured geometry and supply the actual values; stock values are not guessed.`
      : `Stock inner-to-outer mounting: effective distance ${fmt(geometry.barrelLength, 6)} m; muzzle forward shift ${fmt(geometry.forwardShift * 100, 3)} cm, up shift ${fmt(geometry.upShift * 100, 3)} cm. These shifts also update effective optic height/setback in the model. Stock geometry is not a live animation measurement.`;
  $("muzzle-note").textContent = `${bias} ${description} No random spread, wind or spin drift is added. Physical fit is not inferred from caliber.`;
}

function refreshMuzzleSetup(resetGeometry = false) {
  $("muzzle-loadout").replaceChildren(...muzzleDevices.map((device, index) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = device.name;
    const actions = document.createElement("div");
    actions.className = "muzzle-actions";
    for (const [action, label] of [["earlier", "Earlier"], ["later", "Later"], ["remove", "Remove"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = label;
      button.dataset.action = action;
      button.dataset.index = index;
      button.setAttribute("aria-label", `${label}: ${device.name}`);
      button.disabled = action === "earlier" && index === 0 || action === "later" && index === muzzleDevices.length - 1;
      actions.append(button);
    }
    item.append(name, actions);
    return item;
  }));
  $("muzzle-loadout-note").textContent = muzzleDevices.length
    ? "Match game registration order. Stock geometry treats this as an inner → outer mount chain; use measured geometry if registration order differs."
    : "No muzzle devices added.";
  $("clear-muzzle-devices").hidden = !muzzleDevices.length;
  $("muzzle-geometry-group").hidden = !muzzleDevices.length;
  const manual = manualMuzzleGeometry();
  $("manual-muzzle-geometry").hidden = !manual;
  for (const id of ["muzzle-forward-shift", "muzzle-up-shift", "confirm-muzzle-geometry"]) {
    $(id).disabled = !manual;
    $(id).required = manual;
  }
  if (resetGeometry && muzzleDevices.length) {
    const geometry = selectedMuzzleGeometry();
    $("barrel-length").value = geometry.barrelLength ?? "";
    $("muzzle-forward-shift").value = geometry.forwardShift === null ? "" : geometry.forwardShift * 100;
    $("muzzle-up-shift").value = geometry.upShift === null ? "" : geometry.upShift * 100;
    $("confirm-muzzle-geometry").checked = false;
  } else if (resetGeometry) {
    const preset = selectedPreset();
    if (preset) $("barrel-length").value = preset.barrelLength ?? "";
  }
  for (const id of ["barrel-length", "muzzle-forward-shift", "muzzle-up-shift", "confirm-muzzle-geometry"]) {
    const field = $(id);
    if (field.willValidate && !field.validity.valid) revealField(field);
  }
  filterMuzzleDevices();
  showMuzzleNote();
  showWeaponNote();
}

function filterWeapons() {
  const previous = $("weapon").value;
  const matches = searchWeapons(data.weapons, caliberById, $("weapon-search").value);
  const selected = weaponById.get(previous);
  const pinned = selected && !matches.some((item) => item.id === previous);
  const label = (item) => `${item.name} · ${caliberById.get(item.caliberId).name}`;
  $("weapon").replaceChildren(
    option("", "All weapons / manual setup"),
    ...(pinned ? [option(selected.id, `Selected: ${label(selected)}`)] : []),
    ...matches.map((item) => option(item.id, label(item))),
  );
  $("weapon").value = previous;
  $("weapon-results").textContent =
    `${matches.length} matching weapon${matches.length === 1 ? "" : "s"}.${pinned ? " Current selection kept outside the search." : ""}${matches.length ? "" : " Try another name, ID or caliber."}`;
}

function showWeaponNote() {
  const weapon = selectedWeapon();
  $("restore-weapon").hidden = !weapon;
  if (!weapon) {
    $("weapon-note").textContent = "Manual setup: choose any supported round and enter geometry and multipliers in Manual overrides, or select a weapon to fill stock values.";
    return;
  }
  const preset = selectedPreset();
  $("restore-weapon").textContent = manualMuzzleGeometry() ? "Restore weapon multipliers" : "Restore weapon values";
  const custom = presetFields.some(([id, key]) => {
    if (id === "barrel-length" && manualMuzzleGeometry()) return false;
    const expected = key === "barrelLength" && muzzleDevices.length ? selectedMuzzleGeometry().barrelLength : preset[key];
    return expected === null ? $(id).value !== "" : $(id).valueAsNumber !== expected;
  });
  const source = weapon.source
    ? `Source: ${weapon.source.bundle}/${weapon.source.assetName}.`
    : "No stock firearm configuration available.";
  $("weapon-note").textContent =
    `${custom ? "Custom overrides; restore to reapply loadout-aware weapon values." : "Stock prefab values; editable in Manual overrides."} ${preset.warnings.join(" ")} ${source} Sight geometry uses the selected optic/direct mount or manual inputs.${manualMuzzleGeometry() ? " Measured muzzle geometry is preserved when restoring multipliers." : ""}`;
}

function applyWeaponPreset() {
  const preset = selectedPreset();
  if (preset) {
    for (const [id, key] of presetFields) {
      if (id === "barrel-length" && manualMuzzleGeometry()) continue;
      const value = key === "barrelLength" && muzzleDevices.length ? selectedMuzzleGeometry().barrelLength : preset[key];
      $(id).value = value ?? "";
      if (value === null) revealField($(id));
    }
  }
  showWeaponNote();
  invalidate();
}

function changeWeapon() {
  const weapon = selectedWeapon();
  const chambers = weapon?.chambers ?? [];
  $("weapon-chamber").replaceChildren(
    ...chambers.map((chamber, index) => option(index,
      `${index + 1}: ${chamber.name} · ${caliberById.get(chamber.caliberId)?.name ?? "Unknown caliber"}`)),
  );
  $("weapon-chamber-group").hidden = chambers.length < 2;
  const sticky = weapon?.shotRule?.kind === "sticky";
  $("shot-charge-group").hidden = !sticky;
  $("shot-charge").disabled = !sticky;
  $("shot-charge").required = sticky;
  $("shot-charge").value = "0";
  applyWeaponPreset();
  $("ammo-search").value = "";
  filterRounds();
  refreshMuzzleSetup(true);
  refreshOpticMounts();
}

function showRoundFacts() {
  const round = selectedRound();
  $("ammo-facts").replaceChildren();
  if (!round) return;
  const caliber = caliberById.get(round.caliberId);
  $("ammo-note").textContent =
    `${caliber.name} · ${round.roundClass} · ${round.numProjectiles} projectile${round.numProjectiles === 1 ? "" : "s"}. ${round.hasSubmunitions ? "Primary flight only; submunition paths are not modeled." : ""} ${round.numProjectiles > 1 ? "One centerline pellet; spread is not modeled." : ""}`;
  const facts = [
    ["Projectile mass", `${fmt(round.mass * 1000, 3)} g`],
    ["Diameter", `${fmt(round.diameter * 1000, 2)} mm`],
    ["Base velocity", `${fmt(round.muzzleVelocity, 1)} m/s`],
    ["Flight multiplier", `${fmt(round.flightVelocityMultiplier, 3)}×`],
    ["Gravity multiplier", `${fmt(round.gravityMultiplier, 3)}×`],
    ["Drag multiplier", `${fmt(round.airDragMultiplier, 3)}×`],
    [
      "Projectile range",
      `${fmt(round.maxRange, round.maxRange < 1 ? 3 : 0)} m${round.maxRangeRandom ? ` + random 0–${fmt(round.maxRangeRandom, 0)} m` : ""}`,
    ],
  ];
  for (const [name, value] of facts) {
    const row = document.createElement("div");
    const key = document.createElement("span");
    const text = document.createElement("span");
    key.textContent = name;
    text.textContent = value;
    row.append(key, text);
    $("ammo-facts").append(row);
  }
  const zeroModel = $("zero-model").value;
  $("zero-model-note").textContent =
    zeroModel === "game"
      ? `Uses ${caliber.name}'s authored drop curve. Changing ammunition, barrel velocity or gravity does not change the optic's zero angle.`
      : zeroModel === "geometric"
        ? "Legacy holo/red-dot geometry: points at a bore-line target with no ballistic drop compensation."
        : zeroModel === "unadjusted"
          ? "No base adjustment: bore-aligned optic. For PIP scopes with FixedBaseZero ≤ 0, changing the nominal setting does not change the base angle."
          : "Solves a true zero for this projectile and setup. This is not the optic’s nominal game setting.";
}

function filterRounds(preserveSelected = false) {
  const previous = $("ammunition").value;
  const preset = selectedPreset();
  const query = $("ammo-search").value.trim().toLowerCase();
  const matches = data.rounds.filter(
    (round) =>
      (!preset || round.caliberId === preset.caliberId) &&
      `${round.name} ${caliberById.get(round.caliberId).name} ${round.id}`
        .toLowerCase()
        .includes(query),
  );
  const selected = selectedRound();
  const pinned = preserveSelected === true && selected && (!preset || selected.caliberId === preset.caliberId)
    && !matches.some((round) => round.id === previous);
  $("ammunition").replaceChildren(
    ...(pinned ? [option(selected.id, `Selected: ${selected.name}`)] : []),
    ...matches.map((round) => option(round.id, round.name)),
  );
  submit.disabled = matches.length === 0 && !pinned;
  if (!matches.length && !pinned) {
    $("ammunition").append(option("", "No matching supported rounds"));
    $("ammo-note").textContent =
      "Clear the ammunition search or select another weapon/chamber. This caliber may have no supported projectile model.";
  } else {
    $("ammunition").value = pinned || matches.some((round) => round.id === previous)
      ? previous
      : (matches.find((round) => round.roundClass === "FMJ") ?? matches[0]).id;
  }
  showRoundFacts();
  invalidate();
}

function readOptions() {
  const values = new FormData(form);
  const scene = data.scenes.find((item) => item.file === $("scene").value);
  const sightGeometry = selectedOpticGeometry();
  const railPosition = $("optic-rail-position").valueAsNumber / 100;
  let geometry = { forwardShift: 0, upShift: 0 };
  if (muzzleDevices.length) {
    geometry = selectedMuzzleGeometry();
    if (manualMuzzleGeometry()) {
      if (!$("confirm-muzzle-geometry").checked) throw new Error("Confirm the measured mounted-muzzle geometry before calculating.");
      geometry = { forwardShift: $("muzzle-forward-shift").valueAsNumber / 100, upShift: $("muzzle-up-shift").valueAsNumber / 100 };
      if (!Number.isFinite(geometry.forwardShift) || !Number.isFinite(geometry.upShift))
        throw new Error("Both measured mounted-muzzle shifts must be finite.");
    } else if (geometry.reason) {
      throw new Error(`${geometry.reason} Select measured geometry and enter the actual values.`);
    }
  }
  return {
    weapon: selectedWeapon(),
    optic: selectedOptic(),
    opticMount: selectedOpticMount(),
    opticRailPosition: slidingOpticMount(selectedOpticMount()) && Number.isFinite(railPosition) ? railPosition : null,
    sightGeometryMode: selectedOptic() && usesOpticGeometry(sightGeometry)
      ? "Forward-facing stock direct mount (rail position assumed unless measured)" : "Manual sight geometry",
    chamber: selectedPreset()?.chamber,
    attachments: [...muzzleDevices],
    muzzleGeometryMode: !muzzleDevices.length ? "Bare weapon" : manualMuzzleGeometry() ? "Measured centered/bore-aligned muzzle" : "Stock inner-to-outer mounts",
    muzzleForwardShift: geometry.forwardShift,
    muzzleUpShift: geometry.upShift,
    inclinationDegrees: Number(values.get("inclinationDegrees")),
    caliber: caliberById.get(selectedRound().caliberId),
    zeroModel: values.get("zeroModel"),
    zeroRange: Number(values.get("zeroRange")),
    barrelLength: Number(values.get("barrelLength")),
    chamberMultiplier: Number(values.get("chamberMultiplier")),
    velocityMultiplier: Number(values.get("velocityMultiplier")),
    sightHeight: Number(values.get("sightHeight")) / 100 - geometry.upShift,
    sightSetback: Number(values.get("sightSetback")) / 100 + geometry.forwardShift,
    targetRange: Number(values.get("targetRange")),
    rangeStep: Number(values.get("rangeStep")),
    gravity: Number(values.get("gravity")),
    sceneLimit: Number(values.get("sceneLimit")),
    catchHeight: scene.catchHeight,
    worldHeight: Number(values.get("worldHeight")),
    fixedStep: Number(values.get("fixedStep")) / 1000,
    firstStep: Number(values.get("firstStep")) / 1000,
  };
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgElement(type, attributes, text) {
  const element = document.createElementNS(SVG_NS, type);
  for (const [key, value] of Object.entries(attributes))
    element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderChart(solution, options, round) {
  const chart = $("trajectory-chart");
  const title = svgElement(
    "title",
    { id: "chart-title" },
    `${round.name}: trajectory at ${options.zeroRange} m optic setting, ${fmt(options.inclinationDegrees, 1)}° firing angle`,
  );
  const description = svgElement(
    "desc",
    { id: "chart-description" },
    `At ${options.targetRange} meters along the ${fmt(options.inclinationDegrees, 1)}° sight line, perpendicular height offset is ${fmt(solution.target.height * 100)} cm. The optic setting is not an imposed trajectory crossing.`,
  );
  chart.replaceChildren(title, description);
  const left = 62,
    top = 20,
    width = 716,
    height = 232;
  const min = Math.min(0, ...solution.points.map((point) => point.height));
  const max = Math.max(0, ...solution.points.map((point) => point.height));
  const padding = Math.max((max - min) * 0.13, 0.025);
  const bottom = min - padding;
  const upper = max + padding;
  const px = (range) => left + (range / options.targetRange) * width;
  const py = (value) => top + ((upper - value) / (upper - bottom)) * height;
  for (let i = 0; i <= 4; i++) {
    const range = (options.targetRange * i) / 4;
    const value = bottom + ((upper - bottom) * i) / 4;
    chart.append(
      svgElement("line", {
        x1: px(range),
        x2: px(range),
        y1: top,
        y2: top + height,
        class: "chart-grid",
      }),
    );
    chart.append(
      svgElement("line", {
        x1: left,
        x2: left + width,
        y1: py(value),
        y2: py(value),
        class: "chart-grid",
      }),
    );
    chart.append(
      svgElement(
        "text",
        {
          x: px(range),
          y: top + height + 23,
          "text-anchor": "middle",
          class: "chart-axis",
        },
        fmt(range, 0),
      ),
    );
    chart.append(
      svgElement(
        "text",
        {
          x: left - 10,
          y: py(value) + 4,
          "text-anchor": "end",
          class: "chart-axis",
        },
        fmt(value * 100, 1),
      ),
    );
  }
  chart.append(
    svgElement("text", { x: left, y: 10, class: "chart-axis" }, "HEIGHT / cm"),
  );
  chart.append(
    svgElement("line", {
      x1: left,
      x2: left + width,
      y1: py(0),
      y2: py(0),
      class: "sight-line",
    }),
  );
  const path = solution.points
    .map(
      (point, index) =>
        `${index ? "L" : "M"}${fmt(px(point.range), 3)},${fmt(py(point.height), 3)}`,
    )
    .join(" ");
  chart.append(svgElement("path", { d: path, class: "trajectory" }));
  if (
    solution.settingRange !== null &&
    solution.settingRange <= options.targetRange
  ) {
    chart.append(
      svgElement("line", {
        x1: px(solution.settingRange),
        x2: px(solution.settingRange),
        y1: top,
        y2: top + height,
        class: "setting-line",
      }),
    );
    chart.append(
      svgElement(
        "text",
        {
          x: px(solution.settingRange) + 6,
          y: top + 12,
          class: "setting-label",
        },
        options.zeroModel === "calculated" ? "TRUE ZERO" : "OPTIC SETTING",
      ),
    );
  }
  chart.append(
    svgElement("circle", {
      cx: px(options.targetRange),
      cy: py(solution.target.height),
      r: 4,
      class: "target-point",
    }),
  );
}

function render(solution, options, round) {
  $("hold-value").textContent = fmt(solution.target.elevationMrad, 3);
  $("hold-secondary").textContent =
    `${fmt(solution.target.elevationMoa, 2)} MOA · ${solution.target.elevationMrad >= 0 ? "raise aim" : "lower aim"}`;
  $("windage-value").textContent = fmt(solution.target.windageMrad, 3);
  $("windage-secondary").textContent =
    `${fmt(solution.target.windageMoa, 2)} MOA · ${Math.abs(solution.target.windageMrad) < 0.0000001 ? "no lateral correction" : solution.target.windageMrad > 0 ? "aim right" : "aim left"}`;
  $("lateral-label").textContent = `Current POI: ${directional(solution.target.lateral * 100, "cm", "right", "left", 2)} of POA`;
  $("flight-time").textContent = fmt(solution.target.time, 3);
  $("target-label").textContent =
    `${options.targetRange} m along sight line · ${fmt(options.inclinationDegrees, 1)}°`;
  $("muzzle-speed").textContent = fmt(solution.muzzleSpeed, 1);
  $("barrel-factor").textContent =
    `${fmt(solution.barrelFactor, 3)}× barrel curve`;
  $("zero-label").textContent =
    options.zeroModel === "unadjusted"
      ? "No base zero adjustment · bore 0° relative to sight"
      : `${options.zeroModel === "calculated" ? "Calculated zero" : "Optic setting"} ${options.zeroRange} m · bore ${fmt((solution.boreAngle * 180) / Math.PI, 3)}° relative to sight`;
  $("range-rows").replaceChildren();
  for (const row of solution.rows) {
    const tr = document.createElement("tr");
    if (row.isTarget) tr.classList.add("target-row");
    if (row.isSetting) tr.classList.add("zero-row");
    const values = [
      fmt(row.range, Number.isInteger(row.range) ? 0 : 2),
      fmt(row.height * 100, 2),
      fmt(row.lateral * 100, 2),
      fmt(row.elevationMrad, 3),
      fmt(row.elevationMoa, 2),
      fmt(row.windageMrad, 3),
      fmt(row.windageMoa, 2),
      fmt(row.time, 3),
      fmt(row.speed, 1),
    ];
    for (const value of values) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    $("range-rows").append(tr);
  }
  renderChart(solution, options, round);
  $("solution").hidden = false;
  $("calculation-error").hidden = true;
  $("export-csv").disabled = false;
}

async function runCalculation(event) {
  event?.preventDefault();
  if (!form.reportValidity() || !selectedRound()) return;
  invalidate("Calculating source-derived flight…");
  submit.disabled = true;
  const label = submit.innerHTML;
  submit.textContent = "Calculating…";
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    const round = selectedRound();
    const options = readOptions();
    const result = calculate(round, data.settings, options);
    render(result, options, round);
    currentSolution = result;
    currentOptions = options;
  } catch (error) {
    invalidate(error.message);
  } finally {
    submit.innerHTML = label;
    submit.disabled = !selectedRound();
    scheduleInterfaceSave();
  }
}

async function start() {
  const response = await fetch("data/h3vr.json");
  if (!response.ok)
    throw new Error(
      "No local ammunition dataset. Run npm run extract from the project directory, then reload.",
    );
  data = await response.json();
  if (data.schemaVersion !== 2 || data.model !== MODEL)
    throw new Error(
      "The extracted dataset does not match this verified projectile model. Regenerate it with npm run extract.",
    );
  caliberById = new Map(data.calibers.map((item) => [item.id, item]));
  roundById = new Map(data.rounds.map((item) => [item.id, item]));
  weaponById = new Map(data.weapons.map((item) => [item.id, item]));
  muzzleDeviceById = new Map((data.muzzleDevices ?? []).map((item) => [item.id, item]));
  opticById = new Map((data.optics ?? []).map((item) => [item.id, item]));
  filterOptics();
  filterWeapons();
  changeWeapon();
  $("ammunition").value = "556x45mmCartridgeFMJ";
  $("scene").append(
    ...data.scenes.map((item) =>
      option(item.file, `${item.name} · ${item.maxRange} m`),
    ),
  );
  $("scene").value =
    data.scenes.find((item) => item.name.startsWith("IndoorRange"))?.file ??
    data.scenes[0].file;
  $("scene-limit").value = data.scenes.find(
    (item) => item.file === $("scene").value,
  ).maxRange;
  showSimulationNote();
  $("gravity").append(
    ...data.settings.gravityModes.map((mode) =>
      option(mode.value, `${mode.name} · ${fmt(mode.value, 3)} m/s²`),
    ),
  );
  $("fixed-step").value = data.settings.fixedDeltaTime * 1000;
  $("first-step").value = data.settings.fixedDeltaTime * 1000;
  $("build-tag").textContent = `120p3 / ${data.rounds.length} supported rounds`;
  $("model-details").textContent =
    "Gravity before drag; global Mach-dependent drag curve; area from projectile diameter; displacement scaled by the flight multiplier. Single-precision state updates and unweighted Hermite curve interpolation. Time/speed and POI offsets refer to the current optic setting; elevation and windage are the separately solved two-axis low-angle aim corrections. Ordered muzzle devices apply game-derived fixed launch bias, not a lateral free-flight force. Stock mount geometry changes the spawn point, velocity-curve distance and effective sight geometry. Speed is the internal velocity state before displacement scaling. Optic distance remains independent of the selected ammunition class.";
  $("provenance").textContent =
    `Unity ${data.source.unityVersion}. Assembly SHA-256: ${data.source.assemblySha256}. ${data.calibers.length} caliber curves; ${data.scenes.length} scene presets; numeric parameters extracted locally from ${data.source.inputs.length} source files.`;
  $("excluded-summary").textContent =
    `${data.excluded.length} unavailable projectile variants — integrators not modeled`;
  for (const item of data.excluded) {
    const li = document.createElement("li");
    li.textContent = `${item.name}: ${item.reason}`;
    $("excluded-rounds").append(li);
  }
  $("workspace").hidden = false;
  if (document.defaultView.matchMedia?.("(max-width: 900px)").matches) {
    for (const section of form.querySelectorAll(".setup-scroll > .setup-section"))
      if (section.id !== "favorites-section") section.open = false;
  }
  initializeFavorites();
  const savedInterface = favoritesEnabled ? interfaceStore.read() : null;
  const restoredInterface = savedInterface && restoreInterface(savedInterface);
  showRoundFacts();
  form.addEventListener("submit", runCalculation);
  form.addEventListener("input", (event) => {
    if (event.target.closest("#favorites-section")) return;
    if (["ammo-search", "weapon-search", "muzzle-search", "muzzle-kind", "muzzle-device", "optic-search"].includes(event.target.id)) return;
    if (event.target.id === "optic-rail-position") applyOpticGeometry();
    if (["sight-height", "sight-setback"].includes(event.target.id)) showOpticNote();
    if (event.target.id === "shot-charge") {
      $("velocity-multiplier").value = selectedPreset()?.velocityMultiplier ?? "";
    }
    if (manualMuzzleGeometry() && ["barrel-length", "muzzle-forward-shift", "muzzle-up-shift"].includes(event.target.id))
      $("confirm-muzzle-geometry").checked = false;
    if (event.target.id === "shot-charge" || presetFields.some(([id]) => id === event.target.id))
      showWeaponNote();
    if (["muzzle-forward-shift", "muzzle-up-shift", "confirm-muzzle-geometry"].includes(event.target.id)) showMuzzleNote();
    invalidate();
  });
  form.addEventListener("change", (event) => {
    if (event.target.closest("#favorites-section")) return;
    if (["weapon-search", "muzzle-search", "muzzle-kind", "muzzle-device", "optic-search"].includes(event.target.id)) return;
    if (event.target.id === "weapon") {
      changeWeapon();
    } else if (event.target.id === "weapon-chamber") {
      applyWeaponPreset();
      $("ammo-search").value = "";
      filterRounds();
      refreshMuzzleSetup(true);
      applyOpticGeometry();
    } else if (event.target.id === "optic") {
      refreshOpticMounts();
      applyOpticDefaults();
    } else if (event.target.id === "optic-mount") {
      $("optic-rail-position").value = "50";
      showOpticMountControls();
      applyOpticGeometry();
      invalidate();
    } else if (event.target.id === "optic-rail-position") {
      applyOpticGeometry();
      invalidate();
    } else if (event.target.id === "muzzle-geometry-mode") {
      refreshMuzzleSetup(true);
      invalidate();
    } else if (event.target.id === "scene") {
      $("scene-limit").value = data.scenes.find(
        (item) => item.file === $("scene").value,
      ).maxRange;
      showSimulationNote();
      invalidate();
    } else {
      showRoundFacts();
      invalidate();
    }
  });
  $("ammo-search").addEventListener("input", filterRounds);
  $("weapon-search").addEventListener("input", filterWeapons);
  $("optic-search").addEventListener("input", filterOptics);
  $("restore-optic").addEventListener("click", applyOpticDefaults);
  $("restore-weapon").addEventListener("click", applyWeaponPreset);
  $("muzzle-search").addEventListener("input", filterMuzzleDevices);
  $("muzzle-kind").addEventListener("change", filterMuzzleDevices);
  $("muzzle-device").addEventListener("change", previewMuzzleDevice);
  $("add-muzzle-device").addEventListener("click", () => {
    const device = muzzleDeviceById.get($("muzzle-device").value);
    if (!device || $("add-muzzle-device").disabled) return;
    muzzleDevices.push(device);
    refreshMuzzleSetup(true);
    invalidate();
  });
  $("clear-muzzle-devices").addEventListener("click", () => {
    muzzleDevices = [];
    refreshMuzzleSetup(true);
    invalidate();
  });
  $("muzzle-loadout").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled) return;
    const index = Number(button.dataset.index);
    if (button.dataset.action === "remove") muzzleDevices.splice(index, 1);
    else {
      const next = index + (button.dataset.action === "earlier" ? -1 : 1);
      [muzzleDevices[index], muzzleDevices[next]] = [muzzleDevices[next], muzzleDevices[index]];
    }
    refreshMuzzleSetup(true);
    invalidate();
  });
  $("export-csv").addEventListener("click", () => {
    if (!currentSolution) return;
    const round = selectedRound();
    const provenance = `"Assembly SHA256","${data.source.assemblySha256}"\r\n"Source prefab","${round.source.bundle}/${round.source.assetName}"\r\n`;
    const url = URL.createObjectURL(
      new Blob([provenance, toCSV(currentSolution, round, currentOptions)], {
        type: "text/csv;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${round.id}-${currentOptions.zeroRange}m.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  if (!restoredInterface || savedInterface.calculated) await runCalculation();
  else invalidate("Remembered setup restored. Calculate to update the firing solution.");
  if (restoredInterface) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    document.querySelector(".setup-scroll").scrollTop = savedInterface.scroll.setupTop;
    document.querySelector(".table-scroll").scrollLeft = savedInterface.scroll.tableLeft;
    document.querySelector(".table-scroll").scrollTop = savedInterface.scroll.tableTop ?? 0;
    if (savedInterface.scroll.pageX || savedInterface.scroll.pageY)
      document.defaultView.scrollTo(savedInterface.scroll.pageX, savedInterface.scroll.pageY);
  }
  initializeInterfacePersistence();
}

start().catch((error) => {
  $("load-error").textContent = error.message;
  $("load-error").hidden = false;
  $("build-tag").textContent = "Local data unavailable";
});
