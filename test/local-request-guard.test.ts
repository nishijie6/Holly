import assert from "node:assert/strict";
import test from "node:test";

import { createLocalRequestGuard } from "../local-request-guard.js";

const guard = createLocalRequestGuard("127.0.0.1", 5000);

test("本机访问和不带 Origin 的调用放行", () => {
  assert.equal(guard("127.0.0.1:5000", undefined), true);
  assert.equal(guard("localhost:5000", undefined), true);
  assert.equal(guard("localhost:5000", "http://localhost:5000"), true);
  assert.equal(guard("127.0.0.1:5000", "http://127.0.0.1:5000"), true);
});

test("DNS rebinding 的 Host 被拒", () => {
  assert.equal(guard("evil.example.com:5000", undefined), false);
  assert.equal(guard("evil.example.com", undefined), false);
  assert.equal(guard(undefined, undefined), false);
});

test("跨站 Origin 被拒", () => {
  assert.equal(guard("127.0.0.1:5000", "https://evil.example.com"), false);
  assert.equal(guard("127.0.0.1:5000", "null"), false);
  assert.equal(guard("127.0.0.1:5000", "http://127.0.0.1:5001"), false);
});
