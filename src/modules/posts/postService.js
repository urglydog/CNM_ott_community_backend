const { randomUUID } = require('crypto');
const { ddbDocClient } = require('../../config/awsConfig');
const { PutCommand, GetCommand, QueryCommand, ScanCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const userService = require('../users/userService');

const POSTS_TABLE = process.env.DDB_POSTS_TABLE || 'ott_posts';
const COMMENTS_TABLE = process.env.DDB_COMMENTS_TABLE || 'ott_comments';

// ─── Posts ────────────────────────────────────────────────────────────────────

async function createPost(userId, { content, media }) {
  if (!userId) throw new Error('Thiếu userId');
  if (!content && (!media || media.length === 0)) {
    throw new Error('Bài viết cần có nội dung hoặc hình ảnh/video');
  }

  const postId = randomUUID();
  const now = new Date().toISOString();

  const user = await userService.getUserById(userId);
  if (!user) throw new Error('Không tìm thấy người dùng');

  const item = {
    postId,
    userId: String(userId),
    authorName: user.display_name || user.username || 'Unknown',
    authorAvatar: user.avatar_url || null,
    content: String(content || '').trim(),
    media: Array.isArray(media) ? media : [], // [{url, type: 'image'|'video', name?}]
    likes: [],       // array of userIds who liked
    likeCount: 0,
    commentCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  await ddbDocClient.send(new PutCommand({
    TableName: POSTS_TABLE,
    Item: item,
  }));

  return item;
}

async function getPostById(postId) {
  if (!postId) return null;
  const result = await ddbDocClient.send(new GetCommand({
    TableName: POSTS_TABLE,
    Key: { postId: String(postId) },
  }));
  return result.Item || null;
}

async function getFeedPosts(userId, { limit = 20, lastKey } = {}) {
  // Get the user's friend list
  const friendService = require('../users/friendService');
  let friendIds = [];
  try {
    const friends = await friendService.getFriends(userId);
    friendIds = (friends || []).map(f => String(f.friend_id || f.userId));
  } catch (e) {
    console.warn('[PostService] Could not load friends for feed:', e.message);
  }

  // Include the user's own posts
  const allowedUserIds = [String(userId), ...friendIds];

  // Scan all posts and filter by allowed users
  // (In production, you'd use a GSI on userId + createdAt)
  const scanParams = {
    TableName: POSTS_TABLE,
    Limit: 200, // scan a larger set, then filter & sort
  };

  const result = await ddbDocClient.send(new ScanCommand(scanParams));
  const allPosts = result.Items || [];

  // Filter posts from friends + self
  const feedPosts = allPosts
    .filter(p => allowedUserIds.includes(String(p.userId)))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);

  return {
    posts: feedPosts,
    count: feedPosts.length,
  };
}

async function getUserPosts(userId, { limit = 20 } = {}) {
  const result = await ddbDocClient.send(new ScanCommand({
    TableName: POSTS_TABLE,
    FilterExpression: '#uid = :uid',
    ExpressionAttributeNames: { '#uid': 'userId' },
    ExpressionAttributeValues: { ':uid': String(userId) },
  }));

  const posts = (result.Items || [])
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);

  return { posts, count: posts.length };
}

async function toggleLike(postId, userId) {
  const post = await getPostById(postId);
  if (!post) throw new Error('Bài viết không tồn tại');

  const likes = Array.isArray(post.likes) ? post.likes : [];
  const userIdStr = String(userId);
  const alreadyLiked = likes.includes(userIdStr);

  let newLikes;
  if (alreadyLiked) {
    newLikes = likes.filter(id => id !== userIdStr);
  } else {
    newLikes = [...likes, userIdStr];
  }

  await ddbDocClient.send(new UpdateCommand({
    TableName: POSTS_TABLE,
    Key: { postId: String(postId) },
    UpdateExpression: 'SET #likes = :likes, #likeCount = :likeCount, #updatedAt = :updatedAt',
    ExpressionAttributeNames: {
      '#likes': 'likes',
      '#likeCount': 'likeCount',
      '#updatedAt': 'updatedAt',
    },
    ExpressionAttributeValues: {
      ':likes': newLikes,
      ':likeCount': newLikes.length,
      ':updatedAt': new Date().toISOString(),
    },
  }));

  return {
    liked: !alreadyLiked,
    likeCount: newLikes.length,
    likes: newLikes,
  };
}

