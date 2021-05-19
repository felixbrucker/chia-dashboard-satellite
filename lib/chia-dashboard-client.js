const axios = require('axios');

const version = require('./version');

class ChiaDashboardClient {
  constructor({ dashboardCoreUrl, apiKey = null }) {
    const headers = { 'satellite-version': version };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    this.client = axios.create({
      baseURL: `${dashboardCoreUrl}/api`,
      headers,
      timeout: 15 * 1000,
    });
  }

  async ping() {
    await this.client.get('ping');
  }

  async updateStats(stats) {
    await this.client.patch('satellite', stats);
  }
}

module.exports = ChiaDashboardClient;
