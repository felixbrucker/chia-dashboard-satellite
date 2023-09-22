String.prototype.ensureHexPrefix = function() {
  return this.startsWith('0x') ? this : `0x${this}`
}

String.prototype.stripHexPrefix = function() {
  return this.startsWith('0x') ? this.slice(2) : this
}
