let getEnv = require('./getEnv')
let isHttp2 = getEnv('GH_CDN_HTTP2') == 'true'
let request = isHttp2 ? require('./request').http2 : require('./request').http
let Bottleneck = require('bottleneck');
let bottleneck = (args) => new Bottleneck(args)

let cdnURL = getEnv('GH_CDN')
let cdnConcurrency = getEnv('GH_CDN_CONCURRENCY')

let githubCDNProxyUrl = (path) => `${cdnURL}/${path}`

async function githubCDNRequest(path, params = {}) {
  params.url = githubCDNProxyUrl(path)
  return await request(params)
}  

module.exports = bottleneck({ maxConcurrent: cdnConcurrency }).wrap(githubCDNRequest)