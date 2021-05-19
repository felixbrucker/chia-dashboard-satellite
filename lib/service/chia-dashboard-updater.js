const config = require('./config');
const logger = require('./logger');
const ChiaDashboardClient = require('../chia-dashboard-client');

class ChiaDashboardUpdater {
  init() {
    this.client = new ChiaDashboardClient({
      dashboardCoreUrl: config.chiaDashboardCoreUrl,
      apiKey: config.apiKey,
    });
  }

  async updateStats(stats) {
    try {
      await this.client.updateStats(stats);
    } catch (err) {
      if (err.response && err.response.status === 401) {
        logger.log({ level: 'error', msg: `Dashboard Updater | The api key for this satellite is invalid. Please use a valid api key!`});
      } else {
        logger.log({ level: 'error', msg: `Dashboard Updater | ${err}`});
      }
    }
  }
}

module.exports = new ChiaDashboardUpdater();
