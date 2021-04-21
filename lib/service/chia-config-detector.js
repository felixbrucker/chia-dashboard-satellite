const { existsSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');

class ChiaConfigDetector {
  chiaConfigExistsForConfigDirectory(configDirectory) {
    return existsSync(configDirectory);
  }

  get chiaConfigExists() {
    return this.chiaConfigExistsForConfigDirectory(this.chiaConfigFilePath);
  }

  get chiaConfigFilePath() {
    return join(this.chiaConfigDirectory, 'config', 'config.yaml');
  }

  get chiaConfigDirectory() {
    return join(homedir(), '.chia', 'mainnet');
  }
}

module.exports = new ChiaConfigDetector();
