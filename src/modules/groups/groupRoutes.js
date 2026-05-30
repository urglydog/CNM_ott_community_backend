const express = require('express');
const router = express.Router();

const groupController = require('./groupController');
const authMiddleware = require('../../common/middlewares/authMiddleware');

router.post('/', authMiddleware, groupController.createGroup);
router.delete('/:groupId/disband', authMiddleware, groupController.disbandGroup);
router.post('/:groupId/disband', authMiddleware, groupController.disbandGroup);

router.get('/', groupController.listGroups);
router.get('/invite/:inviteCode', authMiddleware, groupController.getGroupByInviteCode);
router.get('/:groupId', groupController.getGroupById);
router.post('/:groupId/members', authMiddleware, groupController.addMembers);
router.delete('/:groupId/members/:userId', authMiddleware, groupController.kickMember);
router.patch('/:groupId/members/:userId/role', authMiddleware, groupController.updateRole);
router.delete('/:groupId/leave', authMiddleware, groupController.leaveGroup);
router.post('/:groupId/leave', authMiddleware, groupController.leaveGroup);
router.get('/:groupId/members', authMiddleware, groupController.getGroupMembers);
router.get('/:groupId/invite', authMiddleware, groupController.getInviteInfo);
router.post('/join/:inviteCode', authMiddleware, groupController.joinGroup);
router.get('/user/:userId', authMiddleware, groupController.getGroupsForUser);
router.post('/:groupId/requests', authMiddleware, groupController.requestToJoin);
router.get('/:groupId/requests', authMiddleware, groupController.getPendingRequests);
router.patch('/:groupId/requests/:userId', authMiddleware, groupController.handleJoinRequest);
router.patch('/:groupId/settings', authMiddleware, groupController.updateGroupSettings);
router.get('/debug/members/:userId', groupController.debugMembers);

module.exports = router;
