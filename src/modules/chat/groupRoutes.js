const express = require('express');
const router = express.Router();

const groupController = require('./groupController');
const authMiddleware = require('../../common/middlewares/authMiddleware');

router.post('/', authMiddleware, groupController.createGroup);
router.get('/', groupController.listGroups);
router.get('/:groupId', groupController.getGroupById);
router.post('/:groupId/members', groupController.addMemberToGroup);
router.get('/:groupId/invite', authMiddleware, groupController.getInviteInfo);
router.post('/join/:inviteCode', authMiddleware, groupController.joinGroup);
router.get('/user/:userId', authMiddleware, groupController.getGroupsForUser);
router.get('/debug/members/:userId', groupController.debugMembers);

module.exports = router;
