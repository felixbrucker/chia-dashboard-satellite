const prompts = require('prompts');
const { validate } = require('uuid');

const config = require('./config');
const chiaConfigDetector = require('./chia-config-detector');
const ChiaDashboardClient = require('../chia-dashboard-client');

class FirstRunWizard {
  async run() {
    const { apiKey } = await prompts([{
      type: 'text',
      name: 'apiKey',
      message: `Please enter the api key for this satellite`,
      validate: (input) => validate(input) ? true : 'Not a valid api key!',
    }]);
    if (!apiKey) {
      process.exit(0);
    }
    const { dashboardCoreUrl, dashboardCoreUrlManual } = await prompts([{
      type: 'select',
      name: 'dashboardCoreUrl',
      message: `Please select the dashboard url you want to use`,
      choices: [
        { title: 'https://eu.chiadashboard.com', value: 'https://eu.chiadashboard.com' },
        { title: 'https://us.chiadashboard.com', value: 'https://us.chiadashboard.com' },
        { title: 'https://chia-dashboard-api.foxypool.io', value: 'https://chia-dashboard-api.foxypool.io' },
        { title: 'Enter an url manually', value: 'manual' },
      ],
      initial: 0,
    }, {
      type: prev => prev === 'manual' ? 'text' : null,
      name: 'dashboardCoreUrlManual',
      message: `Please enter the dashboard url you want to use`,
      validate: async (input) => {
        const client = new ChiaDashboardClient({ dashboardCoreUrl: input, timeout: 10 * 1000 });
        try {
          await client.ping();
          return true;
        } catch (err) {
          return 'Please enter a valid dashboard url';
        }
      },
    }]);
    const chiaDashboardCoreUrl = dashboardCoreUrl !== 'manual' ? dashboardCoreUrl : dashboardCoreUrlManual;
    if (!chiaDashboardCoreUrl) {
      process.exit(0);
    }
    let chiaConfigDirectory = chiaConfigDetector.defaultChiaConfigDirectory;
    if (!chiaConfigDetector.defaultChiaConfigExists) {
      const { chiaConfigDirectoryFromPrompt } = await prompts([{
        type: 'text',
        name: 'chiaConfigDirectoryFromPrompt',
        message: `Please enter the path to your chia config directory`,
        initial: chiaConfigDirectory,
        validate: (input) => chiaConfigDetector.chiaConfigExistsForConfigDirectory(input.trim()) ? true : 'Not a valid chia config directory!',
      }]);
      if (!chiaConfigDirectoryFromPrompt) {
        process.exit(0);
      }
      chiaConfigDirectory = chiaConfigDirectoryFromPrompt.trim();
    }

    config.config = {
      chiaConfigDirectory,
      chiaDashboardCoreUrl,
      apiKey,
    };
    await config.save();
  }
}

module.exports = new FirstRunWizard();
