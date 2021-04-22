const axios = require('axios');
const { throttle } = require('lodash');

const config = require('./config');
const logger = require('./logger');

class ChiaDashboardUpdater {
  constructor() {
    this.client = axios.create({
      baseURL: 'https://chia-dashboard-api.foxypool.io/api',
    });
    this.updateStatsThrottled = throttle(this.updateStats.bind(this), 5 * 1000, { leading: true, trailing: true });
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
