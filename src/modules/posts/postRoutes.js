const express = require('express');
const router = express.Router();
const postController = require('./postController');
const authMiddleware = require('../../middlewares/authMiddleware');

// Posts
router.post('/', authMiddleware, postController.createPost);
router.get('/feed', authMiddleware, postController.getFeedPosts);
router.get('/user/:userId', authMiddleware, postController.getUserPosts);
router.get('/:postId', authMiddleware, postController.getPostById);
router.put('/:postId', authMiddleware, postController.updatePost);
router.put('/:postId/like', authMiddleware, postController.toggleLike);
router.delete('/:postId', authMiddleware, postController.deletePost);

// Comments
router.post('/:postId/comments', authMiddleware, postController.createComment);
router.get('/:postId/comments', authMiddleware, postController.getComments);
router.put('/comments/:commentId', authMiddleware, postController.updateComment);
router.put('/comments/:commentId/like', authMiddleware, postController.toggleCommentLike);
router.delete('/comments/:commentId', authMiddleware, postController.deleteComment);

module.exports = router;
