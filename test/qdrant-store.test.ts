import assert from "node:assert/strict";
import test from "node:test";

import {
  isNapCatHeartbeat,
  parseStoredMemoryRecord,
} from "../qdrant-store.js";

function incoming(rawContent: string) {
  return {
    isBinary: false,
    rawEncoding: "utf8" as const,
    rawContent,
  };
}

test("isNapCatHeartbeat: accepts only NapCat meta-event heartbeats", () => {
  assert.equal(isNapCatHeartbeat(incoming(JSON.stringify({
    post_type: "meta_event",
    meta_event_type: "heartbeat",
    interval: 30_000,
  }))), true);
  assert.equal(isNapCatHeartbeat(incoming(JSON.stringify({
    post_type: "meta_event",
    meta_event_type: "lifecycle",
    sub_type: "connect",
  }))), false);
  assert.equal(isNapCatHeartbeat(incoming(JSON.stringify({
    post_type: "message",
    message_type: "group",
    raw_message: "hello",
  }))), false);
  assert.equal(isNapCatHeartbeat(incoming("not json")), false);
  assert.equal(isNapCatHeartbeat({
    isBinary: true,
    rawEncoding: "base64",
    rawContent: "e30=",
  }), false);
});

test("parseStoredMemoryRecord: reads normalized v2 content", () => {
  const record = parseStoredMemoryRecord({
    schema_version: 2,
    source: "holly_internal",
    received_at: "2026-08-12T00:00:00.000Z",
    content: "one canonical copy",
    message_type: "internal_memory",
  });

  assert.equal(record.displayText, "one canonical copy");
  assert.equal(record.rawMessage, "one canonical copy");
});

test("parseStoredMemoryRecord: remains backward-compatible with v1 fields", () => {
  const record = parseStoredMemoryRecord({
    schema_version: 1,
    display_text: "display",
    raw_message: "raw",
  });

  assert.equal(record.displayText, "display");
  assert.equal(record.rawMessage, "raw");
});
