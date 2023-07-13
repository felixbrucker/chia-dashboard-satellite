const { Connection, ApiClient, constants } = require('chia-api');
const BigNumber = require('bignumber.js');
const { throttle, mergeWith, isArray} = require('lodash');
const moment = require('moment');

const config = require('./config');
const logger = require('./logger');
const chiaDashboardUpdater = require('./chia-dashboard-updater');
const ChiaConfig = require('../chia-config');
const Capacity = require('../capacity');
const ChiaAmount = require('../chia-amount');
const { updateStartedAtOfJob, getProgressOfJob, getEffectivePlotSizeInBytes } = require('../util');
const {getUpdateInterval} = require('../update-mode')
const WalletType = require('../wallet-type')

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
    allServices.forEach(service => {
      this.stats.set(service, {});
      this.isServiceRunning.set(service, false);
    });
    this.enabledServices = allServices;
    this.partialStats[plotterService] = null;
    this.walletIsLoggedIn = false;
    this.farmingInfos = [];
  }

  async init() {
    this.updateStatsThrottled = throttle(async partialStats => {
      this.partialStats = {};
      await chiaDashboardUpdater.updateStats(partialStats);
    }, getUpdateInterval(config.updateMode) * 1000, { leading: true, trailing: true });
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
    this.connection.addService(constants.SERVICE().walletUi);
    this.connection.addService(`${this.connection.coin} plots create`); // Add the legacy plotter service to receive its events as well
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
        const newBlockchainState = this.getRelevantBlockchainState(blockchainState)
        let partialFullNodeStats = undefined
        if (fullNodeStats.blockchainState !== undefined) {
          const blockchainPartialStats = this.getBlockchainStatePartialStats(fullNodeStats.blockchainState, newBlockchainState)
          if (blockchainPartialStats !== undefined) {
            partialFullNodeStats = { blockchainState: blockchainPartialStats }
          }
        } else {
          partialFullNodeStats = { blockchainState: newBlockchainState }
        }
        fullNodeStats.blockchainState = newBlockchainState
        await this.setStatsForService(fullNodeService, fullNodeStats, partialFullNodeStats)
      });
      this.fullNodeApiClient.onConnectionChange(async connections => {
        const fullNodeStats = this.stats.has(fullNodeService) ? this.stats.get(fullNodeService) : {};
        const fullNodeConnections = connections.filter(conn => conn.type === constants.SERVICE_TYPE.fullNode);
        let partialFullNodeStats = undefined
        if (fullNodeStats.fullNodeConnectionsCount !== fullNodeConnections.length) {
          partialFullNodeStats = { fullNodeConnectionsCount: fullNodeConnections.length }
        }
        fullNodeStats.fullNodeConnectionsCount = fullNodeConnections.length;
        await this.setStatsForService(fullNodeService, fullNodeStats, partialFullNodeStats)
      });
    }
    if (this.isServiceEnabled(farmerService)) {
      this.farmerApiClient.onNewSignagePoint(async (newSignagePoint) => {
        const farmerStats = this.stats.has(farmerService) ? this.stats.get(farmerService) : {};
        const relevantSignagePointData = this.getRelevantSignagePointData(newSignagePoint);
        let matchingFarmingInfo = this.farmingInfos.find(farmingInfo =>
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
        matchingFarmingInfo.lastUpdated = new Date();

        if (isNewlyCreated) {
          this.farmingInfos.unshift(matchingFarmingInfo);
        }
        this.sortFarmingInfos(this.farmingInfos);

        farmerStats.farmingInfos = this.getFarmingInfosForApi();

        this.setStatsForServiceWithoutUpdate(farmerService, farmerStats, { farmingInfos: farmerStats.farmingInfos })
      });

      let harvesterResponseTimes = [];
      this.farmerApiClient.onNewFarmingInfo(async (newFarmingInfo) => {
        const farmerStats = this.stats.has(farmerService) ? this.stats.get(farmerService) : {};
        const relevantFarmingInfo = this.getRelevantFarmingInfoData(newFarmingInfo);
        let matchingFarmingInfo = this.farmingInfos.find(farmingInfo =>
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
            lastUpdated: new Date(),
          };
          this.farmingInfos.unshift(matchingFarmingInfo);
        }
        matchingFarmingInfo.proofs += relevantFarmingInfo.proofs;
        matchingFarmingInfo.passedFilter += relevantFarmingInfo.passedFilter;
        matchingFarmingInfo.lastUpdated = new Date();

        this.farmingInfos = this.farmingInfos.slice(0, config.maximumFarmingInfos)
        this.sortFarmingInfos(this.farmingInfos);

        if (!isNewlyCreated) {
          harvesterResponseTimes.unshift(moment().diff(matchingFarmingInfo.receivedAt, 'milliseconds'));
        }
        harvesterResponseTimes = harvesterResponseTimes.slice(0, config.responseTimeSampleSize)
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
        farmerStats.farmingInfos = this.getFarmingInfosForApi();

        await this.setStatsForService(farmerService, farmerStats, farmerStats);
      });
    }
    if (this.isServiceEnabled(plotterService)) {
      const jobLogs = new Map();
      this.plotterApiClient.onNewPlottingQueueStats(async queue => {
        if (!queue) {
          return;
        }
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
          await this.setStatsForService(plotterService, plotterStats, plotterStats);
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
    setInterval(async () => {
      try {
        await this.updateStats()
      } catch (err) {
        logger.log({ level: 'error', msg: `Stats Collection | ${err}`});
      }
    }, 20 * 1000);
    setInterval(async () => {
      try {
        await this.updateRunningServices()
      } catch (err) {
        logger.log({ level: 'error', msg: `Stats Collection | ${err}`});
      }
    }, 60 * 1000);
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
    await Promise.all([
      this.updateWalletStats(),
      this.updateHarvesterStats(),
    ])
  }

  async setStatsForService(service, stats, partialStats) {
    if (partialStats === undefined) {
      partialStats = { dummyToUpdateDate: true }
    }
    this.setStatsForServiceWithoutUpdate(service, stats, partialStats);
    this.updateStatsThrottled(this.partialStats)
  }

  setStatsForServiceWithoutUpdate(service, stats, partialStats) {
    this.stats.set(service, stats);
    if (config.enableCompatibilityMode) {
      this.partialStats[service] = stats
    } else {
      this.partialStats[service] = mergeWith(
        (this.partialStats[service] || {}),
        partialStats,
        (objValue, srcValue) => {
          if (isArray(objValue)) {
            return srcValue
          }
        }
      )
    }
  }

  async deleteStatsForService(service) {
    this.stats.delete(service);
    this.partialStats[service] = null;
    this.updateStatsThrottled(this.partialStats);
  }

  getFarmingInfosForApi() {
    return this.farmingInfos.map(farmingInfo => ({
      proofs: farmingInfo.proofs,
      passedFilter: farmingInfo.passedFilter,
      receivedAt: farmingInfo.receivedAt,
      lastUpdated: farmingInfo.lastUpdated,
    }));
  }

  getRelevantFarmingInfoData(farmingInfo) {
    return {
      challenge: farmingInfo.challenge_hash,
      signagePoint: farmingInfo.signage_point,
      proofs: farmingInfo.proofs,
      passedFilter: farmingInfo.passed_filter,
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
    };
  }

  getBlockchainStatePartialStats(blockchainState, newBlockchainState) {
    const partialStats = {}
    if (blockchainState.difficulty !== newBlockchainState.difficulty) {
      partialStats.difficulty = newBlockchainState.difficulty
    }
    if (blockchainState.spaceInGib !== newBlockchainState.spaceInGib) {
      partialStats.spaceInGib = newBlockchainState.spaceInGib
    }
    if (blockchainState.syncStatus.synced !== newBlockchainState.syncStatus.synced) {
      if (partialStats.syncStatus === undefined) {
        partialStats.syncStatus = {}
      }
      partialStats.syncStatus.synced = newBlockchainState.syncStatus.synced
    }
    if (blockchainState.syncStatus.syncing !== newBlockchainState.syncStatus.syncing) {
      if (partialStats.syncStatus === undefined) {
        partialStats.syncStatus = {}
      }
      partialStats.syncStatus.syncing = newBlockchainState.syncStatus.syncing
    }
    if (blockchainState.syncStatus.syncedHeight !== newBlockchainState.syncStatus.syncedHeight) {
      if (partialStats.syncStatus === undefined) {
        partialStats.syncStatus = {}
      }
      partialStats.syncStatus.syncedHeight = newBlockchainState.syncStatus.syncedHeight
    }
    if (blockchainState.syncStatus.tipHeight !== newBlockchainState.syncStatus.tipHeight) {
      if (partialStats.syncStatus === undefined) {
        partialStats.syncStatus = {}
      }
      partialStats.syncStatus.tipHeight = newBlockchainState.syncStatus.tipHeight
    }

    return Object.keys(partialStats).length === 0 ? undefined : partialStats
  }

  async ensureWalletIsLoggedIn() {
    if (this.walletIsLoggedIn) {
      return;
    }
    const loggedInFingerPrint = await this.walletApiClient.getLoggedInFingerprint()
    if (loggedInFingerPrint !== null) {
      this.walletIsLoggedIn = true

      return
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
    const relevantWallets = wallets.filter(wallet => {
      switch (wallet.type) {
        case WalletType.standard:
        case WalletType.atomicSwap:
        case WalletType.authorizedPayee:
        case WalletType.multiSig:
        case WalletType.custody:
        case WalletType.cat:
        case WalletType.recoverable:
          return true
        default: return false
      }
    })
    let walletPartialStats = undefined
    const newWallets = await Promise.all(relevantWallets.map(async wallet => {
      const balance = await this.walletApiClient.getBalance({ walletId: wallet.id })
      const decimalPlaces = wallet.type === WalletType.cat ? ChiaAmount.decimalPlacesCat : ChiaAmount.decimalPlaces

      return {
        id: wallet.id,
        name: wallet.name,
        type: wallet.type,
        balance: {
          unconfirmed: ChiaAmount.fromRaw(balance.unconfirmed_wallet_balance, decimalPlaces).toString(),
        },
      }
    }))
    if (walletStats.wallets === undefined || this.doWalletsDiffer(walletStats.wallets, newWallets)) {
      walletPartialStats = { wallets: newWallets }
    }
    walletStats.wallets = newWallets
    const syncStatus = await this.walletApiClient.getWalletSyncStatus();
    const syncedHeight = await this.walletApiClient.getWalletSyncedHeight();
    const newSyncStatus = {
      synced: syncStatus.synced,
      syncing: syncStatus.syncing,
      syncedHeight,
    }
    if (walletStats.syncStatus === undefined) {
      if (walletPartialStats === undefined) {
        walletPartialStats = {}
      }
      walletPartialStats.syncStatus = newSyncStatus
    } else {
      if (walletStats.syncStatus.synced !== newSyncStatus.synced) {
        if (walletPartialStats === undefined) {
          walletPartialStats = {}
        }
        if (walletPartialStats.syncStatus === undefined) {
          walletPartialStats.syncStatus = {}
        }
        walletPartialStats.syncStatus.synced = newSyncStatus.synced
      }
      if (walletStats.syncStatus.syncing !== newSyncStatus.syncing) {
        if (walletPartialStats === undefined) {
          walletPartialStats = {}
        }
        if (walletPartialStats.syncStatus === undefined) {
          walletPartialStats.syncStatus = {}
        }
        walletPartialStats.syncStatus.syncing = newSyncStatus.syncing
      }
      if (walletStats.syncStatus.syncedHeight !== newSyncStatus.syncedHeight) {
        if (walletPartialStats === undefined) {
          walletPartialStats = {}
        }
        if (walletPartialStats.syncStatus === undefined) {
          walletPartialStats.syncStatus = {}
        }
        walletPartialStats.syncStatus.syncedHeight = newSyncStatus.syncedHeight
      }
    }
    walletStats.syncStatus = newSyncStatus
    const farmedAmountResponse = await this.walletApiClient.getFarmedAmount();
    const farmedAmount = {
      lastHeightFarmed: farmedAmountResponse.last_height_farmed,
    }
    if (walletStats.farmedAmount === undefined || walletStats.farmedAmount.lastHeightFarmed !== farmedAmount.lastHeightFarmed) {
      if (walletPartialStats === undefined) {
        walletPartialStats = {}
      }
      walletPartialStats.farmedAmount = farmedAmount
    }
    walletStats.farmedAmount = farmedAmount
    const fingerprint = await this.walletApiClient.getPublicKey()
    if (walletStats.fingerprint !== fingerprint) {
      if (walletPartialStats === undefined) {
        walletPartialStats = {}
      }
      walletPartialStats.fingerprint = fingerprint
    }
    walletStats.fingerprint = fingerprint
    await this.setStatsForService(walletService, walletStats, walletPartialStats)
  }

  async updateFullNodeStats() {
    if (!this.isServiceRunning.get(fullNodeService)) {
      return;
    }
    const fullNodeStats = this.stats.has(fullNodeService) ? this.stats.get(fullNodeService) : {};
    const newBlockchainState = this.getRelevantBlockchainState(await this.fullNodeApiClient.getBlockchainState())
    let partialFullNodeStats = undefined
    if (fullNodeStats.blockchainState !== undefined) {
      const blockchainPartialStats = this.getBlockchainStatePartialStats(fullNodeStats.blockchainState, newBlockchainState)
      if (blockchainPartialStats !== undefined) {
        partialFullNodeStats = { blockchainState: blockchainPartialStats }
      }
    } else {
      partialFullNodeStats = { blockchainState: newBlockchainState }
    }
    fullNodeStats.blockchainState = newBlockchainState
    const connections = await this.fullNodeApiClient.getConnections();
    const fullNodeConnections = connections.filter(conn => conn.type === constants.SERVICE_TYPE.fullNode);
    if (fullNodeStats.fullNodeConnectionsCount !== fullNodeConnections.length) {
      if (partialFullNodeStats === undefined) {
        partialFullNodeStats = {}
      }
      partialFullNodeStats.fullNodeConnectionsCount = fullNodeConnections.length
    }
    fullNodeStats.fullNodeConnectionsCount = fullNodeConnections.length
    await this.setStatsForService(fullNodeService, fullNodeStats, partialFullNodeStats)
  }

  async updateHarvesterStats() {
    if (!this.isServiceRunning.get(harvesterService)) {
      return
    }
    const harvesterStats = this.stats.has(harvesterService) ? this.stats.get(harvesterService) : {}
    const { plots } = await this.harvesterApiClient.getPlots()
    const ogPlots = plots.filter(plot => plot.pool_public_key !== null)
    const totalRawOgPlotCapacity = ogPlots
      .map(plot => Capacity.fromBytes(plot.file_size))
      .reduce((acc, capacity) => acc.plus(capacity.capacityInGib), new BigNumber(0))
      .toString()
    const totalEffectiveOgPlotCapacity = ogPlots
      .map(plot => Capacity.fromBytes(getEffectivePlotSizeInBytes(plot.size)))
      .reduce((acc, capacity) => acc.plus(capacity.capacityInGib), new BigNumber(0))
      .toString()
    const ogPlotStats = {
      count: ogPlots.length,
      rawCapacityInGib: totalRawOgPlotCapacity,
      effectiveCapacityInGib: totalEffectiveOgPlotCapacity,
    }
    if (config.enableCompatibilityMode) {
      ogPlotStats.capacityInGib = ogPlotStats.effectiveCapacityInGib
    }
    let harvesterPartialStats = undefined
    if (
      !harvesterStats.ogPlots
      || harvesterStats.ogPlots.count !== ogPlotStats.count
      || harvesterStats.ogPlots.rawCapacityInGib !== ogPlotStats.rawCapacityInGib
      || harvesterStats.ogPlots.effectiveCapacityInGib !== ogPlotStats.effectiveCapacityInGib
    ) {
      if (harvesterStats.ogPlots === undefined) {
        harvesterPartialStats = { ogPlots: ogPlotStats }
      } else {
        const partialStats = this.makeHarvesterPlotsPartialStats(harvesterStats.ogPlots, ogPlotStats)
        if (partialStats !== undefined) {
          harvesterPartialStats = { ogPlots: partialStats }
        }
      }
      harvesterStats.ogPlots = ogPlotStats
    }
    const nftPlots = plots.filter(plot => plot.pool_contract_puzzle_hash !== null);
    const totalRawNftPlotCapacity = nftPlots
      .map(plot => Capacity.fromBytes(plot.file_size))
      .reduce((acc, capacity) => acc.plus(capacity.capacityInGib), new BigNumber(0))
      .toString()
    const totalEffectiveNftPlotCapacity = nftPlots
      .map(plot => Capacity.fromBytes(getEffectivePlotSizeInBytes(plot.size)))
      .reduce((acc, capacity) => acc.plus(capacity.capacityInGib), new BigNumber(0))
      .toString()
    const nftPlotStats = {
      count: nftPlots.length,
      rawCapacityInGib: totalRawNftPlotCapacity,
      effectiveCapacityInGib: totalEffectiveNftPlotCapacity,
    }
    if (config.enableCompatibilityMode) {
      nftPlotStats.capacityInGib = nftPlotStats.effectiveCapacityInGib
    }
    if (
      !harvesterStats.nftPlots
      || harvesterStats.nftPlots.count !== nftPlotStats.count
      || harvesterStats.nftPlots.rawCapacityInGib !== nftPlotStats.rawCapacityInGib
      || harvesterStats.nftPlots.effectiveCapacityInGib !== nftPlotStats.effectiveCapacityInGib
    ) {
      if (harvesterStats.nftPlots === undefined) {
        if (harvesterPartialStats === undefined) {
          harvesterPartialStats = {}
        }
        harvesterPartialStats.nftPlots = nftPlotStats
      } else {
        const partialStats = this.makeHarvesterPlotsPartialStats(harvesterStats.nftPlots, nftPlotStats)
        if (partialStats !== undefined) {
          if (harvesterPartialStats === undefined) {
            harvesterPartialStats = {}
          }
          harvesterPartialStats.nftPlots = partialStats
        }
      }
      harvesterStats.nftPlots = nftPlotStats
    }
    const totalPlotCount = ogPlotStats.count + nftPlotStats.count
    const totalRawPlotCapacityInGib = (new BigNumber(ogPlotStats.rawCapacityInGib)).plus(nftPlotStats.rawCapacityInGib).toString()
    const totalEffectivePlotCapacityInGib = (new BigNumber(ogPlotStats.effectiveCapacityInGib)).plus(nftPlotStats.effectiveCapacityInGib).toString()
    if (harvesterStats.plotCount !== totalPlotCount) {
      harvesterStats.plotCount = totalPlotCount
      if (harvesterPartialStats === undefined) {
        harvesterPartialStats = {}
      }
      harvesterPartialStats.plotCount = harvesterStats.plotCount
    }
    if (harvesterStats.totalRawPlotCapacityInGib !== totalRawPlotCapacityInGib) {
      harvesterStats.totalRawPlotCapacityInGib = totalRawPlotCapacityInGib
      if (harvesterPartialStats === undefined) {
        harvesterPartialStats = {}
      }
      harvesterPartialStats.totalRawPlotCapacityInGib = harvesterStats.totalRawPlotCapacityInGib
    }
    if (harvesterStats.totalEffectivePlotCapacityInGib !== totalEffectivePlotCapacityInGib) {
      harvesterStats.totalEffectivePlotCapacityInGib = totalEffectivePlotCapacityInGib
      if (config.enableCompatibilityMode) {
        harvesterStats.totalCapacityInGib = harvesterStats.totalEffectivePlotCapacityInGib
      }
      if (harvesterPartialStats === undefined) {
        harvesterPartialStats = {}
      }
      harvesterPartialStats.totalEffectivePlotCapacityInGib = harvesterStats.totalEffectivePlotCapacityInGib
    }
    const connections = await this.harvesterApiClient.getConnections()
    const farmerConnections = connections.filter(conn => conn.type === constants.SERVICE_TYPE.farmer)
    if (harvesterStats.farmerConnectionsCount !== farmerConnections.length) {
      harvesterStats.farmerConnectionsCount = farmerConnections.length
      if (harvesterPartialStats === undefined) {
        harvesterPartialStats = {}
      }
      harvesterPartialStats.farmerConnectionsCount = harvesterStats.farmerConnectionsCount
    }
    await this.setStatsForService(harvesterService, harvesterStats, harvesterPartialStats)
  }

  async updateRunningServices() {
    // Ignore the plotter service here as it is only running when plotting
    await Promise.all(this.enabledServices.filter(service => service !== plotterService).map(async service => {
      let isRunning = await this.daemonApiClient.isServiceRunning(constants.SERVICE()[service]);
      if (isRunning && service === walletService && !this.walletIsLoggedIn) {
        const publicKeys = await this.walletApiClient.getPublicKeys();
        // public keys are not available if the keyring is locked
        if (publicKeys === undefined || publicKeys.length === 0) {
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

  doWalletsDiffer(wallets, newWallets) {
    if (wallets.length !== newWallets.length) {
      return true
    }
    for (const [index, newWallet] of newWallets.entries()) {
      const wallet = wallets[index]
      if (
        wallet.id !== newWallet.id
        || wallet.name !== newWallet.name
        || wallet.type !== newWallet.type
        || wallet.balance.unconfirmed !== newWallet.balance.unconfirmed
      ) {
        return true
      }
    }

    return false
  }

  makeHarvesterPlotsPartialStats(plots, newPlots) {
    let partialStats = {}
    if (plots.count !== newPlots.count) {
      partialStats.count = newPlots.count
    }
    if (plots.rawCapacityInGib !== newPlots.rawCapacityInGib) {
      partialStats.rawCapacityInGib = newPlots.rawCapacityInGib
    }
    if (plots.effectiveCapacityInGib !== newPlots.effectiveCapacityInGib) {
      partialStats.effectiveCapacityInGib = newPlots.effectiveCapacityInGib
    }

    return Object.keys(partialStats).length === 0 ? undefined : partialStats
  }
}

module.exports = new StatsCollection();
