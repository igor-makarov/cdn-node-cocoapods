let got = require('got')
let {request} = require('http2-wrapper')

module.exports = {}
module.exports.http = got
module.exports.http2 = got.extend({
  retry: {
    errorCodes: [
      'ERR_HTTP2_STREAM_ERROR',
      'ETIMEDOUT',
      'ECONNRESET',
      'EADDRINUSE',
      'ECONNREFUSED',
      'EPIPE',
      'ENOTFOUND',
      'ENETUNREACH',
      'EAI_AGAIN'
    ]
  }
}, {request})
