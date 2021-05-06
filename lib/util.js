const moment = require('moment');

const plottingTimestampRegex = /([0-9]+-[0-9]+-[0-9]+T[0-9]+:[0-9]+:[0-9]+\.[0-9]+)/
const FINISHED_LOG_LINES_128_BUCKETS = 2626;

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
  },
  getProgressOfJob: ({ job, log }) => {
    if (job.state === 'SUBMITTED') {
      return 0;
    }
    if (job.state === 'FINISHED') {
      return 1;
    }
    if (!log) {
      return 0;
    }
    // Get rid of this shit asap
    const lines = log.trim().split(/\r\n|\r|\n/).length;

    return lines > FINISHED_LOG_LINES_128_BUCKETS ? 1 : lines / FINISHED_LOG_LINES_128_BUCKETS;
  }
};

module.exports = util;
