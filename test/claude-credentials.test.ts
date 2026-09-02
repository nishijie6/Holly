import { test } from "node:test";
import assert from "node:assert/strict";

import { pickFresherClaudeCredentials } from "../llm-client.js";

// Which of the two Claude credential stores wins. The file copy and the Keychain
// copy drift apart — the CLI rotates the Keychain blob, refreshes here write the
// file — and picking the stale one fails silently at request time as a 401, so
// pin the ranking.

const MINUTE = 60_000;
const soon = () => Date.now() + MINUTE; // inside TOKEN_REFRESH_BUFFER_MS (5min)
const later = (ms: number) => Date.now() + ms;

test("picks whichever side is present when the other is missing", () => {
  const creds = { expiresAt: later(60 * MINUTE) };
  assert.equal(pickFresherClaudeCredentials(creds, null), creds);
  assert.equal(pickFresherClaudeCredentials(null, creds), creds);
  assert.equal(pickFresherClaudeCredentials(null, null), null);
});

test("a usable token beats an expiring one regardless of which side it is on", () => {
  const usable = { expiresAt: later(60 * MINUTE) };
  const expiring = { expiresAt: soon() };

  assert.equal(pickFresherClaudeCredentials(expiring, usable), usable);
  assert.equal(pickFresherClaudeCredentials(usable, expiring), usable);
});

test("the stale file loses to a fresh Keychain copy", () => {
  const staleFile = { expiresAt: Date.now() - 7 * 24 * 60 * MINUTE };
  const freshKeychain = { expiresAt: later(8 * 60 * MINUTE) };

  assert.equal(pickFresherClaudeCredentials(staleFile, freshKeychain), freshKeychain);
});

test("between two usable tokens the later expiry wins", () => {
  const nearer = { expiresAt: later(30 * MINUTE) };
  const further = { expiresAt: later(90 * MINUTE) };

  assert.equal(pickFresherClaudeCredentials(nearer, further), further);
  assert.equal(pickFresherClaudeCredentials(further, nearer), further);
});

test("between two expired tokens the least stale wins, so the refresh has the best shot", () => {
  const older = { expiresAt: Date.now() - 10 * 24 * 60 * MINUTE };
  const newer = { expiresAt: Date.now() - MINUTE };

  assert.equal(pickFresherClaudeCredentials(older, newer), newer);
  assert.equal(pickFresherClaudeCredentials(newer, older), newer);
});

test("a null expiresAt means not expiring, so it outranks any dated token", () => {
  const undated = { expiresAt: null };
  const dated = { expiresAt: later(90 * MINUTE) };

  assert.equal(pickFresherClaudeCredentials(dated, undated), undated);
  assert.equal(pickFresherClaudeCredentials(undated, dated), undated);
});

test("preferred wins an exact tie", () => {
  const expiresAt = later(60 * MINUTE);
  const preferred = { expiresAt };
  const other = { expiresAt };

  assert.equal(pickFresherClaudeCredentials(preferred, other), preferred);
});
