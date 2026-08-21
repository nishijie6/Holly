import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_MODEL_DECISION_JSON_SCHEMA,
  buildAdminDecisionInstruction,
  enforceAdminReplyContract,
  isAdminUserId,
  parseAdminCodeCommand,
  parseAdminPolicyConfig,
  resolveQqReplyTarget,
  shouldForceAdminReply,
} from "../admin-policy.js";

test("admin policy authenticates only configured numeric OneBot user ids", () => {
  const config = parseAdminPolicyConfig({
    user_ids: [12345678, "87654321", "admin", ""],
  }, "87654321, 11223344;not-an-id");

  assert.deepEqual(config.userIds, ["12345678", "87654321", "11223344"]);
  assert.equal(isAdminUserId("12345678", config), true);
  assert.equal(isAdminUserId("11223344", config), true);
  assert.equal(isAdminUserId("admin", config), false);
  assert.equal(isAdminUserId(null, config), false);
});

test("disabled admin policy never grants privileges", () => {
  const config = parseAdminPolicyConfig({ enabled: false, user_ids: [12345678] });
  assert.equal(isAdminUserId("12345678", config), false);
});

test("admin replies are forced only in private conversations", () => {
  const config = parseAdminPolicyConfig({
    user_ids: [12345678],
    force_reply: true,
  });

  assert.equal(shouldForceAdminReply({
    userId: "12345678",
    messageType: "private",
  }, config), true);
  assert.equal(shouldForceAdminReply({
    userId: "12345678",
    messageType: "group",
  }, config), false);
  assert.equal(shouldForceAdminReply({
    userId: "87654321",
    messageType: "private",
  }, config), false);
  assert.equal(shouldForceAdminReply({
    userId: "12345678",
    messageType: "private",
  }, {
    ...config,
    forceReply: false,
  }), false);
});

test("code improvement commands require a configured prefix at message start", () => {
  const config = parseAdminPolicyConfig({ user_ids: [12345678] });

  assert.deepEqual(
    parseAdminCodeCommand("[CQ:reply,id=7] [CQ:at,qq=10000002] /改进代码 修复重复回复", config),
    { matched: true, request: "修复重复回复", prefix: "/改进代码" },
  );
  assert.deepEqual(
    parseAdminCodeCommand("请执行 /改进代码 修复重复回复", config),
    { matched: false, request: "", prefix: null },
  );
  assert.deepEqual(
    parseAdminCodeCommand("/改进代码", config),
    { matched: true, request: "", prefix: "/改进代码" },
  );
});

test("admin decision contract requires a reply status and failure reason field", () => {
  const schema = ADMIN_MODEL_DECISION_JSON_SCHEMA as {
    required: string[];
    properties: Record<string, unknown>;
  };
  assert.ok(schema.required.includes("admin_action_status"));
  assert.ok(schema.required.includes("admin_action_reason"));
  assert.ok(schema.required.includes("final_answer"));

  const instruction = buildAdminDecisionInstruction({
    adminUserIds: ["12345678"],
    codeJobId: "job-42",
  });
  assert.match(instruction, /user_id\(s\): 12345678/);
  assert.match(instruction, /should_reply=true/);
  assert.match(instruction, /concrete reason/);
  assert.match(instruction, /job_id=job-42/);
  assert.match(instruction, /Do not claim it is already running or applied/);
});

test("admin timeout and command prefixes are bounded and normalized", () => {
  const config = parseAdminPolicyConfig({
    code_improvement: {
      command_prefixes: [" /fix ", "/fix", ""],
      timeout_seconds: 2,
      apply_when_clean: false,
    },
  });
  assert.deepEqual(config.codeImprovement.commandPrefixes, ["/fix"]);
  assert.equal(config.codeImprovement.timeoutMs, 60_000);
  assert.equal(config.codeImprovement.applyWhenClean, false);
});

test("QQ reply targets isolate administrator private context from group context", () => {
  assert.deepEqual(resolveQqReplyTarget({
    messageType: "group",
    groupId: "20000002",
    userId: "12345678",
  }), {
    conversationId: "20000002",
    type: "group",
    id: "20000002",
  });
  assert.deepEqual(resolveQqReplyTarget({
    messageType: "private",
    groupId: null,
    userId: "12345678",
  }), {
    conversationId: "private:12345678",
    type: "private",
    id: "12345678",
  });
  assert.equal(resolveQqReplyTarget({
    messageType: "private",
    groupId: null,
    userId: "not-a-number",
  }), null);
});

test("admin reply contract always produces a reply and explains inability", () => {
  const decision = enforceAdminReplyContract({
    shouldReply: false,
    finalAnswer: "",
    adminActionStatus: "cannot_comply",
    adminActionReason: "当前没有操作该服务的工具。",
  });
  assert.equal(decision.shouldReply, true);
  assert.match(decision.finalAnswer, /无法完成/);
  assert.match(decision.finalAnswer, /当前没有操作该服务的工具/);
  assert.equal(decision.adminActionStatus, "cannot_comply");
});

test("admin reply contract truthfully acknowledges a queued code job", () => {
  const decision = enforceAdminReplyContract({
    shouldReply: true,
    finalAnswer: "收到，我来处理。",
    adminActionStatus: "accepted",
    adminActionReason: "",
  }, { codeJobId: "abc123" });
  assert.match(decision.finalAnswer, /abc123/);
  assert.match(decision.finalAnswer, /已受理并进入执行队列/);
  assert.match(decision.finalAnswer, /执行与验证结果会另行回报/);
  assert.doesNotMatch(decision.finalAnswer, /已经应用/);
  assert.equal(decision.adminActionStatus, "accepted");
});

test("admin reply contract cannot hide why a code job was not started", () => {
  const decision = enforceAdminReplyContract({
    shouldReply: true,
    finalAnswer: "收到。",
    adminActionStatus: "accepted",
    adminActionReason: "",
  }, { codeJobNote: "read_only 模式禁止自修改。" });
  assert.equal(decision.adminActionStatus, "cannot_comply");
  assert.match(decision.finalAnswer, /read_only 模式禁止自修改/);
  assert.equal(decision.adminActionReason, "read_only 模式禁止自修改。");
});
