const axios = require('axios');

const config = require('./config');
const logger = require('./logger');

class ChiaDashboardUpdater {
  constructor() {
    this.client = axios.create({
      baseURL: 'https://chia-dashboard-api.foxypool.io/api',
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
      logger.log({ level: 'error', msg: `Dashboard Updater | ${err}`});
    }
  }
}

module.exports = new ChiaDashboardUpdater();
