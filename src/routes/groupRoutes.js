const express = require('express');
const router = express.Router();

const groupController = require('../controllers/groupController');

router.post('/', groupController.createGroup);
router.get('/', groupController.listGroups);
router.get('/:groupId', groupController.getGroupById);
router.post('/:groupId/members', groupController.addMemberToGroup);
router.get('/user/:userId', groupController.getGroupsForUser);
router.get('/:groupId/invite', groupController.getInviteInfo);
router.post('/join/:inviteCode', groupController.joinGroup);
router.get('/members/debug/:userId', groupController.debugMembers);

module.exports = router;
