let getEnv = require('../util/getEnv')
let request = require('../util/request').http
let token = getEnv('GH_TOKEN')

module.exports = function (cdnURL) {
  if (!cdnURL) {
    throw new Error('No CDN URL provided')
  }
  let githubProxyUrl = (path) => `${cdnURL}/${token}/${path}`  
  return async function (path, params = {}) {
    params.url = githubProxyUrl(path)
    // console.log(params.url)
    return await request(params)
  }
}