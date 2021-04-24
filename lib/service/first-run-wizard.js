const prompts = require('prompts');
const { validate } = require('uuid');

const config = require('./config');
const chiaConfigDetector = require('./chia-config-detector');

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
    let chiaConfigDirectory = chiaConfigDetector.chiaConfigDirectory;
    if (!chiaConfigDetector.chiaConfigExists) {
      const { chiaConfigDirectoryFromPrompt } = await prompts([{
        type: 'text',
        name: 'chiaConfigDirectoryFromPrompt',
        message: `Please enter the path to your chia config directory`,
        initial: chiaConfigDirectory,
        validate: (input) => chiaConfigDetector.chiaConfigExistsForConfigDirectory(input) ? true : 'Not a valid chia config directory!',
      }]);
      if (!chiaConfigDirectoryFromPrompt) {
        process.exit(0);
      }
      chiaConfigDirectory = chiaConfigDirectoryFromPrompt;
    }

    config.config = {
      chiaConfigDirectory,
      apiKey,
    };
    await config.save();
  }
}

module.exports = new FirstRunWizard();
