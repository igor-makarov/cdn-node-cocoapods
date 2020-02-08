let pify = require('pify')
let requestBase = require('request')
let request = pify(requestBase, { multiArgs: true })

module.exports = function (cdnURL) {
  if (!cdnURL) {
    throw new Error('No CDN URL provided')
  }
  let githubCDNProxyUrl = (path) => `${cdnURL}/${path}`
  return function (path, params = {}) {
    params.url = githubCDNProxyUrl(path)
    return request(params)
  }
}