async function deletePost(postId, userId) {
  const post = await getPostById(postId);
  if (!post) throw new Error('Bài viết không tồn tại');
  if (String(post.userId) !== String(userId)) {
    throw new Error('Bạn không có quyền xóa bài viết này');
  }

  await ddbDocClient.send(new DeleteCommand({
    TableName: POSTS_TABLE,
    Key: { postId: String(postId) },
  }));

  return { deleted: true };
}

// ─── Comments ────────────────────────────────────────────────────────────────

async function createComment(postId, userId, { content }) {
  if (!postId || !userId) throw new Error('Thiếu postId hoặc userId');
  if (!content || !content.trim()) throw new Error('Bình luận không được để trống');

  const post = await getPostById(postId);
  if (!post) throw new Error('Bài viết không tồn tại');

  const user = await userService.getUserById(userId);
  if (!user) throw new Error('Không tìm thấy người dùng');

  const commentId = randomUUID();
  const now = new Date().toISOString();

  const comment = {
    commentId,
    postId: String(postId),
    userId: String(userId),
    authorName: user.display_name || user.username || 'Unknown',
    authorAvatar: user.avatar_url || null,
    content: String(content).trim(),
    createdAt: now,
  };

  await ddbDocClient.send(new PutCommand({
    TableName: COMMENTS_TABLE,
    Item: comment,
  }));

  // Update post comment count
  await ddbDocClient.send(new UpdateCommand({
    TableName: POSTS_TABLE,
    Key: { postId: String(postId) },
    UpdateExpression: 'SET #commentCount = if_not_exists(#commentCount, :zero) + :one, #updatedAt = :updatedAt',
    ExpressionAttributeNames: {
      '#commentCount': 'commentCount',
      '#updatedAt': 'updatedAt',
    },
    ExpressionAttributeValues: {
      ':zero': 0,
      ':one': 1,
      ':updatedAt': now,
    },
  }));

  return comment;
}

async function getComments(postId, { limit = 50 } = {}) {
  const result = await ddbDocClient.send(new ScanCommand({
    TableName: COMMENTS_TABLE,
    FilterExpression: '#pid = :pid',
    ExpressionAttributeNames: { '#pid': 'postId' },
    ExpressionAttributeValues: { ':pid': String(postId) },
  }));

  const comments = (result.Items || [])
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(0, limit);

  return { comments, count: comments.length };
}

async function deleteComment(commentId, userId) {
  const result = await ddbDocClient.send(new GetCommand({
    TableName: COMMENTS_TABLE,
    Key: { commentId: String(commentId) },
  }));

  const comment = result.Item;
  if (!comment) throw new Error('Bình luận không tồn tại');
  if (String(comment.userId) !== String(userId)) {
    throw new Error('Bạn không có quyền xóa bình luận này');
  }

  await ddbDocClient.send(new DeleteCommand({
    TableName: COMMENTS_TABLE,
    Key: { commentId: String(commentId) },
  }));

  // Decrease comment count on post
  try {
    await ddbDocClient.send(new UpdateCommand({
      TableName: POSTS_TABLE,
      Key: { postId: String(comment.postId) },
      UpdateExpression: 'SET #commentCount = if_not_exists(#commentCount, :one) - :one',
      ExpressionAttributeNames: { '#commentCount': 'commentCount' },
      ExpressionAttributeValues: { ':one': 1 },
    }));
  } catch (e) {
    console.warn('Failed to decrease comment count:', e.message);
  }

  return { deleted: true };
}

module.exports = {
  createPost,
  getPostById,
  getFeedPosts,
  getUserPosts,
  toggleLike,
  deletePost,
  createComment,
  getComments,
  deleteComment,
};
