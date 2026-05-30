const { randomUUID } = require("crypto");
const {
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { ddbDocClient } = require("../../config/awsConfig");
const friendService = require("../users/friendService");
const userService = require("../users/userService");
const { saveMessage } = require("../messages/messageService");

const STORIES_TABLE = process.env.DDB_STORIES_TABLE || "ott_stories";
const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const VALID_TYPES = new Set(["image", "text"]);
function normalizeStory(item) {
  return {
    ...item,
    isHighlighted: Boolean(item.isHighlighted),
    likes: Array.isArray(item.likes) ? item.likes : [],
    likeCount: Array.isArray(item.likes) ? item.likes.length : 0,
  };
}

async function createStory(userId, payload = {}) {
  const type = String(payload.type || "").trim().toLowerCase();
  const text = String(payload.text || "").trim();
  const mediaUrl = String(payload.mediaUrl || "").trim();
  const backgroundColor = String(payload.backgroundColor || "#2563EB").trim();
  const textX = Number.isFinite(Number(payload.textX)) ? Number(payload.textX) : 0;
  const textY = Number.isFinite(Number(payload.textY)) ? Number(payload.textY) : 0;
  const textScale = Number.isFinite(Number(payload.textScale)) ? Number(payload.textScale) : 1;
  const textRotation = Number.isFinite(Number(payload.textRotation)) ? Number(payload.textRotation) : 0;

  if (!VALID_TYPES.has(type)) throw new Error("Loại story không hợp lệ");
  if (type === "image" && !mediaUrl) throw new Error("Story ảnh cần có ảnh");
  if (type === "text" && !text) throw new Error("Story văn bản không được để trống");

  const user = await userService.getUserById(userId);
  if (!user) throw new Error("Không tìm thấy người dùng");

  const now = new Date();
  const item = {
    storyId: randomUUID(),
    userId: String(userId),
    authorName: user.display_name || user.username || "Người dùng",
    authorAvatar: user.avatar_url || null,
    type,
    text,
    mediaUrl: type === "image" ? mediaUrl : null,
    backgroundColor,
    textX,
    textY,
    textScale,
    textRotation,
    isHighlighted: false,
    highlightedAt: null,
    likes: [],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + STORY_LIFETIME_MS).toISOString(),
  };

  await ddbDocClient.send(new PutCommand({ TableName: STORIES_TABLE, Item: item }));
  return normalizeStory(item);
}

async function getStory(storyId) {
  const result = await ddbDocClient.send(new GetCommand({
    TableName: STORIES_TABLE,
    Key: { storyId: String(storyId) },
  }));
  return result.Item ? normalizeStory(result.Item) : null;
}

async function scanStories() {
  const result = await ddbDocClient.send(new ScanCommand({ TableName: STORIES_TABLE }));
  return (result.Items || []).map(normalizeStory);
}

async function getFeed(userId) {
  const friends = await friendService.getFriends(userId).catch(() => []);
  const allowedUserIds = new Set([
    String(userId),
    ...friends.map((friend) => String(friend.friend_id || friend.userId)),
  ]);
  const now = Date.now();
  const stories = (await scanStories())
    .filter((story) => allowedUserIds.has(String(story.userId)))
    .filter((story) => new Date(story.expiresAt).getTime() > now)
    .sort((left, right) => {
      const leftIsMine = String(left.userId) === String(userId);
      const rightIsMine = String(right.userId) === String(userId);
      if (leftIsMine !== rightIsMine) return leftIsMine ? -1 : 1;
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });
  return { stories, count: stories.length };
}

async function getHighlights(userId) {
  const stories = (await scanStories())
    .filter((story) => String(story.userId) === String(userId) && story.isHighlighted)
    .sort((left, right) =>
      new Date(right.highlightedAt || right.createdAt).getTime()
      - new Date(left.highlightedAt || left.createdAt).getTime());
  return { stories, count: stories.length };
}

async function getArchive(userId) {
  const stories = (await scanStories())
    .filter((story) => String(story.userId) === String(userId))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  return { stories, count: stories.length };
}

async function toggleHighlight(storyId, userId) {
  const story = await getStory(storyId);
  if (!story) throw new Error("Không tìm thấy story");
  if (String(story.userId) !== String(userId)) {
    throw new Error("Bạn không có quyền ghim story này");
  }

  const isHighlighted = !story.isHighlighted;
  const highlightedAt = isHighlighted ? new Date().toISOString() : null;
  await ddbDocClient.send(new UpdateCommand({
    TableName: STORIES_TABLE,
    Key: { storyId: String(storyId) },
    UpdateExpression: "SET #highlighted = :highlighted, #highlightedAt = :highlightedAt",
    ExpressionAttributeNames: {
      "#highlighted": "isHighlighted",
      "#highlightedAt": "highlightedAt",
    },
    ExpressionAttributeValues: {
      ":highlighted": isHighlighted,
      ":highlightedAt": highlightedAt,
    },
  }));

  return { ...story, isHighlighted, highlightedAt };
}

async function toggleLike(storyId, userId) {
  const story = await getStory(storyId);
  if (!story) throw new Error("Không tìm thấy story");

  const userIdString = String(userId);
  const alreadyLiked = story.likes.includes(userIdString);
  const likes = alreadyLiked
    ? story.likes.filter((id) => id !== userIdString)
    : [...story.likes, userIdString];

  await ddbDocClient.send(new UpdateCommand({
    TableName: STORIES_TABLE,
    Key: { storyId: String(storyId) },
    UpdateExpression: "SET #likes = :likes",
    ExpressionAttributeNames: { "#likes": "likes" },
    ExpressionAttributeValues: { ":likes": likes },
  }));

  return { ...story, likes, likeCount: likes.length, liked: !alreadyLiked };
}

function buildDmConversationId(leftUserId, rightUserId) {
  const ids = [String(leftUserId), String(rightUserId)];
  const areNumeric = ids.every((id) => Number.isFinite(Number(id)));
  return `dm:${ids.sort(areNumeric
    ? (left, right) => Number(left) - Number(right)
    : (left, right) => left.localeCompare(right)).join(":")}`;
}

async function replyToStory(storyId, senderId, content) {
  const story = await getStory(storyId);
  if (!story) throw new Error("Không tìm thấy story");
  const normalizedContent = String(content || "").trim();
  if (!normalizedContent) throw new Error("Tin nhắn không được để trống");
  if (String(story.userId) === String(senderId)) {
    throw new Error("Không thể tự trả lời story của chính mình");
  }

  return saveMessage({
    senderId: String(senderId),
    conversationId: buildDmConversationId(senderId, story.userId),
    contentType: "text",
    content: normalizedContent,
    storyReply: {
      storyId: story.storyId,
      authorName: story.authorName,
      type: story.type,
      text: story.text || "",
      mediaUrl: story.mediaUrl || null,
    },
  });
}

module.exports = {
  createStory,
  getFeed,
  getHighlights,
  getArchive,
  toggleHighlight,
  toggleLike,
  replyToStory,
};
