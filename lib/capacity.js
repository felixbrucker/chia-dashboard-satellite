const BigNumber = require('bignumber.js');

class Capacity {
  static fromBytes(capacityInBytes) {
    return new Capacity(new BigNumber(capacityInBytes).dividedBy(new BigNumber(1024).pow(3)));
  }

  constructor(capacityInGib) {
    this.capacityInGib = new BigNumber(capacityInGib);
  }

  toMib() {
    return this.capacityInGib.multipliedBy(1024);
  }

  toString(precision = 2) {
    let capacity = this.capacityInGib;
    let unit = 0;
    const units = ['GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
    while (capacity.isGreaterThanOrEqualTo(1024)) {
      capacity = capacity.dividedBy(1024);
      unit += 1;
    }

    return `${capacity.toFixed(precision)} ${units[unit]}`;
  }
}

module.exports = Capacity;
