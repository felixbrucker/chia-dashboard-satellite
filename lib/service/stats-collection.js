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

const fullNodeService = 'fullNode';
const walletService = 'wallet';
const farmerService = 'farmer';
const harvesterService = 'harvester';
const plotterService = 'plotter';

const allServices = [
  fullNodeService,
  walletService,
  farmerService,
  harvesterService,
  plotterService,
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
    }, 15 * 1000, { leading: true, trailing: true });
    allServices.forEach(service => {
      this.stats.set(service, {});
      this.isServiceRunning.set(service, false);
    });
    this.enabledServices = allServices;
    this.partialStats[plotterService] = null;
    this.walletIsLoggedIn = false;
  }

  async init() {
    if (config.excludedServices && Array.isArray(config.excludedServices)) {
      config.excludedServices
        .filter(excludedService => allServices.some(service => service === excludedService))
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
    if (this.isServiceEnabled(fullNodeService)) {
      this.fullNodeApiClient.onNewBlockchainState(async (blockchainState) => {
        const fullNodeStats = this.stats.has(fullNodeService) ? this.stats.get(fullNodeService) : {};
        fullNodeStats.blockchainState = this.getRelevantBlockchainState(blockchainState);
        await this.setStatsForService(fullNodeService, fullNodeStats);
      });
      this.fullNodeApiClient.onConnectionChange(async connections => {
        const fullNodeStats = this.stats.has(fullNodeService) ? this.stats.get(fullNodeService) : {};
        const fullNodeConnections = connections.filter(conn => conn.type === constants.SERVICE_TYPE.fullNode);
        fullNodeStats.fullNodeConnectionsCount = fullNodeConnections.length;
        await this.setStatsForService(fullNodeService, fullNodeStats);
      });
    }
    if (this.isServiceEnabled(farmerService)) {
      this.farmerApiClient.onNewSignagePoint(async (newSignagePoint) => {
        const farmerStats = this.stats.has(farmerService) ? this.stats.get(farmerService) : {};
        if (!farmerStats.farmingInfos) {
          farmerStats.farmingInfos = [];
        }
        const relevantSignagePointData = this.getRelevantSignagePointData(newSignagePoint);
        let matchingFarmingInfo = farmerStats.farmingInfos.find(farmingInfo =>
          farmingInfo.challenge === relevantSignagePointData.challenge && farmingInfo.signagePoint === relevantSignagePointData.signagePoint
        );
        let isNewlyCreated = false;
        if (!matchingFarmingInfo) {
          isNewlyCreated = true;
          matchingFarmingInfo = {
            challenge: relevantSignagePointData.challenge,
            signagePoint: relevantSignagePointData.signagePoint,
          };
        }
        // When a chain re-org happens treat it as a new SP because harvesters need to re-scan the plots as well
        matchingFarmingInfo.receivedAt = relevantSignagePointData.receivedAt;
        matchingFarmingInfo.proofs = 0;
        matchingFarmingInfo.passedFilter = 0;
        matchingFarmingInfo.totalPlots = 0;
        matchingFarmingInfo.lastUpdated = new Date();

        if (isNewlyCreated) {
          farmerStats.farmingInfos.unshift(matchingFarmingInfo);
        }
        this.sortFarmingInfos(farmerStats.farmingInfos);

        this.setStatsForServiceWithoutUpdate(farmerService, farmerStats);
      });

      let harvesterResponseTimes = [];
      this.farmerApiClient.onNewFarmingInfo(async (newFarmingInfo) => {
        const farmerStats = this.stats.has(farmerService) ? this.stats.get(farmerService) : {};
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
        this.sortFarmingInfos(farmerStats.farmingInfos);

        if (!isNewlyCreated) {
          harvesterResponseTimes.unshift(moment().diff(matchingFarmingInfo.receivedAt, 'milliseconds'));
        }
        harvesterResponseTimes = harvesterResponseTimes.slice(0, 100);
        if (harvesterResponseTimes.length > 0) {
          farmerStats.averageHarvesterResponseTime = harvesterResponseTimes
            .reduce((acc, curr) => acc.plus(curr), new BigNumber(0))
            .dividedBy(harvesterResponseTimes.length)
            .toNumber();
          farmerStats.worstHarvesterResponseTime = harvesterResponseTimes
            .reduce((acc, curr) => acc.isGreaterThan(curr) ? acc : new BigNumber(curr), new BigNumber(0))
            .toNumber();
        } else {
          farmerStats.averageHarvesterResponseTime = null;
          farmerStats.worstHarvesterResponseTime = null;
        }

        await this.setStatsForService(farmerService, farmerStats);
      });
    }
    if (this.isServiceEnabled(plotterService)) {
      const jobLogs = new Map();
      this.plotterApiClient.onNewPlottingQueueStats(async queue => {
        const plotterStats = this.stats.has(plotterService) ? this.stats.get(plotterService) : {};
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
          await this.setStatsForService(plotterService, plotterStats);
        }
      });
    }

    if (this.isServiceEnabled(walletService)) {
      await this.walletApiClient.init();
    }
    if (this.isServiceEnabled(fullNodeService)) {
      await this.fullNodeApiClient.init();
    }
    if (this.isServiceEnabled(farmerService)) {
      await this.farmerApiClient.init();
    }
    if (this.isServiceEnabled(harvesterService)) {
      await this.harvesterApiClient.init();
    }
    if (this.isServiceEnabled(plotterService)) {
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

  async ensureWalletIsLoggedIn() {
    if (this.walletIsLoggedIn) {
      return;
    }
    await this.walletApiClient.logInAndSkip({ fingerprint: await this.walletApiClient.getPublicKey() });
    this.walletIsLoggedIn = true;
  }

  async updateWalletStats() {
    if (!this.isServiceRunning.get(walletService)) {
      return;
    }
    const walletStats = this.stats.has(walletService) ? this.stats.get(walletService) : {};
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
    walletStats.fingerprint = await this.walletApiClient.getPublicKey();
    await this.setStatsForService(walletService, walletStats);
  }

  async updateFullNodeStats() {
    if (!this.isServiceRunning.get(fullNodeService)) {
      return;
    }
    const fullNodeStats = this.stats.has(fullNodeService) ? this.stats.get(fullNodeService) : {};
    fullNodeStats.blockchainState = this.getRelevantBlockchainState(await this.fullNodeApiClient.getBlockchainState());
    const connections = await this.fullNodeApiClient.getConnections();
    const fullNodeConnections = connections.filter(conn => conn.type === constants.SERVICE_TYPE.fullNode);
    fullNodeStats.fullNodeConnectionsCount = fullNodeConnections.length;
    await this.setStatsForService(fullNodeService, fullNodeStats);
  }

  async updateHarvesterStats() {
    if (!this.isServiceRunning.get(harvesterService)) {
      return;
    }
    const harvesterStats = this.stats.has(harvesterService) ? this.stats.get(harvesterService) : {};
    const { plots } = await this.harvesterApiClient.getPlots();
    harvesterStats.plotCount = plots.length;
    harvesterStats.totalCapacityInGib = plots
      .map(plot => Capacity.fromBytes(plot.file_size))
      .reduce((acc, capacity) => acc.plus(capacity.capacityInGib), new BigNumber(0))
      .toString();
    const connections = await this.harvesterApiClient.getConnections();
    const farmerConnections = connections.filter(conn => conn.type === constants.SERVICE_TYPE.farmer);
    harvesterStats.farmerConnectionsCount = farmerConnections.length;
    await this.setStatsForService(harvesterService, harvesterStats);
  }

  async updateRunningServices() {
    // Ignore the plotter service here as it is only running when plotting
    await Promise.all(this.enabledServices.filter(service => service !== plotterService).map(async service => {
      let isRunning = await this.daemonApiClient.isServiceRunning(constants.SERVICE[service]);
      if (isRunning && service === walletService && !this.walletIsLoggedIn) {
        const publicKeys = await this.walletApiClient.getPublicKeys();
        if (publicKeys.length === 0) {
          isRunning = false;
        } else {
          await this.ensureWalletIsLoggedIn();
        }
      }

      this.isServiceRunning.set(service, isRunning);
      if (!isRunning && this.stats.has(service)) {
        await this.deleteStatsForService(service);
      }
    }));
  }

  isServiceEnabled(service) {
    return this.enabledServices.some(curr => curr === service);
  }

  async closeDaemonConnection() {
    await this.connection.close();
  }

  sortFarmingInfos(farmingInfos) {
    farmingInfos.sort((a, b) => {
      if (moment(a.receivedAt).isAfter(b.receivedAt)) {
        return -1;
      }
      if (moment(a.receivedAt).isBefore(b.receivedAt)) {
        return 1;
      }

      return 0;
    });
  }
}

module.exports = new StatsCollection();
