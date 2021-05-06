const { Connection, ApiClient, constants } = require('chia-api');
const BigNumber = require('bignumber.js');
const { throttle } = require('lodash');
const moment = require('moment');

const config = require('./config');
const logger = require('./logger');
const chiaDashboardUpdater = require('./chia-dashboard-updater');
const ChiaConfig = require('../chia-config');
const Capacity = require('../capacity');
const ChiaAmount = require('../chia-amount');
const { updateStartedAtOfJob } = require('../util');

const allServices = [
  constants.SERVICE.fullNode,
  constants.SERVICE.wallet,
  constants.SERVICE.farmer,
  constants.SERVICE.harvester,
  constants.SERVICE.plotter,
];

class StatsCollection {
  constructor() {
    this.isServiceRunning = new Map();
    this.stats = new Map();
    this.partialStats = {};
    this.updateStatsThrottled = throttle(async partialStats => {
      this.partialStats = {};
      await chiaDashboardUpdater.updateStats(partialStats);
    }, 5 * 1000, { leading: true, trailing: true });
    allServices.forEach(service => {
      this.stats.set(service, {});
      this.isServiceRunning.set(service, false);
    });
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
    this.plotterApiClient = new ApiClient.Plotter({ connection: this.connection, origin: this.origin });

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
    this.fullNodeApiClient.onNewBlockchainState(async (blockchainState) => {
      const fullNodeStats = this.stats.has(constants.SERVICE.fullNode) ? this.stats.get(constants.SERVICE.fullNode) : {};
      fullNodeStats.blockchainState = this.getRelevantBlockchainState(blockchainState);
      await this.setStatsForService(constants.SERVICE.fullNode, fullNodeStats);
    });
    this.fullNodeApiClient.onConnectionChange(async connections => {
      const fullNodeStats = this.stats.has(constants.SERVICE.fullNode) ? this.stats.get(constants.SERVICE.fullNode) : {};
      const fullNodeConnections = connections.filter(conn => conn.type === constants.SERVICE_TYPE.fullNode);
      fullNodeStats.fullNodeConnections = fullNodeConnections.map(connection => this.getRelevantConnectionData(connection));
      await this.setStatsForService(constants.SERVICE.fullNode, fullNodeStats);
    });
    this.farmerApiClient.onNewFarmingInfo(async (newFarmingInfo) => {
      const farmerStats = this.stats.has(constants.SERVICE.farmer) ? this.stats.get(constants.SERVICE.farmer) : {};
      if (!farmerStats.farmingInfos) {
        farmerStats.farmingInfos = [];
      }
      const relevantFarmingInfo = this.getRelevantFarmingInfoData(newFarmingInfo);
      let matchingFarmingInfo = farmerStats.farmingInfos.find(farmingInfo =>
        farmingInfo.challenge === relevantFarmingInfo.challenge && farmingInfo.signagePoint === relevantFarmingInfo.signagePoint
      );
      if (!matchingFarmingInfo) {
        matchingFarmingInfo = {
          challenge: relevantFarmingInfo.challenge,
          signagePoint: relevantFarmingInfo.signagePoint,
          proofs: 0,
          passedFilter: 0,
          totalPlots: 0,
          lastUpdated: new Date(),
        };
        farmerStats.farmingInfos.unshift(matchingFarmingInfo);
      }
      matchingFarmingInfo.proofs += relevantFarmingInfo.proofs;
      matchingFarmingInfo.passedFilter += relevantFarmingInfo.passedFilter;
      matchingFarmingInfo.totalPlots += relevantFarmingInfo.totalPlots;
      matchingFarmingInfo.lastUpdated = moment.unix(relevantFarmingInfo.timestamp).toDate();

      farmerStats.farmingInfos = farmerStats.farmingInfos.slice(0, 20);
      await this.setStatsForService(constants.SERVICE.farmer, farmerStats);
    });
    this.plotterApiClient.onNewPlottingQueueStats(async queue => {
      const plotterStats = this.stats.has(constants.SERVICE.plotter) ? this.stats.get(constants.SERVICE.plotter) : {};
      if (!plotterStats.jobs) {
        plotterStats.jobs = [];
      }
      let updated = false;
      queue.forEach(job => {
        if (job.deleted || job.state === 'FINISHED') {
          plotterStats.jobs = plotterStats.jobs.filter(curr => curr.id !== job.id);
          updated = true;

          return;
        }
        let existingJob = plotterStats.jobs.find(curr => curr.id === job.id);
        if (!existingJob) {
          existingJob = { id: job.id };
          plotterStats.jobs.push(existingJob);
        }
        if (existingJob.state !== job.state) {
          updateStartedAtOfJob({ existingJob, job });
          existingJob.state = job.state;
          updated = true;
        }
        if (existingJob.kSize !== job.size) {
          existingJob.kSize = job.size;
          updated = true;
        }
      });
      if (updated) {
        await this.setStatsForService(constants.SERVICE.plotter, plotterStats);
      }
    });
    await this.walletApiClient.init();
    await this.fullNodeApiClient.init();
    await this.farmerApiClient.init();
    await this.harvesterApiClient.init();
    await this.plotterApiClient.init();
    await this.updateRunningServices();
    await this.updateStats();
    await this.updateFullNodeStats();
    setInterval(this.updateStats.bind(this), 15 * 1000);
    setInterval(this.updateRunningServices.bind(this), 60 * 1000);
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
    this.partialStats[service] = stats;
    this.updateStatsThrottled(this.partialStats);
  }

