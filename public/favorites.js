const COOKIE_NAME = "h3vrbc_favorites";
const COOKIE_DAYS = 365;
const MAX_COOKIE_LENGTH = 3800;
const RECORD_KEYS = ["id", "name", "weaponId", "chamberIndex", "roundId", "attachmentIds"];
const OPTIC_KEYS = ["opticId", "opticMountIndex", "opticRailPosition", "zeroModel", "zeroRange"];

function isIdentifier(value, maxLength = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && value.trim().length > 0;
}

function isFavorite(value) {
  const base = value !== null && typeof value === "object" && !Array.isArray(value)
    && RECORD_KEYS.every((key) => Object.hasOwn(value, key))
    && isIdentifier(value.id, 128)
    && typeof value.name === "string" && value.name.length > 0 && value.name.length <= 60 && value.name.trim().length > 0
    && isIdentifier(value.weaponId)
    && Number.isSafeInteger(value.chamberIndex) && value.chamberIndex >= 0
    && isIdentifier(value.roundId)
    && Array.isArray(value.attachmentIds) && Array.from(value.attachmentIds).every((id) => isIdentifier(id));
  if (!base) return false;
  // Existing six-field records remain readable and are never rewritten on read.
  if (Object.keys(value).length === RECORD_KEYS.length) return true;
  return Object.keys(value).length === RECORD_KEYS.length + OPTIC_KEYS.length
    && OPTIC_KEYS.every((key) => Object.hasOwn(value, key))
    && (value.opticId === "" || isIdentifier(value.opticId))
    && (value.opticMountIndex === null || Number.isSafeInteger(value.opticMountIndex) && value.opticMountIndex >= 0)
    && (value.opticRailPosition === null || Number.isFinite(value.opticRailPosition) && value.opticRailPosition >= 0 && value.opticRailPosition <= 1)
    && (value.opticId !== "" || value.opticMountIndex === null && value.opticRailPosition === null)
    && (value.opticMountIndex !== null || value.opticRailPosition === null)
    && ["game", "geometric", "unadjusted", "calculated"].includes(value.zeroModel)
    && Number.isInteger(value.zeroRange) && value.zeroRange >= 1 && value.zeroRange <= 5000;
}

function validFavorites(favorites) {
  return Array.isArray(favorites) && Array.from(favorites).every(isFavorite)
    && new Set(favorites.map((favorite) => favorite.id)).size === favorites.length;
}

// Calling write is the opt-in action. Constructing or reading the store never
// creates a cookie, including when an existing cookie cannot be understood.
export function createFavoriteStore(document) {
  function cookieValue() {
    const prefix = `${COOKIE_NAME}=`;
    const cookie = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
    return cookie === undefined ? null : cookie.slice(prefix.length);
  }

  function attributes() {
    return `Path=/; SameSite=Strict${document.location?.protocol === "https:" ? "; Secure" : ""}`;
  }

  function read() {
    try {
      const value = cookieValue();
      if (value === null) return null;
      const payload = JSON.parse(decodeURIComponent(value));
      return payload !== null && typeof payload === "object" && !Array.isArray(payload)
        && payload.version === 1 && payload.consent === true && validFavorites(payload.favorites)
        ? payload.favorites : null;
    } catch {
      return null;
    }
  }

  function write(favorites) {
    if (!validFavorites(favorites)) throw new Error("The favorite setups are invalid. Check the weapon, chamber, round, attachments, optic and zero setting, and use a name of 1–60 characters.");
    const value = encodeURIComponent(JSON.stringify({ version: 1, consent: true, favorites }));
    const expires = new Date(Date.now() + COOKIE_DAYS * 86400000).toUTCString();
    const cookie = `${COOKIE_NAME}=${value}; Max-Age=${COOKIE_DAYS * 86400}; Expires=${expires}; ${attributes()}`;
    if (cookie.length > MAX_COOKIE_LENGTH) throw new Error("These favorites exceed the cookie's storage limit. Remove a favorite or shorten its name before saving.");
    try {
      document.cookie = cookie;
      if (cookieValue() !== value) throw new Error("Cookie was not stored");
    } catch {
      throw new Error("Your browser did not save the favorites cookie. Allow cookies for this site to save favorites.");
    }
  }

  function clear() {
    try {
      if (cookieValue() === null) return;
      document.cookie = `${COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${attributes()}`;
      if (cookieValue() !== null) throw new Error("Cookie was not removed");
    } catch {
      throw new Error("Your browser did not remove the favorites cookie. Delete this site's cookies in your browser settings.");
    }
  }

  return { read, write, clear };
}
