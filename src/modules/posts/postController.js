const postService = require('./postService');

async function createPost(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Chưa xác thực' });

    const { content, media } = req.body || {};
    const post = await postService.createPost(userId, { content, media });
    res.status(201).json(post);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

async function getFeedPosts(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Chưa xác thực' });

    const limit = parseInt(req.query.limit) || 20;
    const result = await postService.getFeedPosts(userId, { limit });
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getUserPosts(req, res) {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ message: 'Thiếu userId' });

    const limit = parseInt(req.query.limit) || 20;
    const result = await postService.getUserPosts(userId, { limit });
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getPostById(req, res) {
  try {
    const post = await postService.getPostById(req.params.postId);
    if (!post) return res.status(404).json({ message: 'Không tìm thấy bài viết' });
    res.json(post);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function toggleLike(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Chưa xác thực' });

    const { postId } = req.params;
    const result = await postService.toggleLike(postId, userId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

async function deletePost(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Chưa xác thực' });

    const result = await postService.deletePost(req.params.postId, userId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

async function createComment(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Chưa xác thực' });

    const { postId } = req.params;
    const { content } = req.body || {};
    const comment = await postService.createComment(postId, userId, { content });
    res.status(201).json(comment);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

async function getComments(req, res) {
  try {
    const { postId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const result = await postService.getComments(postId, { limit });
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function deleteComment(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Chưa xác thực' });

    const result = await postService.deleteComment(req.params.commentId, userId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

module.exports = {
  createPost,
  getFeedPosts,
  getUserPosts,
  getPostById,
  toggleLike,
  deletePost,
  createComment,
  getComments,
  deleteComment,
};
