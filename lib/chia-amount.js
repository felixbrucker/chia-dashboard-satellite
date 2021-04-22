const BigNumber = require('bignumber.js');

class ChiaAmount {
  static get decimalPlaces() {
    return 12;
  }

  static fromRaw(amount) {
    return new ChiaAmount(new BigNumber(amount).shiftedBy(-ChiaAmount.decimalPlaces));
  }

  constructor(amount) {
    this.amountBN = new BigNumber(amount);
  }

  toString() {
    return this.amountBN.toString();
  }
}

module.exports = ChiaAmount;
