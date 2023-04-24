const config = require('./config');
const logger = require('./logger');
const ChiaDashboardClient = require('../chia-dashboard-client');

class ChiaDashboardUpdater {
  async init() {
    const dashboardApiUrlKeyPairs = config.chiaDashboardCoreUrlKeyPairs
    if (dashboardApiUrlKeyPairs.length > 1) {
      await this.updateBestDashboardCoreApiClient(dashboardApiUrlKeyPairs)
      setInterval(this.updateBestDashboardCoreApiClient.bind(this, dashboardApiUrlKeyPairs), 5 * 60 * 1000)
    }

    if (this.client === undefined) {
      this.client = new ChiaDashboardClient({
        dashboardCoreUrl: dashboardApiUrlKeyPairs[0].dashboardCoreUrl,
        apiKey: dashboardApiUrlKeyPairs[0].apiKey,
      })
    }
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

  async updateBestDashboardCoreApiClient(dashboardApiUrlKeyPairs) {
    try {
      const results = await Promise.allSettled(
        dashboardApiUrlKeyPairs.map(dashboardApiUrlKeyPair => this.checkAvailabilityOfApi(dashboardApiUrlKeyPair))
      )
      const availableClients = results
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value)
      if (availableClients.length === 0) {
        return
      }
      if (this.client !== undefined && availableClients.some(client => client.client.dashboardCoreUrl === this.client.dashboardCoreUrl)) {
        return
      }
      const bestClient = availableClients.reduce((bestClient, currentClient) => bestClient === undefined || bestClient.latencyInMs > currentClient.latencyInMs ? currentClient : bestClient, undefined)
      const verb = this.client !== undefined ? 'Switching to' : 'Using'
      logger.log({ level: 'info', msg: `Dashboard Updater | ${verb} ${bestClient.client.dashboardCoreUrl}, latency=${bestClient.latencyInMs.toFixed(0)}ms`})
      this.client = bestClient.client
    } catch (err) {}
  }

  async checkAvailabilityOfApi({ dashboardCoreUrl, apiKey }) {
    const client = new ChiaDashboardClient({
      dashboardCoreUrl,
      apiKey,
    })
    const start = new Date()
    await client.ping()
    const latencyInMs = (new Date()).getTime() - start.getTime()

    return {
      client,
      latencyInMs,
    }
  }
}

module.exports = new ChiaDashboardUpdater();
