import assert from "node:assert/strict";
import test from "node:test";
import * as monitor from "../monitor-page.js";

const formatter = (): ((minutes: number | null, id: "primary" | "secondary") => string) => {
  const fn = (monitor as unknown as { formatProviderUsageWindow?: (minutes: number | null, id: "primary" | "secondary") => string }).formatProviderUsageWindow;
  assert.equal(typeof fn, "function", "quota labels must follow the actual reported window");
  return fn!;
};

test("a primary weekly allowance is labelled 7d rather than inferred as 5h", () => {
  const label = formatter();
  assert.equal(label(10_080, "primary"), "7d");
  assert.equal(label(300, "primary"), "5h");
  assert.equal(label(10_080, "secondary"), "7d");
});

test("unknown quota durations do not invent a five-hour or weekly limit", () => {
  const label = formatter();
  assert.equal(label(null, "primary"), "Primary");
  assert.equal(label(null, "secondary"), "Secondary");
  assert.equal(label(0, "secondary"), "Secondary");
  assert.equal(label(90, "primary"), "90m");
  assert.equal(label(1_440, "primary"), "1d");
});
