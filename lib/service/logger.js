const moment = require('moment');

class Logger {
  log({level, msg}) {
    const logLine = `${moment().format('YYYY-MM-DD HH:mm:ss.SSS')} [${level.toUpperCase()}] | ${msg}`;
    if (level === 'error') {
      console.error(logLine);
    } else {
      console.log(logLine);
    }
  }
}

module.exports = new Logger();
