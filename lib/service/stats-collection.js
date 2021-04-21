const { Connection, ApiClient, constants } = require('chia-api');

const config = require('./config');
const logger = require('./logger');
const chiaDashboardUpdater = require('./chia-dashboard-updater');
const ChiaConfig = require('../chia-config');

const allServices = [
  constants.SERVICE.fullNode,
  constants.SERVICE.wallet,
  constants.SERVICE.farmer,
  constants.SERVICE.harvester,
];

class StatsCollection {
  constructor() {
    this.isServiceRunning = new Map();
    this.stats = new Map();
    allServices.forEach(service => this.isServiceRunning.set(service, false));
  }

  async init() {
    const chiaConfig = new ChiaConfig(config.chiaConfigDirectory);
    await chiaConfig.load();
    this.origin = 'chia-dashboard-satellite';
    const daemonAddress = config.chiaDaemonAddress || chiaConfig.daemonAddress;
    const daemonSslCertFile = await chiaConfig.getDaemonSslCertFile();
    const daemonSslKeyFile = await chiaConfig.getDaemonSslKeyFile();
    this.connection = new Connection(daemonAddress, {
      cert: daemonSslCertFile,
      key: daemonSslKeyFile,
      timeoutInSeconds: 15,
    });
    this.connection.onError(err => logger.log({level: 'error', msg: `Stats Collection | ${err}`}));
    this.walletApiClient = new ApiClient.Wallet({ connection: this.connection, origin: this.origin });
    this.fullNodeApiClient = new ApiClient.FullNode({ connection: this.connection, origin: this.origin });
    this.farmerApiClient = new ApiClient.Farmer({ connection: this.connection, origin: this.origin });
    this.harvesterApiClient = new ApiClient.Harvester({ connection: this.connection, origin: this.origin });
    this.daemonApiClient = new ApiClient.Daemon({ connection: this.connection, origin: this.origin });

    let wasWaitingForDaemon = false;
    try {
      await this.connection.connect();
    } catch (err) {
      logger.log({level:'info', msg: `Stats Collection | Waiting for daemon to be reachable ..`});
      wasWaitingForDaemon = true;
    }
    while (!this.connection.connected) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (wasWaitingForDaemon) {
      // Wait a little extra till the services are started up
      await new Promise(resolve => setTimeout(resolve, 5 * 1000));
    }
    await Promise.all([
      this.walletApiClient.init(),
      this.fullNodeApiClient.init(),
      this.farmerApiClient.init(),
      this.harvesterApiClient.init(),
    ]);
    await this.updateRunningServices();
    setInterval(this.updateRunningServices.bind(this), 5 * 60 * 1000);
    await this.updateStats();
    setInterval(this.updateStats.bind(this), 10 * 1000);
  }

  async updateStats() {
    try {
      await Promise.all([
        this.updateFullNodeStats(),
        this.updateWalletStats(),
        this.updateHarvesterStats(),
      ]);
    } catch (err) {
      logger.log({ level: 'error', msg: `Stats Collection | ${err}`});
    }

    await chiaDashboardUpdater.updateStats(this.getStats());
  }

  async updateWalletStats() {
    if (!this.isServiceRunning.get(constants.SERVICE.wallet)) {
      if (this.stats.has(constants.SERVICE.wallet)) {
        this.stats.delete(constants.SERVICE.wallet);
      }

      return;
    }
    const walletStats = this.stats.has(constants.SERVICE.wallet) ? this.stats.get(constants.SERVICE.wallet) : {};
    walletStats.wallets = await this.walletApiClient.getWallets();
    await Promise.all(walletStats.wallets.map(async wallet => {
      wallet.balance = await this.walletApiClient.getBalance({ walletId: wallet.id });
    }));
    walletStats.syncStatus = await this.walletApiClient.getWalletSyncStatus();
    walletStats.syncedHeight = await this.walletApiClient.getWalletSyncedHeight();
    this.stats.set(constants.SERVICE.wallet, walletStats);
  }

  async updateFullNodeStats() {
    if (!this.isServiceRunning.get(constants.SERVICE.fullNode)) {
      if (this.stats.has(constants.SERVICE.fullNode)) {
        this.stats.delete(constants.SERVICE.fullNode);
      }

      return;
    }
    const fullNodeStats = this.stats.has(constants.SERVICE.fullNode) ? this.stats.get(constants.SERVICE.fullNode) : {};
    fullNodeStats.blockchainState = await this.fullNodeApiClient.getBlockchainState();
    this.stats.set(constants.SERVICE.fullNode, fullNodeStats);
  }

  async updateHarvesterStats() {
    const service = constants.SERVICE.harvester;
    if (!this.isServiceRunning.get(service)) {
      if (this.stats.has(service)) {
        this.stats.delete(service);
      }

      return;
    }
    const harvesterStats = this.stats.has(service) ? this.stats.get(service) : {};
    harvesterStats.plots = await this.harvesterApiClient.getPlots();
    this.stats.set(service, harvesterStats);
  }

  async updateRunningServices() {
    await Promise.all(allServices.map(async service => {
      const isRunning = await this.daemonApiClient.isServiceRunning(service);

      this.isServiceRunning.set(service, isRunning);
    }));
  }

  getStats() {
    return Object.fromEntries(this.stats);
  }
}

module.exports = new StatsCollection();
