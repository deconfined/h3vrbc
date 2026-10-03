import test from "node:test";
import assert from "node:assert/strict";
import { CookieJar } from "jsdom";
import { mount, waitFor } from "./helpers/app.mjs";
import { dataset } from "./helpers/optics.mjs";

async function controls(name, t, { cookieJar, data = dataset } = {}) {
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
    assert.equal($("setup-form").checkValidity(), true,
      [...$("setup-form").querySelectorAll(":invalid")].map((field) => field.id).join(", "));
    $("setup-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => !$("setup-form").querySelector('button[type="submit"]').disabled);
    assert.equal($("solution").hidden, false, $("calculation-error").textContent);
  };
  const metrics = () => [$("hold-value").textContent, $("windage-value").textContent, $("range-rows").textContent];
  return { $, dom, set, recalculate, metrics, close: stop };
}

test("cant modes enable exactly one input and show compensated dials or fixed-dial uncertainty, never both", async (t) => {
  const { $, set, recalculate, metrics } = await controls("cant-modes", t);
  assert.equal($("cant-mode").value, "none");
  assert.equal($("cant-angle-group").hidden, true);
  assert.equal($("cant-angle").disabled, true);
  assert.equal($("cant-tolerance-group").hidden, true);
  assert.equal($("cant-tolerance").disabled, true);
  set("target-range", "300");
  await recalculate();
  const nominal = metrics();
  assert.equal($("cant-result").hidden, true);
  assert.equal($("cant-legend").hidden, true);

  set("cant-mode", "specific", "change");
  assert.equal($("solution").hidden, true);
  assert.equal($("export-csv").disabled, true);
  assert.equal($("cant-angle-group").hidden, false);
  assert.equal($("cant-angle").disabled, false);
  assert.equal($("cant-tolerance-group").hidden, true);
  assert.equal($("cant-tolerance").disabled, true);
  set("cant-angle", "15");
  set("cant-tolerance", "-1"); // Inactive raw values must not enter the solver or native validation.
  assert.equal($("setup-form").checkValidity(), true);
  await recalculate();
  assert.ok(Number($("windage-value").textContent) > 0);
  assert.notDeepEqual(metrics(), nominal);
  assert.match($("cant-result").textContent, /Specific cant 15\.0° \(right\).*compensated/);
  assert.match($("windage-secondary").textContent, /weapon axis/);
  assert.equal($("cant-legend").hidden, true);
  assert.equal($("trajectory-chart").querySelector(".cant-envelope"), null);
  const corrected = $("trajectory-chart").querySelector(".range-point");
  assert.ok(Math.abs(Number(corrected.dataset.heightCm)) < 0.1);
  assert.ok(Math.abs(Number(corrected.dataset.lateralCm)) < 0.1);

  set("cant-mode", "uncertainty"); // The input event must also update visibility.
  assert.equal($("cant-angle-group").hidden, true);
  assert.equal($("cant-angle").disabled, true);
  assert.equal($("cant-tolerance-group").hidden, false);
  assert.equal($("cant-tolerance").disabled, false);
  set("cant-tolerance", "5");
  set("cant-angle", "91");
  assert.equal($("setup-form").checkValidity(), true);
  await recalculate();
  assert.deepEqual(metrics(), nominal, "Uncertainty leaves nominal dial settings and base range card untouched");
  assert.equal($("cant-result").hidden, false);
  assert.match($("cant-result").textContent, /±5\.0°.*cm.*mrad.*displayed dials held fixed/);
  assert.equal($("cant-legend").hidden, false);
  assert.ok($("trajectory-chart").querySelector(".cant-envelope"));
  assert.equal($("trajectory-chart").querySelectorAll(".back-readout-row").length, 3);
  assert.match($("trajectory-chart").querySelector(".back-error-label").textContent, /^ERROR · ±[\d.]+ cm$/,
    "Actual cant uncertainty must be visible beside the wall, not only in explanatory text");
  assert.ok($("trajectory-chart").querySelector(".back-error-offset"));

  set("cant-mode", "none", "change");
  set("cant-tolerance", "");
  assert.equal($("setup-form").checkValidity(), true);
  await recalculate();
  assert.deepEqual(metrics(), nominal);
  assert.equal($("cant-result").hidden, true);
  assert.equal($("cant-legend").hidden, true);
  assert.equal($("trajectory-chart").querySelector(".cant-envelope, .cant-target-uncertainty"), null);
  assert.equal($("trajectory-chart").querySelector(".back-error-label").textContent, "ERROR · —");
});

test("native cant validation checks active finite angles and reveals a collapsed sight section", async (t) => {
  const { $, set } = await controls("cant-validation", t);
  set("cant-mode", "specific", "change");
  for (const value of ["", "-90.1", "90.1"]) {
    set("cant-angle", value);
    $("sight-section").open = false;
    assert.equal($("setup-form").checkValidity(), false);
    assert.equal($("sight-section").open, true);
  }
  for (const value of ["-90", "0", "90"]) {
    set("cant-angle", value);
    assert.equal($("setup-form").checkValidity(), true);
  }
  set("cant-mode", "uncertainty", "change");
  for (const value of ["", "-0.1", "90.1"]) {
    set("cant-tolerance", value);
    assert.equal($("setup-form").checkValidity(), false);
  }
  for (const value of ["0", "5.125", "90"]) {
    set("cant-tolerance", value);
    assert.equal($("setup-form").checkValidity(), true);
  }
});

