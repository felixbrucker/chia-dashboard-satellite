const axios = require('axios');

const config = require('./config');
const logger = require('./logger');
const version = require('../version');

class ChiaDashboardUpdater {
  constructor() {
    this.client = axios.create({
      baseURL: 'https://chia-dashboard-api.foxypool.io/api',
      headers: { 'satellite-version': version },
    });
  }

  init() {
    this.client.interceptors.request.use(
      requestConfig => {
        requestConfig.headers.Authorization = `Bearer ${config.apiKey}`;

        return requestConfig;
      },
      Promise.reject
    );
  }

  async updateStats(stats) {
    try {
      await this.client.patch('satellite', stats);
    } catch (err) {
      if (err.response.status === 401) {
        logger.log({ level: 'error', msg: `Dashboard Updater | The api key for this satellite is invalid. Please use a valid api key!`});
      } else {
        logger.log({ level: 'error', msg: `Dashboard Updater | ${err}`});
      }
    }
  }
}

module.exports = new ChiaDashboardUpdater();
