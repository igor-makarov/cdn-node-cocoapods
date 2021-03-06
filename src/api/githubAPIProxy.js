let getEnv = require('../util/getEnv')
let proxy = require('http-proxy-middleware')

function printRateLimit(response) {
  let rateLimit = Object.entries(response.headers).filter(([k, v]) => k.startsWith('x-ratelimit'))
  if (rateLimit.length > 0) {
    console.log(rateLimit)
  } else {
    console.log(response.body)
  }
}  

let token = getEnv('GH_TOKEN')
let ghUrlPrefix = 'https://api.github.com'

module.exports = function githubRequestProxy(pathRewrite, maxAge, staleWhileRevalidate = true) {
  return proxy({
    target: ghUrlPrefix,
    pathRewrite: pathRewrite,
    changeOrigin: true,
    onProxyReq: (proxyReq, req, res) => {
      proxyReq.setHeader('user-agent', 'pods-cdn/1.0')
      proxyReq.setHeader('accept', 'application/vnd.github.cloak-preview')
      proxyReq.setHeader('authorization', `token ${token}`)
    },
    onProxyRes: (proxyRes, req, res) => {
      printRateLimit(proxyRes)
      // console.log(`GH API status: ${proxyRes.statusCode}`)
      if (proxyRes.statusCode == 200 || proxyRes.statusCode == 304) {
        proxyRes.headers['Cache-Control'] = `public,${staleWhileRevalidate ? 'stale-while-revalidate=10,' : ''}max-age=${maxAge},s-max-age=${maxAge}`
      } else {
        proxyRes.headers['Cache-Control'] = `no-cache`
      }
    }
  })
}