  async deleteStatsForService(service) {
    this.stats.delete(service);
    this.partialStats[service] = null;
    this.updateStatsThrottled(this.partialStats);
  }

  getRelevantConnectionData(connection) {
    return {
      readMib: Capacity.fromBytes(connection.bytes_read).toMib().toString(),
      writtenMib: Capacity.fromBytes(connection.bytes_written).toMib().toString(),
      lastMessageTimestamp: connection.last_message_time,
      ip: connection.peer_host,
    };
  }

  getRelevantFarmingInfoData(farmingInfo) {
    return {
      challenge: farmingInfo.challenge_hash,
      signagePoint: farmingInfo.signage_point,
      proofs: farmingInfo.proofs,
      passedFilter: farmingInfo.passed_filter,
      totalPlots: farmingInfo.total_plots,
      timestamp: farmingInfo.timestamp,
    };
  }

  getRelevantBlockchainState(blockchainState) {
    return {
      difficulty: blockchainState.difficulty,
      spaceInGib: Capacity.fromBytes(blockchainState.space).capacityInGib.toString(),
      syncStatus: {
        synced: blockchainState.sync.synced,
        syncing: blockchainState.sync.sync_mode,
        syncedHeight: blockchainState.peak.height,
        tipHeight: blockchainState.sync.sync_tip_height || blockchainState.peak.height,
      },
      timestamp: blockchainState.peak.timestamp,
    };
  }

  async updateWalletStats() {
    const service = constants.SERVICE.wallet;
    if (!this.isServiceRunning.get(service)) {
      return;
    }
    const walletStats = this.stats.has(service) ? this.stats.get(service) : {};
    const wallets = await this.walletApiClient.getWallets();
    walletStats.wallets = await Promise.all(wallets.map(async wallet => {
      const balance = await this.walletApiClient.getBalance({ walletId: wallet.id });

      return {
        id: wallet.id,
        name: wallet.name,
        type: wallet.type,
        balance: {
          confirmed: ChiaAmount.fromRaw(balance.confirmed_wallet_balance).toString(),
          spendable: ChiaAmount.fromRaw(balance.spendable_balance).toString(),
          unconfirmed: ChiaAmount.fromRaw(balance.unconfirmed_wallet_balance).toString(),
        },
      };
    }));
    const syncStatus = await this.walletApiClient.getWalletSyncStatus();
    const syncedHeight = await this.walletApiClient.getWalletSyncedHeight();
    walletStats.syncStatus = {
      synced: syncStatus.synced,
      syncing: syncStatus.syncing,
      syncedHeight,
    };
    const farmedAmount = await this.walletApiClient.getFarmedAmount();
    walletStats.farmedAmount = {
      farmedAmount: ChiaAmount.fromRaw(farmedAmount.farmed_amount).toString(),
      poolRewardAmount: ChiaAmount.fromRaw(farmedAmount.pool_reward_amount).toString(),
      farmerRewardAmount: ChiaAmount.fromRaw(farmedAmount.farmer_reward_amount).toString(),
      feeAmount: ChiaAmount.fromRaw(farmedAmount.fee_amount).toString(),
      lastHeightFarmed: farmedAmount.last_height_farmed,
    };
    await this.setStatsForService(service, walletStats);
  }

  async updateFullNodeStats() {
    const service = constants.SERVICE.fullNode;
    if (!this.isServiceRunning.get(service)) {
      return;
    }
    const fullNodeStats = this.stats.has(service) ? this.stats.get(service) : {};
    fullNodeStats.blockchainState = this.getRelevantBlockchainState(await this.fullNodeApiClient.getBlockchainState());
    const connections = await this.fullNodeApiClient.getConnections();
    const fullNodeConnections = connections.filter(conn => conn.type === constants.SERVICE_TYPE.fullNode);
    fullNodeStats.fullNodeConnections = fullNodeConnections.map(connection => this.getRelevantConnectionData(connection));
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
    const connections = await this.harvesterApiClient.getConnections();
    const farmerConnections = connections.filter(conn => conn.type === constants.SERVICE_TYPE.farmer);
    harvesterStats.farmerConnections = farmerConnections.map(connection => this.getRelevantConnectionData(connection));
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
