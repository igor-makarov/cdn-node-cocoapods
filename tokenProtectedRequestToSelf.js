let pify = require('pify')
let requestBase = require('request')
let request = pify(requestBase, { multiArgs: true })

module.exports = function (token, cdnURL) {
  if (!cdnURL) {
    throw new Error('No CDN URL provided')
  }
  let githubProxyUrl = (path) => `${cdnURL}/${token}/${path}`  
  return function (path, params = {}) {
    params.url = githubProxyUrl(path)
    return request(params)
  }
}