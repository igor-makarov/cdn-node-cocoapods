let request = require('./request').http

module.exports = function (token, cdnURL) {
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