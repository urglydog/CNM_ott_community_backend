const { randomUUID } = require('crypto');
const { ddbDocClient } = require('../../config/awsConfig');
const { PutCommand, GetCommand, QueryCommand, ScanCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const userService = require('../users/userService');

const POSTS_TABLE = process.env.DDB_POSTS_TABLE || 'ott_posts';
const COMMENTS_TABLE = process.env.DDB_COMMENTS_TABLE || 'ott_comments';

async function enrichLikes(likes) {
  const ids = Array.isArray(likes) ? likes : [];
  return Promise.all(ids.map(async (userId) => {
    try {
      const user = await userService.getUserById(userId);
      return {
        userId: String(userId),
        displayName: user?.display_name || user?.username || 'NgÆ°á»i dÃ¹ng',
        avatarUrl: user?.avatar_url || null,
      };
    } catch {
      return { userId: String(userId), displayName: 'NgÆ°á»i dÃ¹ng', avatarUrl: null };
    }
  }));
}

async function enrichPost(post) {
  return {
    ...post,
    likes: Array.isArray(post.likes) ? post.likes : [],
    likeCount: Array.isArray(post.likes) ? post.likes.length : (post.likeCount || 0),
    likeUsers: await enrichLikes(post.likes),
  };
}

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
  return result.Item ? enrichPost(result.Item) : null;
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
    posts: await Promise.all(feedPosts.map(enrichPost)),
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

  return { posts: await Promise.all(posts.map(enrichPost)), count: posts.length };
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
    likeUsers: await enrichLikes(newLikes),
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

async function createComment(postId, userId, { content, parentCommentId }) {
  if (!postId || !userId) throw new Error('Thiếu postId hoặc userId');
  if (!content || !content.trim()) throw new Error('Bình luận không được để trống');

  const post = await getPostById(postId);
  if (!post) throw new Error('Bài viết không tồn tại');

  const user = await userService.getUserById(userId);
  if (!user) throw new Error('Không tìm thấy người dùng');

  const commentId = randomUUID();
  const now = new Date().toISOString();
  let parentComment = null;

  if (parentCommentId) {
    const parentResult = await ddbDocClient.send(new GetCommand({
      TableName: COMMENTS_TABLE,
      Key: { commentId: String(parentCommentId) },
    }));
    parentComment = parentResult.Item;
    if (!parentComment || String(parentComment.postId) !== String(postId)) {
      throw new Error('BÃ¬nh luáº­n gá»‘c khÃ´ng tá»“n táº¡i');
    }
  }

  const comment = {
    commentId,
    postId: String(postId),
    userId: String(userId),
    authorName: user.display_name || user.username || 'Unknown',
    authorAvatar: user.avatar_url || null,
    content: String(content).trim(),
    parentCommentId: parentComment ? String(parentComment.commentId) : null,
    rootCommentId: parentComment ? String(parentComment.rootCommentId || parentComment.commentId) : commentId,
    likes: [],
    likeCount: 0,
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

  const enrichedComments = await Promise.all(comments.map(async (comment) => ({
    ...comment,
    parentCommentId: comment.parentCommentId || null,
    rootCommentId: comment.rootCommentId || comment.commentId,
    likes: Array.isArray(comment.likes) ? comment.likes : [],
    likeCount: Array.isArray(comment.likes) ? comment.likes.length : (comment.likeCount || 0),
    likeUsers: await enrichLikes(comment.likes),
  })));

  return { comments: enrichedComments, count: enrichedComments.length };
}

async function toggleCommentLike(commentId, userId) {
  const result = await ddbDocClient.send(new GetCommand({
    TableName: COMMENTS_TABLE,
    Key: { commentId: String(commentId) },
  }));
  const comment = result.Item;
  if (!comment) throw new Error('BÃ¬nh luáº­n khÃ´ng tá»“n táº¡i');

  const likes = Array.isArray(comment.likes) ? comment.likes : [];
  const userIdStr = String(userId);
  const alreadyLiked = likes.includes(userIdStr);
  const newLikes = alreadyLiked ? likes.filter(id => id !== userIdStr) : [...likes, userIdStr];

  await ddbDocClient.send(new UpdateCommand({
    TableName: COMMENTS_TABLE,
    Key: { commentId: String(commentId) },
    UpdateExpression: 'SET #likes = :likes, #likeCount = :likeCount',
    ExpressionAttributeNames: { '#likes': 'likes', '#likeCount': 'likeCount' },
    ExpressionAttributeValues: { ':likes': newLikes, ':likeCount': newLikes.length },
  }));

  return {
    liked: !alreadyLiked,
    likeCount: newLikes.length,
    likes: newLikes,
    likeUsers: await enrichLikes(newLikes),
  };
}

async function updateComment(commentId, userId, content) {
  if (!content || !String(content).trim()) throw new Error('Bình luận không được để trống');

  const result = await ddbDocClient.send(new GetCommand({
    TableName: COMMENTS_TABLE,
    Key: { commentId: String(commentId) },
  }));
  const comment = result.Item;
  if (!comment) throw new Error('Bình luận không tồn tại');
  if (String(comment.userId) !== String(userId)) {
    throw new Error('Bạn không có quyền chỉnh sửa bình luận này');
  }

  const updatedAt = new Date().toISOString();
  const nextContent = String(content).trim();
  await ddbDocClient.send(new UpdateCommand({
    TableName: COMMENTS_TABLE,
    Key: { commentId: String(commentId) },
    UpdateExpression: 'SET #content = :content, #updatedAt = :updatedAt',
    ExpressionAttributeNames: { '#content': 'content', '#updatedAt': 'updatedAt' },
    ExpressionAttributeValues: { ':content': nextContent, ':updatedAt': updatedAt },
  }));

  return { ...comment, content: nextContent, updatedAt };
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

  const branchResult = await ddbDocClient.send(new ScanCommand({
    TableName: COMMENTS_TABLE,
    FilterExpression: '#pid = :pid',
    ExpressionAttributeNames: { '#pid': 'postId' },
    ExpressionAttributeValues: { ':pid': String(comment.postId) },
  }));
  const allComments = branchResult.Items || [];
  const deletedIds = new Set([String(commentId)]);
  let foundChild = true;
  while (foundChild) {
    foundChild = false;
    for (const item of allComments) {
      if (item.parentCommentId && deletedIds.has(String(item.parentCommentId)) && !deletedIds.has(String(item.commentId))) {
        deletedIds.add(String(item.commentId));
        foundChild = true;
      }
    }
  }

  await Promise.all([...deletedIds].map(id => ddbDocClient.send(new DeleteCommand({
    TableName: COMMENTS_TABLE,
    Key: { commentId: id },
  }))));

  // Decrease comment count on post
  try {
    await ddbDocClient.send(new UpdateCommand({
      TableName: POSTS_TABLE,
      Key: { postId: String(comment.postId) },
      UpdateExpression: 'SET #commentCount = if_not_exists(#commentCount, :deletedCount) - :deletedCount',
      ExpressionAttributeNames: { '#commentCount': 'commentCount' },
      ExpressionAttributeValues: { ':deletedCount': deletedIds.size },
    }));
  } catch (e) {
    console.warn('Failed to decrease comment count:', e.message);
  }

  return { deleted: true, deletedCommentIds: [...deletedIds] };
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
  updateComment,
  toggleCommentLike,
  deleteComment,
};
