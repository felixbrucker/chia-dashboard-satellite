const { Connection, ApiClient, constants } = require('chia-api');
const BigNumber = require('bignumber.js');

const config = require('./config');
const logger = require('./logger');
const chiaDashboardUpdater = require('./chia-dashboard-updater');
const ChiaConfig = require('../chia-config');
const Capacity = require('../capacity');

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
    this.connection.addService(constants.SERVICE.walletUi);
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
    setInterval(this.updateRunningServices.bind(this), 60 * 1000);
    this.fullNodeApiClient.onNewBlockchainState(async (blockchainStateMessage) => {
      const fullNodeStats = this.stats.has(constants.SERVICE.fullNode) ? this.stats.get(constants.SERVICE.fullNode) : {};
      fullNodeStats.blockchainState = blockchainStateMessage.data.blockchain_state;
      await this.setStatsForService(constants.SERVICE.fullNode, fullNodeStats);
    });
    this.farmerApiClient.onNewFarmingInfo(async (newFarmingInfoMessage) => {
      const farmerStats = this.stats.has(constants.SERVICE.farmer) ? this.stats.get(constants.SERVICE.farmer) : {};
      if (!farmerStats.farmingInfos) {
        farmerStats.farmingInfos = [];
      }
      farmerStats.farmingInfos.unshift(newFarmingInfoMessage.data);
      farmerStats.farmingInfos = farmerStats.farmingInfos.slice(0, 20);
      await this.setStatsForService(constants.SERVICE.farmer, farmerStats);
    });
    await this.updateStats();
    setInterval(this.updateStats.bind(this), 15 * 1000);
    await this.updateFullNodeStats();
  }

  async updateStats() {
    try {
      await Promise.all([
        this.updateWalletStats(),
        this.updateHarvesterStats(),
      ]);
    } catch (err) {
      logger.log({ level: 'error', msg: `Stats Collection | ${err}`});
    }
  }

  async setStatsForService(service, stats) {
    this.stats.set(service, stats);
    await chiaDashboardUpdater.updateStatsThrottled({ [service]: stats });
  }

  async deleteStatsForService(service) {
    this.stats.delete(service);
    await chiaDashboardUpdater.updateStatsThrottled({ [service]: null });
  }

  async updateWalletStats() {
    const service = constants.SERVICE.wallet;
    if (!this.isServiceRunning.get(service)) {
      return;
    }
    const walletStats = this.stats.has(service) ? this.stats.get(service) : {};
    walletStats.wallets = await this.walletApiClient.getWallets();
    await Promise.all(walletStats.wallets.map(async wallet => {
      wallet.balance = await this.walletApiClient.getBalance({ walletId: wallet.id });
    }));
    walletStats.syncStatus = await this.walletApiClient.getWalletSyncStatus();
    walletStats.syncedHeight = await this.walletApiClient.getWalletSyncedHeight();
    await this.setStatsForService(service, walletStats);
  }

  async updateFullNodeStats() {
    const service = constants.SERVICE.fullNode;
    if (!this.isServiceRunning.get(service)) {
      return;
    }
    const fullNodeStats = this.stats.has(service) ? this.stats.get(service) : {};
    fullNodeStats.blockchainState = await this.fullNodeApiClient.getBlockchainState();
    await this.setStatsForService(service, fullNodeStats);
  }

  async updateHarvesterStats() {
    const service = constants.SERVICE.harvester;
    if (!this.isServiceRunning.get(service)) {
      return;
    }
    const harvesterStats = this.stats.has(service) ? this.stats.get(service) : {};
    const { plots } = await this.harvesterApiClient.getPlots();
    harvesterStats.plotCount = plots.length;
    harvesterStats.totalCapacityInGib = plots
      .map(plot => Capacity.fromBytes(plot.file_size))
      .reduce((acc, capacity) => acc.plus(capacity.capacityInGib), new BigNumber(0))
      .toString();
    await this.setStatsForService(service, harvesterStats);
  }

  async updateFarmerStats() {
    const service = constants.SERVICE.farmer;
    if (!this.isServiceRunning.get(service)) {
      return;
    }
  }

  async updateRunningServices() {
    await Promise.all(allServices.map(async service => {
      const isRunning = await this.daemonApiClient.isServiceRunning(service);

      this.isServiceRunning.set(service, isRunning);
      if (!isRunning && this.stats.has(service)) {
        await this.deleteStatsForService(service);
      }
    }));
  }

  getStats() {
    return Object.fromEntries(this.stats);
  }
}

module.exports = new StatsCollection();
