import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CookieJar } from "jsdom";
import { mount, waitFor } from "./helpers/app.mjs";
import { dataset, optic } from "./helpers/optics.mjs";

const closeNumber = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

async function controls(data, name, t, cookieJar) {
  const { dom, close } = await mount(data, name, { cookieJar });
  let closed = false;
  const stop = () => { if (!closed) { closed = true; close(); } };
  t.after(stop);
  const $ = (id) => dom.window.document.getElementById(id);
  await waitFor(() => !$('workspace').hidden || !$('load-error').hidden);
  await new Promise((resolve) => dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(resolve)));
  assert.equal($("load-error").hidden, true, $("load-error").textContent);
  const set = (id, value, type = "input") => {
    $(id).value = value;
    $(id).dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  };
  const recalculate = async () => {
    $("setup-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => !$("setup-form").querySelector('button[type="submit"]').disabled);
    assert.equal($("solution").hidden, false, $("calculation-error").textContent);
  };
  return { $, dom, set, recalculate, close: stop };
}

test("optic selection fills midpoint geometry and zero settings; rail edits and manual overrides remain usable", async (t) => {
  const { $, dom, set, recalculate } = await controls(dataset, "optic-defaults", t);
  set("weapon", "Rifle", "change");
  set("optic", optic.id, "change");
  assert.equal($("optic-mount").value, "0");
  assert.equal($("optic-rail-position").valueAsNumber, 50);
  assert.equal($("optic-rail-position").disabled, false);
  assert.equal($("zero-model").value, "game");
  assert.equal($("zero-range").valueAsNumber, 100);
  closeNumber($("sight-height").valueAsNumber, 5);
  closeNumber($("sight-setback").valueAsNumber, 40);
  assert.match($("optic-note").textContent, /midpoint/);
  assert.equal($("setup-form").checkValidity(), true);
  await recalculate();
  set("optic-search", "no matches");
  $("optic-search").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal($("optic").value, optic.id);
  assert.equal($("solution").hidden, false, "Searching must preserve the calculation and active optic");
  set("optic-rail-position", "25");
  closeNumber($("sight-setback").valueAsNumber, 45);
  closeNumber($("sight-height").valueAsNumber, 5);
  assert.equal($("solution").hidden, true);
  set("sight-height", "7.123456789");
  assert.match($("optic-note").textContent, /Manual sight geometry overrides/);
  assert.equal($("setup-form").checkValidity(), true, "Extracted or manual precision must not cause step mismatch");
  $("restore-optic").click();
  closeNumber($("sight-height").valueAsNumber, 5);
  closeNumber($("sight-setback").valueAsNumber, 45);
  assert.equal($("optic-rail-position").valueAsNumber, 25, "Restoration keeps the chosen rail position");
  await recalculate();
  const original = URL.createObjectURL;
  let blob;
  URL.createObjectURL = (value) => { blob = value; return original(value); };
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  t.after(() => { URL.createObjectURL = original; });
  $("export-csv").click();
  const csv = await blob.text();
  assert.ok(csv.includes('"Optic","Test Scope"'));
  assert.ok(csv.includes('"Optic direct mount","Top rail"'));
  assert.ok(csv.includes('"Optic rail position percent (50 assumes midpoint)","25"'));
  assert.ok(csv.includes('"Sight geometry","Forward-facing stock direct mount'));
  set("optic", "", "change");
  closeNumber($("sight-setback").valueAsNumber, 45, "Manual mode preserves editable measurements");
  assert.equal($("optic-mount-group").hidden, true);
  assert.equal($("optic-rail-position").disabled, true);
});

test("fixed, multiple, missing and dynamic mounts never keep stale geometry, and each barrel uses its own muzzle", async (t) => {
  const { $, set } = await controls(dataset, "optic-mounts", t);
  set("weapon", "Fixed", "change");
  set("optic", optic.id, "change");
  assert.equal($("optic-rail-position").disabled, true);
  closeNumber($("sight-setback").valueAsNumber, 30);
  set("weapon", "Multiple", "change");
  assert.equal($("optic-mount").value, "");
  assert.equal($("sight-height").value, "");
  assert.equal($("sight-setback").value, "");
  set("optic-mount", "1", "change");
  assert.equal($("optic-rail-position").valueAsNumber, 50);
  closeNumber($("sight-setback").valueAsNumber, 40);
  set("weapon", "Combo", "change");
  set("weapon-chamber", "1", "change");
  closeNumber($("sight-height").valueAsNumber, 4);
  closeNumber($("sight-setback").valueAsNumber, 20);
  set("weapon", "NoMount", "change");
  assert.equal($("sight-height").value, "");
  assert.match($("optic-note").textContent, /Adapters and risers/);
  set("weapon", "Rifle", "change");
  set("optic", "Dynamic:45", "change");
  assert.equal($("sight-height").value, "");
  assert.match($("optic-note").textContent, /live extension/);
  set("optic", "Reflex:43", "change");
  assert.equal($("zero-range").valueAsNumber, 10);
  set("optic", "Night:44", "change");
  assert.equal($("zero-model").value, "unadjusted");
  assert.equal($("zero-range").valueAsNumber, 10, "An unadjusted optic does not set an invalid zero range of 0");
});

