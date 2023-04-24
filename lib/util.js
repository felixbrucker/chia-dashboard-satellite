const moment = require('moment');
const BigNumber = require('bignumber.js')

const plottingTimestampRegex = /([0-9]+-[0-9]+-[0-9]+T[0-9]+:[0-9]+:[0-9]+\.[0-9]+)/
const FINISHED_LOG_LINES_128_BUCKETS = 2626
const K32_ACTUAL_SPACE_CONSTANT_FACTOR = new BigNumber('0.7797')
const K_SIZE_ACTUAL_SPACE_CONSTANT_FACTOR_DECREMENT = new BigNumber('0.0004489')
const getActualSpaceConstantFactor = (kSize) => K32_ACTUAL_SPACE_CONSTANT_FACTOR.minus(K_SIZE_ACTUAL_SPACE_CONSTANT_FACTOR_DECREMENT.multipliedBy(kSize - 32))

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
  },
  getEffectivePlotSizeInBytes: (kSize) => {
    return (new BigNumber(kSize))
      .multipliedBy(2)
      .plus(1)
      .multipliedBy((new BigNumber(2)).exponentiatedBy(kSize - 1))
      .multipliedBy(getActualSpaceConstantFactor(kSize))
  },
}

module.exports = util
