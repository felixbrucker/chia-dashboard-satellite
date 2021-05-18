const axios = require('axios');

const config = require('./config');
const logger = require('./logger');
const version = require('../version');

class ChiaDashboardUpdater {
  init() {
    this.client = axios.create({
      baseURL: `${config.chiaDashboardCoreUrl}/api`,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'satellite-version': version,
      },
    });
  }

  async updateStats(stats) {
    try {
      await this.client.patch('satellite', stats);
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
