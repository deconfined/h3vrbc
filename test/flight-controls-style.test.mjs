import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../public/style.css", import.meta.url), "utf8");

// A real browser renders this stylesheet, but the test environment has no
// layout engine, so a regression in the flight-control bar would otherwise only
// ever be caught by looking at it. These checks encode the invariants that keep
// the buttons and dropdowns reading as one control group.
function declarationsFor(selector) {
  const out = {};
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // Later rules win, matching the cascade for equal specificity.
  for (const block of stripped.split("}")) {
    const brace = block.lastIndexOf("{");
    if (brace < 0) continue;
    const head = block.slice(0, brace).trim();
    if (head.startsWith("@")) continue;
    if (!head.split(",").some((part) => part.trim() === selector)) continue;
    for (const declaration of block.slice(brace + 1).split(";")) {
      const index = declaration.indexOf(":");
      if (index > 0) out[declaration.slice(0, index).trim()] = declaration.slice(index + 1).trim();
    }
  }
  return out;
}

const BUTTONS = [".flight-controls .secondary"];
const SELECTS = ["#flight-rate", "#reference-frame"];

test("flight buttons and dropdowns resolve to one identical box", () => {
  const boxes = new Map();
  for (const selector of [...BUTTONS, ...SELECTS]) boxes.set(selector, declarationsFor(selector));
  const reference = declarationsFor(BUTTONS[0]);
  // The setup form sizes its fields for full-width inputs, so the bar has to
  // restate height and padding rather than inherit them. If it stops doing that,
  // the dropdowns silently return to the 38px form minimum while the buttons
  // shrink to their text.
  for (const property of ["height", "min-height", "padding", "font", "border", "border-radius", "background", "color"]) {
    assert.ok(reference[property], `${property} must be set explicitly on the flight controls`);
  }
  assert.equal(reference.height, "26px");
  assert.equal(reference["min-height"], reference.height, "min-height must not fall back to the 38px form default");
  for (const [selector, declarations] of boxes) {
    for (const property of ["height", "min-height", "padding", "font", "border", "background"]) {
      assert.equal(declarations[property], reference[property],
        `${selector} disagrees on ${property}: ${declarations[property]} vs ${reference[property]}`);
    }
  }
});

test("the global form field rules cannot reach the flight controls", () => {
  const form = declarationsFor("select");
  assert.equal(form["min-height"], "38px", "the form default this test guards against should still exist");
  assert.equal(form["font-size"], "12px");
  for (const selector of SELECTS) {
    const control = declarationsFor(selector);
    // Specificity has to beat the bare element selector, or the override is a
    // no-op regardless of source order.
    assert.match(selector, /#/, `${selector} must outrank the element selector to win`);
    assert.equal(control.height, "26px");
    assert.equal(control["min-height"], "26px");
    assert.equal(control.width, "auto", "the dropdowns must hug their content, not fill the bar");
  }
});

test("dropdown labels sit above their controls, not beside them", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const control of ["flight-rate", "reference-frame"]) {
    // Each label/control pair is its own stacked field, so no label text ever
    // shares a row with a control box and there is no baseline to lose.
    const stacked = new RegExp(`<div class="flight-field">\\s*<label for="${control}">[^<]+</label>\\s*<select id="${control}"`).test(html);
    assert.ok(stacked, `${control} must be wrapped in a .flight-field with its label first`);
    assert.doesNotMatch(html, new RegExp(`class="flight-control-label"[^>]*for="${control}"`),
      `${control} must not use a beside-the-control label`);
  }
  const field = declarationsFor(".flight-field");
  assert.equal(field.display, "flex");
  assert.equal(field["flex-direction"], "column");
  assert.equal(field.flex, "0 0 auto");
  // A small-caps label is the right hierarchy now that it has a row to itself,
  // and it no longer has to match the controls' type.
  const label = declarationsFor(".flight-field > label");
  assert.equal(label["text-transform"], "uppercase");
  assert.notEqual(label.font, declarationsFor(BUTTONS[0]).font,
    "a stacked label must not be forced to match the controls' font");
});

test("the controls are an overlay in the chart's empty lower-right quadrant", () => {
  const controls = declarationsFor(".flight-controls");
  // Absolutely positioned inside the frame rather than laid out as a row of its
  // own, which is what reclaims the dead space below and right of the plot.
  assert.equal(controls.position, "absolute");
  assert.equal(controls["flex-direction"], "column");
  assert.ok(controls.right, "must be anchored to the right edge");
  assert.ok(controls.bottom, "must be anchored to the bottom edge");
  assert.ok(controls.width, "a fixed width keeps the column from stretching with its content");
  // A column that grows with its content would push past the quadrant.
  assert.equal(controls["align-items"], undefined);
  assert.equal(declarationsFor(".chart-frame").position, "relative");
  // It has to be a stacking context above the plot it now overlaps on narrow
  // viewports.
  assert.ok(Number(controls["z-index"]) > 0);
});

test("the stacked controls are compact enough to clear the free quadrant", () => {
  // Budget from the measured occupancy map: the free block at the bottom right
  // is 160px tall and the panel itself needs breathing room inside it.
  const control = declarationsFor(BUTTONS[0]);
  const height = Number.parseFloat(control.height);
  const labelHeight = Number.parseFloat(declarationsFor(".flight-field > label").font) * 1.2;
  const fieldGap = Number.parseFloat(declarationsFor(".flight-field").gap);
  const outerGap = Number.parseFloat(declarationsFor(".flight-controls").gap);
  const outerPadding = 2 * 9;
  // Transport row, two stacked label/control fields, and the clock line.
  const total = height + outerGap + (labelHeight + fieldGap + height) * 2
    + outerGap + Number.parseFloat(declarationsFor(".flight-clock").font) * 1.4
    + outerPadding;
  assert.ok(total <= 160, `the control column needs ${total.toFixed(0)}px but only 160px is free`);
});

test("nothing in the control group stretches or wraps", () => {
  // In a column the buttons and dropdowns should share the panel width, which is
  // what lines their edges up. Only the wrapper groups must not grow.
  for (const selector of [...BUTTONS, ...SELECTS]) {
    const declarations = declarationsFor(selector);
    assert.equal(declarations.flex, "1 1 0", `${selector} should share the column width`);
    assert.equal(declarations["min-width"], "0", `${selector} must be able to shrink below its content`);
  }
  for (const selector of [".flight-field", ".flight-transport", ".flight-clock"]) {
    assert.equal(declarationsFor(selector).flex, "0 0 auto", `${selector} must not grow or shrink`);
  }
  for (const selector of [...BUTTONS, ...SELECTS, ".flight-clock"]) {
    assert.equal(declarationsFor(selector)["white-space"], "nowrap", `${selector} must not wrap`);
  }
});

test("every flight control has usable options, so a deployed select is never empty", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const id of ["reference-frame", "flight-rate"]) {
    const select = new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
    assert.ok(select, `${id} must be present in index.html`);
    const options = [...select[1].matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(options.length >= 2, `${id} has ${options.length} option(s); a self-closing or stripped select renders empty`);
    // Every option must be a non-empty, distinct value.
    for (const value of options) {
      assert.ok(value.trim().length > 0, `${id} has an empty option value`);
      assert.equal(typeof value, "string");
    }
    assert.equal(new Set(options).size, options.length, `${id} has duplicate option values`);
  }
});
