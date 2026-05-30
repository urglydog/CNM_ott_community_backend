const fs = require("fs/promises");
const path = require("path");

const { ddbDocClient } = require("../../config/awsConfig");
const { GetCommand } = require("@aws-sdk/lib-dynamodb");

const tokenStorePath = path.join(process.cwd(), "tmp", "notification-tokens.json");

let firebaseAdmin = null;

function getString(value) {
  return String(value ?? "").trim();
}

async function readTokenStore() {
  try {
    const raw = await fs.readFile(tokenStorePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // ignore local cache read issues
  }
  return {};
}

async function writeTokenStore(store) {
  await fs.mkdir(path.dirname(tokenStorePath), { recursive: true });
  await fs.writeFile(tokenStorePath, JSON.stringify(store, null, 2), "utf8");
}

async function registerDeviceToken(userId, token, meta = {}) {
  const userKey = getString(userId);
  const deviceToken = getString(token);

  if (!userKey) throw new Error("userId is required");
  if (!deviceToken) throw new Error("token is required");

  const store = await readTokenStore();
  const existing = Array.isArray(store[userKey]) ? store[userKey] : [];
  const now = new Date().toISOString();

  const nextRecord = {
    token: deviceToken,
    platform: getString(meta.platform) || "web",
    deviceName: getString(meta.deviceName),
    createdAt:
      existing.find((record) => record.token === deviceToken)?.createdAt || now,
    updatedAt: now,
  };

  store[userKey] = [
    nextRecord,
    ...existing.filter((record) => record.token !== deviceToken),
  ];

  await writeTokenStore(store);
  return nextRecord;
}

async function removeDeviceToken(userId, token) {
  const userKey = getString(userId);
  const deviceToken = getString(token);
  if (!userKey || !deviceToken) return false;

  const store = await readTokenStore();
  const existing = Array.isArray(store[userKey]) ? store[userKey] : [];
  const next = existing.filter((record) => record.token !== deviceToken);

  if (next.length === existing.length) {
    return false;
  }

  if (next.length > 0) {
    store[userKey] = next;
  } else {
    delete store[userKey];
  }

  await writeTokenStore(store);
  return true;
}

async function getDeviceTokens(userId) {
  const userKey = getString(userId);
  if (!userKey) return [];

  const store = await readTokenStore();
  return Array.isArray(store[userKey]) ? store[userKey] : [];
}

function getFirebasePublicConfig() {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY || "";
  const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || process.env.FIREBASE_AUTH_DOMAIN || "";
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || "";
  const messagingSenderId = process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || process.env.FIREBASE_MESSAGING_SENDER_ID || "";
  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID || process.env.FIREBASE_APP_ID || "";
  const storageBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || "";
  const measurementId = process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID || process.env.FIREBASE_MEASUREMENT_ID || "";
  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY || process.env.FIREBASE_VAPID_KEY || "";

  const enabled = Boolean(apiKey && projectId && messagingSenderId && appId && vapidKey);

  return {
    enabled,
    apiKey,
    authDomain,
    projectId,
    messagingSenderId,
    appId,
    storageBucket,
    measurementId,
    vapidKey,
  };
}

function getFirebaseAdmin() {
  if (firebaseAdmin) {
    return firebaseAdmin;
  }

  const serviceAccountJson =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
      ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
      : "");

  if (!serviceAccountJson) {
    return null;
  }

  try {
    // firebase-admin is optional at runtime; if env is not configured we simply skip pushes.
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const admin = require("firebase-admin");
    if (admin.apps && admin.apps.length > 0) {
      firebaseAdmin = admin;
      return firebaseAdmin;
    }

    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID,
    });
    firebaseAdmin = admin;
    return firebaseAdmin;
  } catch (error) {
    console.warn("[notifications] Firebase Admin init skipped:", error.message);
    return null;
  }
}

