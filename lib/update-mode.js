const UpdateMode = {
  slow: 'slow',
  regular: 'regular',
  fast: 'fast',
}
const getUpdateInterval = (updateMode) => {
  switch (updateMode) {
    case UpdateMode.slow: return 90
    case UpdateMode.regular: return 60
    case UpdateMode.fast: return 30
  }
}

module.exports = { UpdateMode, getUpdateInterval }
