const { randomUUID } = require("crypto");
const {
  CreateTableCommand,
  DescribeTableCommand,
  waitUntilTableExists,
} = require("@aws-sdk/client-dynamodb");
const {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const { dynamoClient, ddbDocClient } = require("../../config/awsConfig");
const { saveMessage, enrichSenderInfo } = require("../messages/messageService");

const REMINDERS_TABLE = process.env.DDB_REMINDERS_TABLE || "ott_reminders";
const MEMBERS_TABLE = process.env.DDB_MEMBERS_TABLE || "ott_group_members";
const VALID_REPEAT = new Set(["none", "daily", "weekly", "monthly"]);
const VALID_STATUS = new Set(["active", "completed", "cancelled"]);

let ensureTablePromise = null;

function toString(value) {
  return String(value ?? "").trim();
}

function normalizeRepeat(value) {
  const repeat = toString(value).toLowerCase() || "none";
  return VALID_REPEAT.has(repeat) ? repeat : "none";
}

function parseRemindAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("remindAt không hợp lệ");
  }
  if (date.getTime() <= Date.now()) {
    throw new Error("remindAt phải ở tương lai");
  }
  return date;
}

function formatReminderTime(date) {
  return date.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildReminderMessageContent(content, remindAt, repeat) {
  const repeatText =
    repeat === "daily"
      ? "Lặp lại hằng ngày"
      : repeat === "weekly"
        ? "Lặp lại hằng tuần"
        : repeat === "monthly"
          ? "Lặp lại hằng tháng"
          : "Không lặp lại";

  return `[Nhắc hẹn]\n${content}\nThời gian: ${formatReminderTime(remindAt)}\nLặp lại: ${repeatText}`;
}

async function ensureRemindersTable() {
  if (ensureTablePromise) return ensureTablePromise;

  ensureTablePromise = (async () => {
    try {
      await dynamoClient.send(
        new DescribeTableCommand({ TableName: REMINDERS_TABLE }),
      );
      return;
    } catch (error) {
      if (error.name !== "ResourceNotFoundException") {
        throw error;
      }
    }

    await dynamoClient.send(
      new CreateTableCommand({
        TableName: REMINDERS_TABLE,
        AttributeDefinitions: [
          { AttributeName: "reminderId", AttributeType: "S" },
        ],
        KeySchema: [{ AttributeName: "reminderId", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    console.log(`[reminders] Creating DynamoDB table ${REMINDERS_TABLE}`);
    await waitUntilTableExists(
      { client: dynamoClient, maxWaitTime: 60 },
      { TableName: REMINDERS_TABLE },
    );
  })();

  return ensureTablePromise;
}

async function isConversationMember(conversationId, userId) {
  const cid = toString(conversationId);
  const uid = toString(userId);
  if (!cid || !uid) return false;

  if (cid.startsWith("dm:")) {
    const parts = cid.split(":");
    return parts.length >= 3 && (parts[1] === uid || parts[2] === uid);
  }

  const groupId = cid.startsWith("channel:") ? cid.slice("channel:".length) : cid;
  const result = await ddbDocClient.send(
    new GetCommand({
      TableName: MEMBERS_TABLE,
      Key: { groupId, userId: uid },
    }),
  );

  return Boolean(result.Item);
}

async function createReminder({
  conversationId,
  creatorId,
  content,
  remindAt,
  repeat,
}) {
  await ensureRemindersTable();

  const cid = toString(conversationId);
  const uid = toString(creatorId);
  const reminderContent = toString(content);
  if (!cid) throw new Error("conversationId is required");
  if (!uid) throw new Error("creatorId is required");
  if (!reminderContent) throw new Error("content is required");

  const isMember = await isConversationMember(cid, uid);
  if (!isMember) {
    const error = new Error("Bạn không có quyền tạo nhắc hẹn trong cuộc trò chuyện này");
    error.status = 403;
    throw error;
  }

  const remindDate = parseRemindAt(remindAt);
  const normalizedRepeat = normalizeRepeat(repeat);
  const now = new Date().toISOString();
  const reminderId = randomUUID();

  const reminder = {
    reminderId,
    conversationId: cid,
    creatorId: uid,
    content: reminderContent,
    remindAt: remindDate.toISOString(),
    repeat: normalizedRepeat,
    status: "active",
    createdAt: now,
    updatedAt: now,
    lastTriggeredAt: null,
    messageId: null,
  };

  const message = await saveMessage({
    conversationId: cid,
    senderId: uid,
    contentType: "reminder",
    content: buildReminderMessageContent(
      reminderContent,
      remindDate,
      normalizedRepeat,
    ),
    reminderData: {
      reminderId,
      remindAt: reminder.remindAt,
      repeat: normalizedRepeat,
      status: "active",
    },
  });

  reminder.messageId = String(message.id);

  await ddbDocClient.send(
    new PutCommand({
      TableName: REMINDERS_TABLE,
      Item: reminder,
    }),
  );

  return { reminder, message };
}

async function listReminders({ userId, conversationId, status }) {
  await ensureRemindersTable();

  const uid = toString(userId);
  const cid = toString(conversationId);
  const normalizedStatus = toString(status).toLowerCase();

  const result = await ddbDocClient.send(
    new ScanCommand({ TableName: REMINDERS_TABLE }),
  );

  const rows = [];
  for (const item of result.Items || []) {
    if (cid && item.conversationId !== cid) continue;
    if (normalizedStatus && VALID_STATUS.has(normalizedStatus) && item.status !== normalizedStatus) {
      continue;
    }
    if (!(await isConversationMember(item.conversationId, uid))) continue;
    rows.push(item);
  }

  return rows.sort((a, b) => String(a.remindAt).localeCompare(String(b.remindAt)));
}

async function getReminder(reminderId, userId) {
  await ensureRemindersTable();

  const result = await ddbDocClient.send(
    new GetCommand({
      TableName: REMINDERS_TABLE,
      Key: { reminderId: toString(reminderId) },
    }),
  );
  const reminder = result.Item || null;
  if (!reminder) return null;

  if (!(await isConversationMember(reminder.conversationId, userId))) {
    const error = new Error("Bạn không có quyền xem nhắc hẹn này");
    error.status = 403;
    throw error;
  }

  return reminder;
}

async function updateReminder(reminderId, userId, patch) {
  await ensureRemindersTable();

  const existing = await getReminder(reminderId, userId);
  if (!existing) return null;
  if (String(existing.creatorId) !== String(userId)) {
    const error = new Error("Chỉ người tạo mới được sửa nhắc hẹn");
    error.status = 403;
    throw error;
  }

  const next = { ...existing };
  if (patch.content !== undefined) {
    const content = toString(patch.content);
    if (!content) throw new Error("content is required");
    next.content = content;
  }
  if (patch.remindAt !== undefined) {
    next.remindAt = parseRemindAt(patch.remindAt).toISOString();
  }
  if (patch.repeat !== undefined) {
    next.repeat = normalizeRepeat(patch.repeat);
  }
  if (patch.status !== undefined) {
    const status = toString(patch.status).toLowerCase();
    if (!VALID_STATUS.has(status)) throw new Error("status không hợp lệ");
    next.status = status;
  }
  next.updatedAt = new Date().toISOString();

  await ddbDocClient.send(
    new PutCommand({
      TableName: REMINDERS_TABLE,
      Item: next,
    }),
  );

  return next;
}

async function cancelReminder(reminderId, userId) {
  const existing = await getReminder(reminderId, userId);
  if (!existing) return null;
  if (String(existing.creatorId) !== String(userId)) {
    const error = new Error("Chỉ người tạo mới được hủy nhắc hẹn");
    error.status = 403;
    throw error;
  }

  await ddbDocClient.send(
    new UpdateCommand({
      TableName: REMINDERS_TABLE,
      Key: { reminderId: toString(reminderId) },
      UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "cancelled",
        ":updatedAt": new Date().toISOString(),
      },
    }),
  );

  return { ...existing, status: "cancelled" };
}

async function findDueReminders(now = new Date()) {
  await ensureRemindersTable();

  const result = await ddbDocClient.send(
    new ScanCommand({
      TableName: REMINDERS_TABLE,
      FilterExpression: "#status = :active AND remindAt <= :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":active": "active",
        ":now": now.toISOString(),
      },
    }),
  );

  return result.Items || [];
}

async function markReminderFiring(reminderId) {
  try {
    await ddbDocClient.send(
      new UpdateCommand({
        TableName: REMINDERS_TABLE,
        Key: { reminderId },
        UpdateExpression: "SET #status = :firing, updatedAt = :updatedAt",
        ConditionExpression: "#status = :active",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":active": "active",
          ":firing": "firing",
          ":updatedAt": new Date().toISOString(),
        },
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function nextRepeatTime(reminder) {
  if (reminder.repeat === "none") return null;

  const next = new Date(reminder.remindAt);
  const now = Date.now();
  do {
    if (reminder.repeat === "daily") next.setDate(next.getDate() + 1);
    if (reminder.repeat === "weekly") next.setDate(next.getDate() + 7);
    if (reminder.repeat === "monthly") next.setMonth(next.getMonth() + 1);
  } while (next.getTime() <= now);

  return next.toISOString();
}

async function completeTriggeredReminder(reminder) {
  const nextRemindAt = nextRepeatTime(reminder);
  const now = new Date().toISOString();

  if (nextRemindAt) {
    await ddbDocClient.send(
      new UpdateCommand({
        TableName: REMINDERS_TABLE,
        Key: { reminderId: reminder.reminderId },
        UpdateExpression:
          "SET #status = :active, remindAt = :remindAt, lastTriggeredAt = :triggeredAt, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":active": "active",
          ":remindAt": nextRemindAt,
          ":triggeredAt": now,
          ":updatedAt": now,
        },
      }),
    );
    return;
  }

  await ddbDocClient.send(
    new UpdateCommand({
      TableName: REMINDERS_TABLE,
      Key: { reminderId: reminder.reminderId },
      UpdateExpression:
        "SET #status = :completed, lastTriggeredAt = :triggeredAt, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":completed": "completed",
        ":triggeredAt": now,
        ":updatedAt": now,
      },
    }),
  );
}

async function buildReminderDueMessage(reminder) {
  const senderInfo = await enrichSenderInfo(reminder.creatorId);
  return {
    id: `reminder-due-${reminder.reminderId}-${Date.now()}`,
    conversationId: reminder.conversationId,
    senderId: reminder.creatorId,
    senderDisplayName: senderInfo.senderDisplayName,
    senderAvatarUrl: senderInfo.senderAvatarUrl,
    contentType: "reminder_due",
    content: `[Đến giờ nhắc hẹn]\n${reminder.content}\nThời gian: ${formatReminderTime(new Date(reminder.remindAt))}`,
    reminderData: {
      reminderId: reminder.reminderId,
      remindAt: reminder.remindAt,
      repeat: reminder.repeat,
      status: "due",
    },
    createdAt: new Date().toISOString(),
  };
}

module.exports = {
  REMINDERS_TABLE,
  buildReminderMessageContent,
  buildReminderDueMessage,
  cancelReminder,
  completeTriggeredReminder,
  createReminder,
  ensureRemindersTable,
  findDueReminders,
  getReminder,
  isConversationMember,
  listReminders,
  markReminderFiring,
  updateReminder,
};