function buildMessagePreview(message) {
  const contentType = getString(message?.contentType || "text").toLowerCase();
  const content = getString(message?.content);

  if (contentType === "image") return "[Ảnh]";
  if (contentType === "video") return "[Video]";
  if (contentType === "file") return content ? `[Tệp] ${content}` : "[Tệp]";
  if (contentType === "sticker") return "[Sticker]";
  if (contentType === "emoji") return content || "[Biểu tượng cảm xúc]";
  if (contentType === "reminder") return "[Nhắc hẹn]";
  if (contentType === "reminder_due") return content || "Đến giờ nhắc hẹn";
  if (contentType === "note") return content ? `[Ghi chú] ${content}` : "[Ghi chú]";
  if (content) return content;

  const attachment = Array.isArray(message?.attachments) ? message.attachments[0] : null;
  if (attachment?.name) return `[Tệp] ${attachment.name}`;
  if (attachment?.type === "image") return "[Ảnh]";
  if (attachment?.type === "video") return "[Video]";
  if (attachment?.url) return "[Tệp đính kèm]";

  return "Tin nhắn mới";
}

async function resolveRecipients(message) {
  const conversationId = getString(message?.conversationId);
  const senderId = getString(message?.senderId);

  if (!conversationId || !senderId) return [];

  if (conversationId.startsWith("dm:")) {
    const parts = conversationId.split(":");
    if (parts.length >= 3) {
      return [parts[1], parts[2]].filter((id) => id && id !== senderId);
    }
    return [];
  }

  const groupId = conversationId.startsWith("channel:")
    ? conversationId.slice("channel:".length)
    : conversationId;

  try {
    const { getGroupMembers } = require("../groups/groupService");
    const members = await getGroupMembers(groupId);
    return members
      .map((member) => getString(member.userId))
      .filter((id) => id && id !== senderId);
  } catch {
    return [];
  }
}

async function sendPushNotifications(message) {
  const admin = getFirebaseAdmin();
  if (!admin) {
    return { enabled: false, sent: 0, failed: 0, recipients: 0 };
  }

  const recipients = await resolveRecipients(message);
  if (recipients.length === 0) {
    return { enabled: true, sent: 0, failed: 0, recipients: 0 };
  }

  const recipientRecords = await Promise.all(
    recipients.map(async (userId) => ({ userId, tokens: await getDeviceTokens(userId) })),
  );

  const tokenToUser = new Map();
  const tokens = [];

  for (const record of recipientRecords) {
    for (const tokenRecord of record.tokens) {
      const token = getString(tokenRecord?.token);
      if (!token || tokenToUser.has(token)) continue;
      tokenToUser.set(token, record.userId);
      tokens.push(token);
    }
  }

  if (tokens.length === 0) {
    return { enabled: true, sent: 0, failed: 0, recipients: recipients.length };
  }

  let senderName = `Người dùng ${message.senderId}`;
  try {
    const result = await ddbDocClient.send(
      new GetCommand({
        TableName: process.env.DDB_USERS_TABLE || "ott_users",
        Key: { userId: String(message.senderId) },
      }),
    );
    const u = result.Item || {};
    senderName = u.display_name || u.username || senderName;
  } catch {
    // ignore sender enrichment failure
  }

  const payload = {
    notification: {
      title: senderName,
      body: buildMessagePreview(message),
    },
    data: {
      conversationId: getString(message.conversationId),
      messageId: getString(message.id),
      senderId: getString(message.senderId),
      contentType: getString(message.contentType || "text"),
      createdAt: getString(message.createdAt || new Date().toISOString()),
    },
    tokens,
  };

  const result = await admin.messaging().sendEachForMulticast(payload);
  return {
    enabled: true,
    sent: result.successCount,
    failed: result.failureCount,
    recipients: recipients.length,
  };
}

async function notifyMessageCreated(message, io) {
  const pushResult = await sendPushNotifications(message);

  if (io && getString(message?.conversationId)) {
    io.to(getString(message.conversationId)).emit("notification:new_message", {
      ...message,
      pushEnabled: pushResult.enabled,
    });
  }

  return pushResult;
}

module.exports = {
  registerDeviceToken,
  removeDeviceToken,
  getDeviceTokens,
  getFirebasePublicConfig,
  notifyMessageCreated,
  sendPushNotifications,
};
