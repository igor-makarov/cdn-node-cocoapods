let proxy = require('http-proxy-middleware')

function printRateLimit(response) {
  let rateLimit = Object.entries(response.headers).filter(([k, v]) => k.startsWith('x-ratelimit'))
  if (rateLimit.length > 0) {
    console.log(rateLimit)
  } else {
    console.log(response.body)
  }
}  

module.exports = function (token) {
  let ghUrlPrefix = 'https://api.github.com'
  return function githubRequestProxy(pathRewrite, maxAge) {
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
          proxyRes.headers['Cache-Control'] = `public,stale-while-revalidate=10,max-age=${maxAge},s-max-age=${maxAge}`
        } else {
          proxyRes.headers['Cache-Control'] = `no-cache`
        }
      }
    })
  }
}