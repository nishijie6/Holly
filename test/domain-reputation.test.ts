import assert from "node:assert/strict";
import test from "node:test";

import {
  domainScore,
  extractDomain,
  rankUrlsByDomainReputation,
  shouldSkipDomain,
  type DomainReputationSnapshot,
} from "../domain-reputation.js";

test("extractDomain lowercases the hostname and ignores unparsable urls", () => {
  assert.equal(extractDomain("https://Example.COM/a/b?c=1"), "example.com");
  assert.equal(extractDomain("not a url"), null);
});

test("domainScore is neutral (0.5) for a domain with no track record", () => {
  assert.equal(domainScore(undefined), 0.5);
});

test("domainScore rewards a high success rate and punishes a high failure rate", () => {
  const good = domainScore({ success: 8, failure: 0, lastOutcomeAt: 0 });
  const bad = domainScore({ success: 0, failure: 8, lastOutcomeAt: 0 });
  assert.ok(good > 0.5);
  assert.ok(bad < 0.5);
  assert.ok(good > bad);
});

test("shouldSkipDomain requires both a minimum sample size and a low score", () => {
  // One failure alone must never exclude a domain.
  assert.equal(shouldSkipDomain({ success: 0, failure: 1, lastOutcomeAt: 0 }), false);
  // Enough samples but a decent score: keep it.
  assert.equal(shouldSkipDomain({ success: 3, failure: 3, lastOutcomeAt: 0 }), false);
  // Enough samples and a consistently bad score: skip it.
  assert.equal(shouldSkipDomain({ success: 0, failure: 6, lastOutcomeAt: 0 }), true);
});

test("rankUrlsByDomainReputation floats proven-good domains to the front and keeps search order among ties", () => {
  const snapshot: DomainReputationSnapshot = {
    "good.example": { success: 10, failure: 0, lastOutcomeAt: 0 },
    // Below-average but not enough samples/badness to trigger the hard skip
    // (that's covered separately below) — should sink, not disappear.
    "bad.example": { success: 1, failure: 2, lastOutcomeAt: 0 },
  };
  const urls = [
    "https://unknown-a.example/1",
    "https://bad.example/2",
    "https://good.example/3",
    "https://unknown-b.example/4",
  ];
  assert.deepEqual(rankUrlsByDomainReputation(urls, snapshot), [
    "https://good.example/3",
    "https://unknown-a.example/1",
    "https://unknown-b.example/4",
    "https://bad.example/2",
  ]);
});

test("rankUrlsByDomainReputation drops a domain with a proven-bad track record entirely", () => {
  const snapshot: DomainReputationSnapshot = {
    "chronic-failure.example": { success: 0, failure: 5, lastOutcomeAt: 0 },
  };
  const urls = ["https://chronic-failure.example/1", "https://fine.example/2"];
  assert.deepEqual(rankUrlsByDomainReputation(urls, snapshot), ["https://fine.example/2"]);
});
