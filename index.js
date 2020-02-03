const requestBase = require('request')
const express = require('express')
const pify = require('pify')
const proxy = require('http-proxy-middleware')
const compression = require('compression')
const stats = require('./stats')
const responseTime = require('response-time')

const token = process.env['GH_TOKEN']
const port = process.env['PORT']
if (!token) {
  throw new Error('No $GH_TOKEN provided')
}

if (!port) {
  throw new Error('No $PORT provided')
}

const request = pify(requestBase, { multiArgs: true })

const app = express()
app.use(responseTime())
app.use(stats())
app.use(compression({threshold: 0 }))
app.set('etag', false)

Array.prototype.grouped = function() {
  return this.reduce(function(groups, item) {
    const val = item.name
    groups[val] = groups[val] || []
    groups[val].push(item.version)
    return groups
  }, {})
}

Array.prototype.flat = function() {
  return this.reduce((acc, val) => acc.concat(val), []);
}

function printRateLimit(response) {
  let rateLimit = Object.entries(response.headers).filter(([k, v]) => k.startsWith('x-ratelimit'))
  if (rateLimit.length > 0) {
    console.log(rateLimit)
  } else {
    console.log(response.body)
  }
}

const shardUrlRegex = /\/all_pods_versions_(.)_(.)_(.)\.txt/
app.get(shardUrlRegex, async (req, res, next) => {
  try {
    let fullHostname = req.protocol + '://' + req.get('host')
    let shardList = shardUrlRegex.exec(req.url).slice(1)
    let prefix = shardList[0]
    let infix = shardList[1]
    let suffix = shardList[2]
    // console.log(`prefix: ${prefix}`)
    let shardSHAUrl = `${fullHostname}/latest/${prefix}`
    let [responseSha, bodySHA] = await request({ url: shardSHAUrl })

    if (responseSha.statusCode != 200 && responseSha.statusCode != 304) {
      printRateLimit(responseSha)
      res.setHeader('Cache-Control', 'no-cache')
      res.sendStatus(403)
      return
    }
    // console.log(bodySHA)
    let shardSHA = JSON.parse(bodySHA).find(s => s.name === infix)
    // console.log(shardSHA)
    let shardUrl = `${fullHostname}/tree/${shardSHA.sha}`

    let shardRequest = { url: shardUrl }
    if (req.headers['if-none-match']) {
      shardRequest.headers = { 'if-none-match': req.headers['if-none-match'] }
    }
    let [response, body] = await request(shardRequest)

    // console.log(response.headers)
    if ((response.statusCode == 200 || response.statusCode == 304) && (response.headers['etag'] == req.headers['if-none-match'])) {
      res.setHeader('Cache-Control', 'public,stale-while-revalidate=10,max-age=60,s-max-age=60')
      res.setHeader('ETag', response.headers['etag'])
      res.sendStatus(304)
      return
    }

    printRateLimit(response)
    if (response.statusCode != 200 && responseSha.statusCode != 304) {
      res.setHeader('Cache-Control', 'no-cache')
      res.sendStatus(403)
      return
    }
    // console.log(body)
    let json = JSON.parse(body)
    console.log(`truncated: ${json.truncated}`)
    let pods = json.tree
      .map(entry => entry.path.split('/'))
      .filter(p => p.length == 3 && p[0] === suffix)
      .map(([s, n, v]) => { return { name: n, version: v } })

    let versions = Object.entries(pods.grouped()).map(([k,v]) => [k, ...v].join('/'))

    res.setHeader('Cache-Control', 'public,stale-while-revalidate=10,max-age=60,s-max-age=60')
    res.setHeader('ETag', response.headers['etag'])
    res.send(versions.join('\n'))
  } catch (error) {
    console.log(error)
    next(error)
  }
})

