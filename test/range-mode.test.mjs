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

test("both dial cells carry their own base POI line", { skip: !data && "Run npm run extract for install integration checks" }, async (t) => {
  const { dom, close } = await mount(data, "dial-poi");
  t.after(close);
  const $ = (id) => dom.window.document.getElementById(id);
  const set = (id, value) => {
    $(id).value = value;
    for (const type of ["input", "change"])
      $(id).dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  };
  await waitFor(() => $("solution")?.hidden === false);
  set("weapon", "MRAD");
  set("scene", data.scenes.find((item) => item.maxRange > 2000).file);
  set("target-range", "400");
  $("setup-form").requestSubmit();
  await waitFor(() => !$("setup-form").querySelector('button[type="submit"]').disabled);
  assert.equal($("calculation-error").hidden, true, $("calculation-error").textContent);

  // Elevation reports the base shot's height offset, windage its lateral one,
  // each phrased like the cell it sits under rather than as a dial change.
  assert.match($("height-label").textContent, /^Base POI: \d+\.\d\d cm (high|low|\(centered\)) of POA$/);
  assert.match($("lateral-label").textContent, /^Base POI: \d+\.\d\d cm (right|left|\(centered\)) of POA$/);

  // Both dial cells are the full-height ones, and each carries a POI line.
  const stacked = [...dom.window.document.querySelectorAll(".metrics > .metric.stacked")];
  assert.equal(stacked.length, 2);
  assert.deepEqual(stacked.map((cell) => cell.querySelector(".metric-label").id),
    ["hold-label", "windage-label"]);
  for (const cell of stacked) assert.equal(cell.querySelectorAll(".metric-detail").length, 2);

  // The elevation cell's height and the chart's RISE/DROP describe the same
  // separation, but not identically: the metric is the traced base flight while
  // the chart extrapolates the uncorrected POI ray. Sign and wording must match
  // and the magnitudes must agree to a millimetre, which catches any scale or
  // sign error without demanding the two be the same measurement.
  const readout = [...$("trajectory-chart").querySelectorAll(".back-readout-label")][0].textContent;
  const wall = /^(RISE|DROP) · ([\d.]+) cm$/.exec(readout);
  assert.ok(wall, readout);
  const metric = /^Base POI: ([\d.]+) cm (high|low|\(centered\)) of POA$/.exec($("height-label").textContent);
  assert.ok(metric, $("height-label").textContent);
  assert.equal(metric[2], wall[1] === "RISE" ? "high" : "low");
  assert.ok(Math.abs(Number(metric[1]) - Number(wall[2])) <= 0.1,
    `metric ${metric[1]} cm and chart ${wall[2]} cm describe the same separation`);
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
  assert.match(dom.window.document.querySelector("#flight-time").closest(".metric").textContent, /SHOT FLIGHT TIME[\s\S]*corrected/);
  assert.match(dom.window.document.querySelector("#corrected-impact").closest(".metric").textContent, /CORRECTED IMPACT[\s\S]*corrected/);
  assert.match(dom.window.document.querySelector(".chart-heading h2").textContent, /^Corrected trajectory/);
  assert.match(dom.window.document.querySelector(".table-heading h2").textContent, /uncorrected/);
  assert.match(dom.window.document.querySelector(".table-note").textContent, /base shot.*corrected shot/s);
  // Flight time now belongs to the corrected shot, so it must match the
  // corrected impact's own time rather than differ from it.
  const correctedTime = /in ([\d.]+) s$/.exec($("corrected-detail").textContent);
  assert.ok(correctedTime, $("corrected-detail").textContent);
  assert.equal($("flight-time").textContent, correctedTime[1]);
  // The range card stays on the base shot, where the two flight times can
  // coincide numerically; what must hold is that the card still says so.
  assert.match(dom.window.document.querySelector(".table-heading h2").textContent, /uncorrected/);

  // The cone is a bound on a random per-weapon draw, and says so.
  const detail = $("spread-detail").textContent;
  assert.match($("spread-diameter").textContent, /^\d+\.\d$/);
  assert.match(detail, /MOA bound/);
  assert.match(detail, /not a predicted group/);
  const readout = [...$("trajectory-chart").querySelectorAll(".back-readout-label")];
  assert.equal(readout.length, 5);
  assert.match(readout.at(-2).textContent, /^CONE · /);
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