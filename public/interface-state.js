const COOKIE_NAME = "h3vrbc_interface";
const COOKIE_DAYS = 365;
const MAX_COOKIE_LENGTH = 3800;
const STATE_KEYS = ["values", "attachmentIds", "sections", "scroll", "calculated"];
const SCROLL_KEYS = ["pageX", "pageY", "setupTop", "tableLeft"];

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isControlId(value) {
  return value.length <= 64 && /^[a-z][a-z0-9-]*$/.test(value);
}

function validMap(value, limit, validValue) {
  return isPlainObject(value) && Object.keys(value).length <= limit
    && Object.entries(value).every(([key, entry]) => isControlId(key) && validValue(entry));
}

function validScroll(scroll) {
  return (hasKeys(scroll, SCROLL_KEYS) || hasKeys(scroll, [...SCROLL_KEYS, "tableTop"]))
    && Object.values(scroll).every((value) => Number.isFinite(value) && value >= 0 && value <= 10000000);
}

function isState(state) {
  return hasKeys(state, STATE_KEYS)
    && validMap(state.values, 50, (value) => typeof value === "boolean" || (typeof value === "string" && value.length <= 512))
    && Array.isArray(state.attachmentIds) && state.attachmentIds.length <= 32
    && Array.from(state.attachmentIds).every((id) => typeof id === "string" && id.length > 0 && id.length <= 256 && id.trim().length > 0)
    && validMap(state.sections, 20, (value) => typeof value === "boolean")
    && validScroll(state.scroll)
    && typeof state.calculated === "boolean";
}

// Consent belongs to the caller. Creating or reading this store never writes a
// cookie; the interface cookie does not independently record or grant consent.
export function createInterfaceStore(document) {
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
      return hasKeys(payload, ["version", "state"]) && payload.version === 1 && isState(payload.state)
        ? payload.state : null;
    } catch {
      return null;
    }
  }

  function write(state) {
    if (!isState(state)) throw new Error("Interface changes could not be saved because the interface settings are invalid.");
    const value = encodeURIComponent(JSON.stringify({ version: 1, state }));
    const expires = new Date(Date.now() + COOKIE_DAYS * 86400000).toUTCString();
    const cookie = `${COOKIE_NAME}=${value}; Max-Age=${COOKIE_DAYS * 86400}; Expires=${expires}; ${attributes()}`;
    if (cookie.length > MAX_COOKIE_LENGTH) throw new Error("Interface changes could not be saved because they exceed the cookie's storage limit.");
    try {
      document.cookie = cookie;
      if (cookieValue() !== value) throw new Error("Cookie was not stored");
    } catch {
      throw new Error("Interface changes could not be saved. Allow cookies for this site in your browser settings.");
    }
  }

  function clear() {
    try {
      if (cookieValue() === null) return;
      document.cookie = `${COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${attributes()}`;
      if (cookieValue() !== null) throw new Error("Cookie was not removed");
    } catch {
      throw new Error("Saved interface settings could not be removed. Delete this site's cookies in your browser settings.");
    }
  }

  return { read, write, clear };
}
