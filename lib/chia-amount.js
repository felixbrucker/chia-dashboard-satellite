const BigNumber = require('bignumber.js');

class ChiaAmount {
  static get decimalPlaces() {
    return 12;
  }

  static get decimalPlacesCat() {
    return 3;
  }

  static fromRaw(amount, decimalPlaces = ChiaAmount.decimalPlaces) {
    return new ChiaAmount(new BigNumber(amount).shiftedBy(-decimalPlaces));
  }

  constructor(amount) {
    this.amountBN = new BigNumber(amount);
  }

  toString() {
    return this.amountBN.toString();
  }
}

module.exports = ChiaAmount;
