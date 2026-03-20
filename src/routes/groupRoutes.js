const express = require('express');
const router = express.Router();

const groupController = require('../controllers/groupController');

router.post('/', groupController.createGroup);
router.get('/', groupController.listGroups);
router.get('/:groupId', groupController.getGroupById);
router.post('/:groupId/members', groupController.addMemberToGroup);
router.get('/user/:userId', groupController.getGroupsForUser);

module.exports = router;
