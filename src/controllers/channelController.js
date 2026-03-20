const channelService = require('../services/channelService');

async function getChannelsByGroup(req, res) {
  try {
    const groupId = Number(req.params.groupId);
    const channels = await channelService.getChannelsByGroup(groupId);
    res.json(channels);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getChannelById(req, res) {
  try {
    const channelId = Number(req.params.channelId);
    const channel = await channelService.getChannelById(channelId);
    if (!channel) {
      return res.status(404).json({ message: 'Channel not found' });
    }
    res.json(channel);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

module.exports = {
  getChannelsByGroup,
  getChannelById
};
