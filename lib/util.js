const moment = require('moment');

const plottingTimestampRegex = /([0-9]+-[0-9]+-[0-9]+T[0-9]+:[0-9]+:[0-9]+\.[0-9]+)/

const util = {
  extractFirstLineOfLog: (logString) => {
    const firstLineBreak = logString.indexOf('\n');

    return logString.slice(0, firstLineBreak !== -1 ? firstLineBreak : undefined);
  },
  updateStartedAtOfJob: ({ existingJob, job}) => {
    if (job.state !== 'RUNNING') {
      return;
    }
    if (existingJob.state || !job.log) {
      existingJob.startedAt = new Date();
    } else if (!existingJob.startedAt && job.log) {
      const firstLogLine = util.extractFirstLineOfLog(job.log);
      const matches = firstLogLine.match(plottingTimestampRegex);
      if (matches) {
        existingJob.startedAt = moment(matches[1]).toDate();
      }
    }
  }
};

module.exports = util;
