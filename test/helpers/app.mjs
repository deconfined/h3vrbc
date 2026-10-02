import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");

export async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for app state");
}

export async function mount(data, name, { cookieJar } = {}) {
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true, cookieJar });
  const originals = new Map();
  const globals = {
    document: dom.window.document,
    FormData: dom.window.FormData,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    fetch: async () => ({ ok: true, json: async () => structuredClone(data) }),
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, globalThis[key]);
    globalThis[key] = value;
  }
  await import(`../../public/app.js?test=${name}`);
  return {
    dom,
    close: () => {
      dom.window.close();
      for (const [key, value] of originals) globalThis[key] = value;
    },
  };
}
