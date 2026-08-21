import assert from "node:assert/strict";
import test from "node:test";

import {
  extractFriendUserIds,
  formatConversationKey,
  isPrivateConversationKey,
  normalizeOneBotUserId,
  parsePrivateChatConfig,
} from "../private-chat.js";

test("private chat config defaults to enabled friend-only conversations", () => {
  const config = parsePrivateChatConfig(undefined, "10000002");
  assert.equal(config.enabled, true);
  assert.equal(config.friendsOnly, true);
  assert.equal(config.historyMessageCount, 40);
  assert.equal(config.friendRefreshIntervalMs, 5 * 60 * 1000);
  assert.equal(config.botUserId, "10000002");
});

test("private chat config normalizes ids and bounds history/refresh settings", () => {
  const config = parsePrivateChatConfig({
    enabled: false,
    friends_only: false,
    history_message_count: 999,
    friend_refresh_minutes: 0,
    bot_user_id: 12345678,
  });
  assert.equal(config.enabled, false);
  assert.equal(config.friendsOnly, false);
  assert.equal(config.historyMessageCount, 200);
  assert.equal(config.friendRefreshIntervalMs, 5 * 60 * 1000);
  assert.equal(config.botUserId, "12345678");
  assert.equal(normalizeOneBotUserId("bot"), null);
});

test("friend ids parse both direct and wrapped NapCat responses", () => {
  assert.deepEqual(
    [...extractFriendUserIds({ data: [{ user_id: 12345678 }, { user_id: "87654321" }] })],
    ["12345678", "87654321"],
  );
  assert.deepEqual(
    [...extractFriendUserIds({ data: { friends: [{ userId: "11223344" }, { uin: 55667788 }] } })],
    ["11223344", "55667788"],
  );
});

test("private conversation keys remain distinct from group ids", () => {
  assert.equal(isPrivateConversationKey("private:12345678"), true);
  assert.equal(isPrivateConversationKey("12345678"), false);
  assert.equal(formatConversationKey("private:12345678"), "私聊12345678");
  assert.equal(formatConversationKey("20000002"), "群20000002");
});
