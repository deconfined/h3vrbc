// Off-main-thread host for the projectile solve. A long table interval and a
// fine fixed tick together make calculate() expensive enough to freeze the tab,
// so the browser runs it here; environments without module workers keep using
// the synchronous path in app.js.
import { calculate } from "./physics.js";

export function solve(request) {
  try {
    return {
      ok: true,
      solution: calculate(request.profile, request.settings, request.options),
    };
  } catch (error) {
    // Errors are expected control flow here: unreachable flight, a missing
    // accuracy entry, an unsolvable range. Pass the message, not the stack.
    return { ok: false, message: error?.message ?? "The firing solution could not be calculated." };
  }
}

if (typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined"
  && self instanceof WorkerGlobalScope) {
  self.addEventListener("message", (event) => self.postMessage(solve(event.data)));
}