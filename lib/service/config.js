const { promises: fs, existsSync, mkdirSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');
const YAML = require('js-yaml');
const {UpdateMode} = require('../update-mode')

class Config {
  static defaultFoxyDashboardApiUrl = 'https://chia-dashboard-api.foxypool.io'
  static foxyDashboardApiUrls = [
    Config.defaultFoxyDashboardApiUrl,
    'https://chia-dashboard-api-2.foxypool.io',
    'https://chia-dashboard-api-3.foxypool.io',
  ]

  async init() {
    mkdirSync(this.configDirectory, { recursive: true, mode: 0o770 });
    if (this.configExists) {
      await this.load();
    }
  }

  get apiKey() {
    return this.config.apiKey;
  }

  get chiaConfigDirectory() {
    return this.config.chiaConfigDirectory;
  }

  get chiaDaemonAddress() {
    return this.config.chiaDaemonAddress;
  }

  get excludedServices() {
    return this.config.excludedServices;
  }

  get chiaDashboardCoreUrl() {
    return this.config.chiaDashboardCoreUrl || Config.defaultFoxyDashboardApiUrl;
  }

  get chiaDashboardCoreUrlKeyPairs() {
    if (this.config.chiaDashboardCoreUrlKeyPairs !== undefined && this.config.chiaDashboardCoreUrlKeyPairs.length > 0) {
      return this.config.chiaDashboardCoreUrlKeyPairs
    }
    if (this.chiaDashboardCoreUrl !== Config.defaultFoxyDashboardApiUrl) {
      return [{
        dashboardCoreUrl: this.chiaDashboardCoreUrl,
        apiKey: this.apiKey,
      }]
    }

    return Config.foxyDashboardApiUrls.map(dashboardCoreUrl => ({
      dashboardCoreUrl,
      apiKey: this.apiKey,
    }))
  }

  get responseTimeSampleSize() {
    return this.config.responseTimeSampleSize || 100
  }

  get maximumFarmingInfos() {
    return Math.min(this.config.maximumFarmingInfos || 20, 100)
  }

  get updateMode() {
    if (this.config.updateMode === undefined) {
      return UpdateMode.regular
    }

    return UpdateMode[this.config.updateMode] || UpdateMode.regular
  }

  get configExists() {
    return existsSync(this.configFilePath);
  }

  async load() {
    const yaml = await fs.readFile(this.configFilePath, 'utf8');
    this.config = YAML.load(yaml);
  }

  async save() {
    const yaml = YAML.dump(this.config, {
      lineWidth: 140,
    });
    await fs.writeFile(this.configFilePath, yaml, 'utf8');
  }

  get configFilePath() {
    return join(this.configDirectory, 'config.yaml')
  }

  get configDirectory() {
    return join(homedir(), '.config', 'chia-dashboard-satellite');
  }
}

module.exports = new Config();
