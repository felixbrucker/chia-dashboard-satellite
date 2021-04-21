const axios = require('axios');

const config = require('./config');
const logger = require('./logger');

class ChiaDashboardUpdater {
  constructor() {
    this.client = axios.create({
      baseURL: 'http://127.0.0.1:5000/api',
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
