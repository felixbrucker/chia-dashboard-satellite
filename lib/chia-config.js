const { promises: fs } = require('fs');
const YAML = require('js-yaml');
const { join } = require('path');

class ChiaConfig {
  constructor(configDirectory) {
    this.configDirectory = configDirectory;
  }

  async getDaemonSslCertFile() {
    const filePath = join(this.configDirectory, this.config.daemon_ssl.private_crt);

    return fs.readFile(filePath, 'utf8');
  }

  async getDaemonSslKeyFile() {
    const filePath = join(this.configDirectory, this.config.daemon_ssl.private_key);

    return fs.readFile(filePath, 'utf8');
  }

  get daemonAddress() {
    return `${this.config.self_hostname}:${this.config.daemon_port}`;
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
    return join(this.configDirectory, 'config', 'config.yaml');
  }
}

module.exports = ChiaConfig;
