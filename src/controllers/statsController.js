const statsService = require('../services/statsService');

async function getOverviewStats(req, res) {
  try {
    const stats = await statsService.getOverviewStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

module.exports = { getOverviewStats };
