const { existsSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');

class ChiaConfigDetector {
  chiaConfigExistsForConfigDirectory(configDirectory) {
    return existsSync(this.getChiaConfigFilePath(configDirectory));
  }

  get defaultChiaConfigExists() {
    return this.chiaConfigExistsForConfigDirectory(this.defaultChiaConfigDirectory);
  }

  getChiaConfigFilePath(configDirectory) {
    return join(configDirectory, 'config', 'config.yaml');
  }

  get defaultChiaConfigDirectory() {
    return join(homedir(), '.chia', 'mainnet');
  }
}

module.exports = new ChiaConfigDetector();