test("refresh remembers either cant mode, inactive raw inputs and the recomputed solution without rewriting cookies", async (t) => {
  for (const mode of ["specific", "uncertainty"]) {
    const cookieJar = new CookieJar();
    const app = await controls(`cant-save-${mode}`, t, { cookieJar });
    app.$("favorites-consent").checked = true;
    app.$("favorites-consent").dispatchEvent(new app.dom.window.Event("change", { bubbles: true }));
    app.set("cant-mode", mode, "change");
    app.set("cant-angle", "-12.5");
    app.set("cant-tolerance", "7.25");
    await app.recalculate();
    app.dom.window.dispatchEvent(new app.dom.window.Event("pagehide"));
    const cookies = cookieJar.getCookiesSync("http://localhost/");
    const saved = JSON.parse(decodeURIComponent(cookies.find((cookie) => cookie.key === "h3vrbc_interface").value));
    assert.equal(saved.state.values["cant-mode"], mode);
    assert.equal(saved.state.calculated, true);
    assert.equal(app.$("interface-status").hidden, true, app.$("interface-status").textContent);
    const expected = { metrics: app.metrics(), summary: app.$("cant-result").textContent };
    app.close();
    const writes = [];
    const write = cookieJar.setCookieSync.bind(cookieJar);
    cookieJar.setCookieSync = (...args) => { writes.push(args[0]); return write(...args); };
    const restored = await controls(`cant-reload-${mode}`, t, { cookieJar });
    assert.equal(restored.$("cant-mode").value, mode);
    assert.equal(restored.$("cant-angle").value, "-12.5");
    assert.equal(restored.$("cant-tolerance").value, "7.25");
    assert.equal(restored.$("cant-angle").disabled, mode !== "specific");
    assert.equal(restored.$("cant-tolerance").disabled, mode !== "uncertainty");
    assert.equal(restored.$("solution").hidden, false);
    assert.deepEqual(restored.metrics(), expected.metrics);
    assert.equal(restored.$("cant-result").textContent, expected.summary);
    restored.dom.window.dispatchEvent(new restored.dom.window.Event("pagehide"));
    assert.deepEqual(writes, []);
    restored.close();
  }
});

test("old interface snapshots without cant fields restore as level shots without being rewritten", async (t) => {
  const cookieJar = new CookieJar();
  const app = await controls("cant-legacy-source", t, { cookieJar });
  app.$("favorites-consent").checked = true;
  app.$("favorites-consent").dispatchEvent(new app.dom.window.Event("change", { bubbles: true }));
  app.set("target-range", "222");
  await app.recalculate();
  app.dom.window.dispatchEvent(new app.dom.window.Event("pagehide"));
  const value = cookieJar.getCookiesSync("http://localhost/").find((cookie) => cookie.key === "h3vrbc_interface").value;
  const saved = JSON.parse(decodeURIComponent(value));
  for (const key of ["cant-mode", "cant-angle", "cant-tolerance"]) delete saved.state.values[key];
  app.close();
  cookieJar.setCookieSync(`h3vrbc_interface=${encodeURIComponent(JSON.stringify(saved))}; Path=/`, "http://localhost/");
  const writes = [];
  const write = cookieJar.setCookieSync.bind(cookieJar);
  cookieJar.setCookieSync = (...args) => { writes.push(args[0]); return write(...args); };
  const restored = await controls("cant-legacy-reload", t, { cookieJar });
  assert.equal(restored.$("cant-mode").value, "none");
  assert.equal(restored.$("cant-angle").disabled, true);
  assert.equal(restored.$("cant-tolerance").disabled, true);
  assert.equal(restored.$("target-range").value, "222");
  assert.equal(restored.$("solution").hidden, false);
  assert.equal(restored.$("cant-result").hidden, true);
  restored.dom.window.dispatchEvent(new restored.dom.window.Event("pagehide"));
  assert.deepEqual(writes, []);
});

test("unreachable uncertainty reports an unbounded result, keeps nominal dials and omits the partial band", async (t) => {
  const data = { ...dataset, rounds: [{ ...dataset.rounds[0], muzzleVelocity: 100 }] };
  const { $, set, recalculate } = await controls("cant-unreachable", t, { data });
  set("sight-height", "5");
  set("sight-setback", "50");
  set("zero-model", "calculated", "change");
  set("zero-range", "160");
  set("target-range", "160");
  set("range-step", "100");
  set("scene-limit", "160.1");
  set("first-step", "10");
  set("cant-mode", "uncertainty", "change");
  set("cant-tolerance", "90");
  await recalculate();
  assert.equal($("export-csv").disabled, false);
  assert.equal($("cant-result").hidden, false);
  assert.equal($("cant-result").classList.contains("cant-warning"), true);
  assert.match($("cant-result").textContent, /cannot be bounded.*no partial uncertainty band/);
  assert.equal($("cant-legend").hidden, true);
  assert.equal($("trajectory-chart").querySelector(".cant-envelope, .cant-target-uncertainty"), null);
  assert.equal($("trajectory-chart").querySelector(".back-error-label").textContent, "ERROR · UNBOUNDED");
  set("cant-tolerance", "5");
  await recalculate();
  assert.equal($("cant-result").classList.contains("cant-warning"), false);
  assert.equal($("cant-legend").hidden, false);
});
