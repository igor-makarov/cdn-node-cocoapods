let got = require('got')

module.exports = {}
module.exports.http = got.extend({
  throwHttpErrors: false
})
