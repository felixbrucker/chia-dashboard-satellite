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
const { updateStartedAtOfJob, getProgressOfJob } = require('../util');

const allServices = [
  constants.SERVICE.fullNode,
  constants.SERVICE.wallet,
  constants.SERVICE.farmer,
  constants.SERVICE.harvester,
  constants.SERVICE.plotter,
];
const plotterStates = {
  RUNNING: 'RUNNING',
  FINISHED: 'FINISHED',
  SUBMITTED: 'SUBMITTED',
};

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
    this.enabledServices = allServices;
    this.partialStats[constants.SERVICE.plotter] = null;
  }

  async init() {
    if (config.excludedServices && Array.isArray(config.excludedServices)) {
      config.excludedServices
        .map(excludedService => constants.SERVICE[excludedService])
        .filter(excludedService => !!excludedService)
        .forEach(excludedService => {
          this.enabledServices = this.enabledServices.filter(service => service !== excludedService);
          this.deleteStatsForService(excludedService);
        });
    }
    const chiaConfig = new ChiaConfig(config.chiaConfigDirectory);
    await chiaConfig.load();
    this.origin = 'chia-dashboard-satellite';
    const daemonAddress = config.chiaDaemonAddress || chiaConfig.daemonAddress;
    const daemonSslCertFile = await chiaConfig.getDaemonSslCertFile();
    const daemonSslKeyFile = await chiaConfig.getDaemonSslKeyFile();
    this.connection = new Connection(daemonAddress, {
      cert: daemonSslCertFile,
      key: daemonSslKeyFile,
      timeoutInSeconds: 20,
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
    if (this.isServiceEnabled(constants.SERVICE.fullNode)) {
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
    }
    if (this.isServiceEnabled(constants.SERVICE.farmer)) {
      this.farmerApiClient.onNewSignagePoint(async (newSignagePoint) => {
        const farmerStats = this.stats.has(constants.SERVICE.farmer) ? this.stats.get(constants.SERVICE.farmer) : {};
        if (!farmerStats.farmingInfos) {
          farmerStats.farmingInfos = [];
        }
        const relevantSignagePointData = this.getRelevantSignagePointData(newSignagePoint);
        let matchingFarmingInfo = farmerStats.farmingInfos.find(farmingInfo =>
          farmingInfo.challenge === relevantSignagePointData.challenge && farmingInfo.signagePoint === relevantSignagePointData.signagePoint
        );
        if (matchingFarmingInfo) {
          return;
        }
        matchingFarmingInfo = {
          challenge: relevantSignagePointData.challenge,
          signagePoint: relevantSignagePointData.signagePoint,
          receivedAt: relevantSignagePointData.receivedAt,
          proofs: 0,
          passedFilter: 0,
          totalPlots: 0,
          lastUpdated: new Date(),
        };
        farmerStats.farmingInfos.unshift(matchingFarmingInfo);

        this.setStatsForServiceWithoutUpdate(constants.SERVICE.farmer, farmerStats);
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
        let isNewlyCreated = false;
        if (!matchingFarmingInfo) {
          isNewlyCreated = true;
          matchingFarmingInfo = {
            challenge: relevantFarmingInfo.challenge,
            signagePoint: relevantFarmingInfo.signagePoint,
            receivedAt: new Date(),
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
        matchingFarmingInfo.lastUpdated = new Date();

        farmerStats.farmingInfos = farmerStats.farmingInfos.slice(0, 20);

        if (!farmerStats.harvesterResponseTimes) {
          farmerStats.harvesterResponseTimes = [];
        }
        if (!isNewlyCreated) {
          farmerStats.harvesterResponseTimes.unshift(moment().diff(matchingFarmingInfo.receivedAt, 'milliseconds'));
        }
        farmerStats.harvesterResponseTimes = farmerStats.harvesterResponseTimes.slice(0, 100);

        await this.setStatsForService(constants.SERVICE.farmer, farmerStats);
      });
    }
    if (this.isServiceEnabled(constants.SERVICE.plotter)) {
      const jobLogs = new Map();
      this.plotterApiClient.onNewPlottingQueueStats(async queue => {
        const plotterStats = this.stats.has(constants.SERVICE.plotter) ? this.stats.get(constants.SERVICE.plotter) : {};
        if (!plotterStats.jobs) {
          plotterStats.jobs = [];
        }
        let updated = false;
        let jobsArrayNeedsSort = false;
        queue.forEach(job => {
          if (job.deleted || job.state === plotterStates.FINISHED) {
            plotterStats.jobs = plotterStats.jobs.filter(curr => curr.id !== job.id);
            jobLogs.delete(job.id);
            updated = true;

            return;
          }
          let existingJob = plotterStats.jobs.find(curr => curr.id === job.id);
          if (!existingJob) {
            existingJob = { id: job.id };
            plotterStats.jobs.push(existingJob);
            jobsArrayNeedsSort = true;
            updated = true;
          }
          if (existingJob.state !== job.state) {
            updateStartedAtOfJob({ existingJob, job });
            existingJob.state = job.state;
            updated = true;
            jobsArrayNeedsSort = true;
          }
          if (existingJob.kSize !== job.size) {
            existingJob.kSize = job.size;
            updated = true;
          }
          if (job.log) {
            jobLogs.set(job.id, job.log);
          } else if (job.log_new) {
            const existingLog = jobLogs.get(job.id) || '';
            jobLogs.set(job.id, `${existingLog}${job.log_new}`);
          }
          const progress = getProgressOfJob({ job, log: jobLogs.get(job.id) });
          if (existingJob.progress !== progress) {
            existingJob.progress = progress;
            updated = true;
          }
        });
        if (jobsArrayNeedsSort) {
          plotterStats.jobs.sort((a, b) => {
            if (a.state === plotterStates.RUNNING && b.state !== plotterStates.RUNNING) {
              return -1;
            }
            if (a.state !== plotterStates.RUNNING && b.state === plotterStates.RUNNING) {
              return 1;
            }
            if (a.state === plotterStates.RUNNING && b.state === plotterStates.RUNNING) {
              return a.progress > b.progress ? -1 : 1;
            }

            return 0;
          });
        }
        if (updated) {
          await this.setStatsForService(constants.SERVICE.plotter, plotterStats);
        }
      });
    }

    if (this.isServiceEnabled(constants.SERVICE.wallet)) {
      await this.walletApiClient.init();
    }
    if (this.isServiceEnabled(constants.SERVICE.fullNode)) {
      await this.fullNodeApiClient.init();
    }
    if (this.isServiceEnabled(constants.SERVICE.fullNode)) {
      await this.farmerApiClient.init();
    }
    if (this.isServiceEnabled(constants.SERVICE.harvester)) {
      await this.harvesterApiClient.init();
    }
    if (this.isServiceEnabled(constants.SERVICE.plotter)) {
      await this.plotterApiClient.init();
    }
    await this.tryUntilSucceeded(this.updateRunningServices.bind(this));
    await this.tryUntilSucceeded(this.updateStats.bind(this));
    await this.tryUntilSucceeded(this.updateFullNodeStats.bind(this));
    setInterval(this.updateStats.bind(this), 20 * 1000);
    setInterval(this.updateRunningServices.bind(this), 60 * 1000);
  }

  async tryUntilSucceeded(methodReturningPromise) {
    let succeeded = false;
    while (!succeeded) {
      try {
        await methodReturningPromise();
        succeeded = true;
      } catch (err) {
        logger.log({level:'error', msg: `Stats Collection | ${err.message}`});
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
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
    this.setStatsForServiceWithoutUpdate(service, stats);
    this.updateStatsThrottled(this.partialStats);
  }

  setStatsForServiceWithoutUpdate(service, stats) {
    this.stats.set(service, stats);
    this.partialStats[service] = stats;
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
      plotScanCompletedAt: moment.unix(farmingInfo.timestamp).toDate(),
    };
  }

  getRelevantSignagePointData(signagePoint) {
    return {
      challenge: signagePoint.challenge_hash,
      signagePoint: signagePoint.challenge_chain_sp,
      receivedAt: new Date(),
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
    // Ignore the plotter service here as it is only running when plotting
    await Promise.all(this.enabledServices.filter(service => service !== constants.SERVICE.plotter).map(async service => {
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

  isServiceEnabled(service) {
    return this.enabledServices.some(curr => curr === service);
  }
}

module.exports = new StatsCollection();
