let got = require('got')
let {request} = require('http2-wrapper')

module.exports = {}
module.exports.http = got
module.exports.http2 = got.extend({request})