app.get('/all_pods.txt', async (req, res, next) => {
  try {
    let fullHostname = req.protocol + '://' + req.get('host')
    let shardSHAUrl = `${fullHostname}/latest`
    let shardSHARequest = { url: shardSHAUrl }
    if (req.headers['if-none-match']) {
      shardSHARequest.headers = { 'if-none-match': req.headers['if-none-match'] }
    }
    let [responseSha, bodySHA] = await request(shardSHARequest)

    if (responseSha.statusCode != 200 && responseSha.statusCode != 304) {
      printRateLimit(responseSha)
      res.setHeader('Cache-Control', 'no-cache')
      res.sendStatus(403)
      return
    }

    if ((responseSha.statusCode == 200 || responseSha.statusCode == 304) && (responseSha.headers['etag'] == req.headers['if-none-match'])) {
      res.setHeader('Cache-Control', 'public,stale-while-revalidate=10,max-age=60,s-max-age=60')
      res.setHeader('ETag', responseSha.headers['etag'])
      res.sendStatus(304)
      return
    }
    // console.log(bodySHA)
    let shas = JSON.parse(bodySHA).map(s => s.sha)

    let promises = shas.map(async sha => {
      let shardUrl = `${fullHostname}/tree/${sha}`
      let [response, body] = await request({ url: shardUrl })
      let json = JSON.parse(body)
      console.log(`truncated: ${json.truncated}`)
      let pods = json.tree
        .map(entry => entry.path.split('/'))
        .filter(p => p.length == 3)
        .map(p => p[2])
      return pods
    })

    let podsArrays = await Promise.all(promises)
    let pods = podsArrays.flat().sort()

    res.setHeader('Cache-Control', 'public,stale-while-revalidate=10,max-age=60,s-max-age=60')
    res.setHeader('ETag', responseSha.headers['etag'])
    res.send(pods.join('\n'))
  } catch (error) {
    console.log(error)
    next(error)
  }
})

let ghUrlPrefix = 'https://api.github.com/repos/CocoaPods/Specs'
function githubRequestProxy(pathRewrite, maxAge) {
  return proxy({
    target: ghUrlPrefix,
    pathRewrite: pathRewrite,
    changeOrigin: true,
    onProxyReq: (proxyReq, req, res) => {
      proxyReq.setHeader('user-agent', 'pods-cdn/1.0')
      proxyReq.setHeader('authorization', `token ${token}`)
    },
    onProxyRes: (proxyRes, req, res) => {
      printRateLimit(proxyRes)
      proxyRes.headers['Cache-Control'] = `public,stale-while-revalidate=10,max-age=${maxAge},s-max-age=${maxAge}`
    }
  })
}

app.get('/latest/?*', githubRequestProxy({
  '^/latest': '/contents/Specs'
}, 60))

app.get('/tree/:tree_sha', githubRequestProxy((path, req) => {
  return path.replace('/tree', '/git/trees/') + '?recursive=true'
}, 7 * 24 * 60 * 60))

function proxyTo(url, maxAge = 14400) {
  return proxy({ target: url, 
                        changeOrigin: true,
                        onProxyRes: (proxyRes, req, res) => {
                          proxyRes.headers['Cache-Control'] = `public,stale-while-revalidate=10,max-age=${maxAge},s-max-age=${maxAge}`
                        }
                      })
}

let ghProxy = proxyTo('https://raw.githubusercontent.com/CocoaPods/Specs/master/')
let netlifyProxy = (maxAge) => proxyTo('https://cdn.cocoapods.org/', maxAge)
app.get('/CocoaPods-version.yml', ghProxy)
app.get('//CocoaPods-version.yml', ghProxy)
// app.get('/all_pods.txt', netlifyProxy(10 * 60))
app.get('/deprecated_podspecs.txt', netlifyProxy(60 * 60))
app.get('/', (req, res) => res.redirect(301, 'https://blog.cocoapods.org/CocoaPods-1.7.2/'))
app.listen(port, () => console.log(`Example app listening on port ${port}!`))
