import assert from "node:assert/strict";

export function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function waitFor(predicate, attempts = 10) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(predicate(), true);
}
