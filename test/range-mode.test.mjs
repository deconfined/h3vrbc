import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mount, waitFor } from "./helpers/app.mjs";

const data = JSON.parse(await readFile(new URL("../public/data/h3vr.json", import.meta.url), "utf8").catch((error) => {
  if (error.code !== "ENOENT") throw error;
  return "null";
}));

test("range measurement mode", { skip: !data && "Run npm run extract for install integration checks" }, async (t) => {
  const { dom, close } = await mount(data, "range-mode");
  t.after(close);
  const $ = (id) => dom.window.document.getElementById(id);
  const set = (id, value) => {
    $(id).value = value;
    for (const type of ["input", "change"])
      $(id).dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  };
  const recalculate = async () => {
    $("setup-form").requestSubmit();
    await waitFor(() => !$("setup-form").querySelector('button[type="submit"]').disabled);
  };

  await waitFor(() => $("solution")?.hidden === false);
  set("scene", data.scenes.find((item) => item.maxRange > 2000).file);
  set("target-range", "600");
  set("firing-angle", "30");
  set("range-mode", "sight");
  await recalculate();
  assert.equal($("calculation-error").hidden, true, $("calculation-error").textContent);
  assert.match($("target-label").textContent, /^600\.0 m along sight line · 30\.0°/);
  const sightLineAim = $("hold-value").textContent;

  // The same physical target. Horizontal = sight line x cos(inclination), so
  // 600 m along a 30° sight line is 600·cos(30°) m of horizontal distance and
  // must produce an identical solution.
  set("range-mode", "horizontal");
  set("target-range", String(600 * Math.cos(Math.PI / 6)));
  await recalculate();
  assert.equal($("calculation-error").hidden, true, $("calculation-error").textContent);
  assert.match($("target-label").textContent, /horizontal · 30\.0°/);
  assert.equal($("hold-value").textContent, sightLineAim,
    "A horizontal range and its sight-line equivalent must solve identically");

  // A vertical sight line has no horizontal component; refuse rather than
  // report an unreachable range the user never asked for.
  set("firing-angle", "90");
  await recalculate();
  assert.equal($("calculation-error").hidden, false);
  assert.match($("calculation-error").textContent, /horizontal target range is undefined/);

  set("range-mode", "sight");
  set("firing-angle", "90");
  await recalculate();
  assert.equal($("calculation-error").hidden, true, $("calculation-error").textContent);
});

test("the two simulated shots are labelled apart, and the group cone is reported", { skip: !data && "Run npm run extract for install integration checks" }, async (t) => {
  const { dom, close } = await mount(data, "shot-labels");
  t.after(close);
  const $ = (id) => dom.window.document.getElementById(id);
  const set = (id, value) => {
    $(id).value = value;
    for (const type of ["input", "change"])
      $(id).dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  };
  await waitFor(() => $("solution")?.hidden === false);
  set("weapon", "MRAD");
  $("setup-form").requestSubmit();
  await waitFor(() => !$("setup-form").querySelector('button[type="submit"]').disabled);
  assert.equal($("calculation-error").hidden, true, $("calculation-error").textContent);

  // The base flight time and the corrected impact are different measurements of
  // two different shots, and both are labelled so neither can be mistaken for
  // the plotted trajectory.
  assert.match(dom.window.document.querySelector("#flight-time").closest(".metric").textContent, /BASE SHOT FLIGHT TIME[\s\S]*uncorrected/);
  assert.match(dom.window.document.querySelector("#corrected-impact").closest(".metric").textContent, /CORRECTED IMPACT[\s\S]*corrected/);
  assert.match(dom.window.document.querySelector(".chart-heading h2").textContent, /^Corrected trajectory/);
  assert.match(dom.window.document.querySelector(".table-heading h2").textContent, /uncorrected/);
  assert.match(dom.window.document.querySelector(".table-note").textContent, /base shot.*corrected shot/s);
  assert.notEqual($("flight-time").textContent, $("corrected-detail").textContent.split(" s")[0]);

  // The cone is a bound on a random per-weapon draw, and says so.
  const detail = $("spread-detail").textContent;
  assert.match($("spread-diameter").textContent, /^\d+\.\d$/);
  assert.match(detail, /MOA bound/);
  assert.match(detail, /not a predicted group/);
  const readout = [...$("trajectory-chart").querySelectorAll(".back-readout-label")];
  assert.equal(readout.length, 4);
  assert.match(readout.at(-1).textContent, /^CONE · /);
});

test("an uncertified weapon accuracy class widens the reported cone honestly", { skip: !data && "Run npm run extract for install integration checks" }, async (t) => {
  const { dom, close } = await mount(data, "cone-incomplete");
  t.after(close);
  const $ = (id) => dom.window.document.getElementById(id);
  const set = (id, value) => {
    $(id).value = value;
    for (const type of ["input", "change"])
      $(id).dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  };
  // M320GrenadeLauncher is the one extracted weapon without an accuracy class.
  const bare = data.weapons.find((item) => !Number.isInteger(item.accuracyClass));
  if (!bare) return;
  set("weapon", bare.id);
  $("setup-form").requestSubmit();
  await waitFor(() => !$("setup-form").querySelector('button[type="submit"]').disabled);
  if ($("calculation-error").hidden === false) return; // no usable round for this chamber
  assert.match($("spread-diameter").textContent, /^≥/, "An un-certified term must read as a lower bound");
  assert.match($("spread-detail").textContent, /accuracy class/);
  const cells = $("range-rows").querySelector(".target-row").children;
  assert.match(cells[cells.length - 1].textContent, /^≥/);
});