test("opt-in refresh preserves optic, mount, rail position, search and manual sight overrides", async (t) => {
  const cookieJar = new CookieJar();
  const app = await controls(dataset, "optic-save", t, cookieJar);
  const { $, dom, set } = app;
  $("favorites-consent").checked = true;
  $("favorites-consent").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  set("weapon", "Multiple", "change");
  set("optic", optic.id, "change");
  set("optic-mount", "1", "change");
  set("optic-rail-position", "17.5");
  set("sight-height", "7.123456789");
  set("sight-setback", "65.987654321");
  set("optic-search", "no matches");
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  assert.ok(cookieJar.getCookiesSync("http://localhost/").some((cookie) => cookie.key === "h3vrbc_interface"));
  app.close();
  const restored = await controls(dataset, "optic-reload", t, cookieJar);
  assert.equal(restored.$("optic").value, optic.id);
  assert.equal(restored.$("optic-mount").value, "1");
  assert.equal(restored.$("optic-rail-position").valueAsNumber, 17.5);
  assert.equal(restored.$("optic-rail-position").disabled, false);
  assert.equal(restored.$("optic-search").value, "no matches");
  assert.equal(restored.$("sight-height").value, "7.123456789");
  assert.equal(restored.$("sight-setback").value, "65.987654321");
  assert.match(restored.$("optic-note").textContent, /Manual sight geometry overrides/);
  assert.equal(restored.$("solution").hidden, true);
});

test("an unavailable saved optic rejects the snapshot without partially applying old geometry", async (t) => {
  const cookieJar = new CookieJar();
  const app = await controls(dataset, "optic-stale-save", t, cookieJar);
  app.$("favorites-consent").checked = true;
  app.$("favorites-consent").dispatchEvent(new app.dom.window.Event("change", { bubbles: true }));
  app.set("weapon", "Rifle", "change");
  app.set("optic", optic.id, "change");
  app.set("sight-height", "9");
  app.dom.window.dispatchEvent(new app.dom.window.Event("pagehide"));
  app.close();
  const restored = await controls({ ...dataset, optics: [] }, "optic-stale-reload", t, cookieJar);
  assert.equal(restored.$("optic").value, "");
  assert.equal(restored.$("weapon").value, "");
  assert.equal(restored.$("sight-height").valueAsNumber, 5);
  assert.equal(restored.$("favorites-consent").checked, true);
  assert.match(restored.$("interface-status").textContent, /optic or direct weapon mount is no longer available/);
});

let data;
try {
  data = JSON.parse(await readFile(new URL("../public/data/h3vr.json", import.meta.url), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
test("actual M4 and ACOG fill bare-muzzle defaults at the assumed rail midpoint and calculate", { skip: !data?.optics && "Regenerate local data for optic UI integration" }, async (t) => {
  const { $, set, recalculate } = await controls(data, "optic-real-game", t);
  assert.equal($("optic").options.length, 84);
  set("weapon", "M4Carbine", "change");
  set("optic", data.optics.find((item) => item.attachmentId === "ScopeAcog4x32").id, "change");
  closeNumber($("sight-height").valueAsNumber, 6.989004462951454);
  closeNumber($("sight-setback").valueAsNumber, 56.56499452888966);
  assert.equal($("setup-form").checkValidity(), true);
  await recalculate();
  const bareHeight = $("sight-height").value;
  const bareSetback = $("sight-setback").value;
  set("muzzle-device", "SuppressorMk12", "change");
  $("add-muzzle-device").click();
  assert.equal($("sight-height").value, bareHeight, "Muzzle devices must preserve bare optic defaults");
  assert.equal($("sight-setback").value, bareSetback);
  await recalculate();
});
