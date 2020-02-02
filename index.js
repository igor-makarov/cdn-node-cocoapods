const requestExt = require('request-extensible')
const ETagRequest = require('request-etag');
const express = require('express')
const pify = require('pify')
const proxy = require('http-proxy-middleware')
const compression = require('compression')
const Bottleneck = require('bottleneck');

const token = process.env['GH_TOKEN']
const port = process.env['PORT']
if (!token) {
  throw new Error('No $GH_TOKEN provided')
}

if (!port) {
  throw new Error('No $PORT provided')
}

let withAddedHeaders = requestExt({
  extensions: [
    function (options, callback, next) {
      /* Add a user-agent header */
      if (!options.headers) options.headers = {};
      options.headers['user-agent'] = 'request-extensible-demo/1.0';
      options.headers['authorization'] = `token ${token}`;

      return next(options, callback);
    }
  ]
})

let bottleneck = (args) => new Bottleneck(args)

let rateLimited = bottleneck({ maxConcurrent: 1 }).wrap(withAddedHeaders)

const request = pify(rateLimited, { multiArgs: true })

const ghUrlPrefix = 'https://api.github.com/repos/CocoaPods/Specs'

const app = express()
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

function printRateLimit(response) {
  let rateLimit = Object.entries(response.headers).filter(([k, v]) => k.startsWith('x-ratelimit'))
  if (rateLimit.length > 0) {
    console.log(rateLimit)
  } else {
    console.log(response.body)
  }
}

let githubGetPrefixSHA = function() {
  var shards = null
  var shardsEtag = null
  return async prefix => {
    let requestSHA = { url: `${ghUrlPrefix}/contents/Specs`, family: 4 }
    if (shardsEtag) {
      requestSHA.headers = { 'if-none-match': shardsEtag }
    }
    let [response, body] = await request(requestSHA)
    printRateLimit(response)
    if (response.statusCode == 200) {
      shards = JSON.parse(body)
      shardsEtag = response.headers['etag']
      console.log('shards modified')
    } else if (response.statusCode == 304) {
      // nothing
      console.log('shards not modified')
    } else {
      throw new Error(response)
    }
    return shards.find(s => s.name === prefix).sha
  }
}()

let githubGetShard = function() {
  var shards = {}
  var shardsEtags = {}
  return async shard => {
    let prefix = shard[0]
    let sha = await githubGetPrefixSHA(prefix)
    let requestShard = { url: `${ghUrlPrefix}/git/trees/${sha}?recursive=true`, family: 4 }
    if (shardsEtags[shard]) {
      requestShard.headers = { 'if-none-match': shardsEtags[shard] }
    }
    let [response, body] = await request(requestShard)
    printRateLimit(response)
    if (response.statusCode == 200) {
      shards[shard] = JSON.parse(body)
      shardsEtags[shard] = response.headers['etag']
      console.log('shard modified')
    } else if (response.statusCode == 304) {
      // nothing
      console.log('shard not modified')
    } else {
      throw new Error(response)
    }
    return [shards[shard], shardsEtags[shard]]
  }
}()

const shardUrlRegex = /\/all_pods_versions_(.)_(.)_(.)\.txt/
app.get(shardUrlRegex, async (req, res, next) => {
  try {
    let shard = shardUrlRegex.exec(req.url).slice(1)
    let infix = shard[1]
    let suffix = shard[2]
    // console.log(`prefix: ${prefix}`)
    let ifNoneMatch = req.headers ? req.headers['if-none-match'] : null
    let [json, etag] = await githubGetShard(shard)
    console.log(`truncated: ${json.truncated}`)

    console.log(`ifnm: ${ifNoneMatch} etag: ${etag}`)
    if (ifNoneMatch === etag) {
      res.setHeader('Cache-Control', 'public,max-age=60,s-max-age=60')
      res.setHeader('ETag', etag)
      res.sendStatus(304)
      return
    }

    let pods = json.tree
      .map(entry => entry.path.split('/'))
      .filter(p => p.length == 4 && p[0] === infix && p[1] === suffix)
      .map(([i, s, n, v]) => { return { name: n, version: v } })

    let versions = Object.entries(pods.grouped()).map(([k,v]) => [k, ...v].join('/'))

    res.setHeader('Cache-Control', 'public,max-age=60,s-max-age=60')
    res.setHeader('ETag', etag)
    res.send(versions.join('\n'))
  } catch (error) {
    console.log(error)
    next(error)
  }
})

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
      proxyRes.headers['Cache-Control'] = `public,max-age=${maxAge},s-max-age=${maxAge}`
    }
  })
}

app.get('/latest', githubRequestProxy({
  '^/latest': '/contents/Specs'
}, 60))

app.get('/tree/:tree_sha', githubRequestProxy((path, req) => {
  return path.replace('/tree', '/git/trees/') + '?recursive=true'
}, 7 * 24 * 60 * 60))

function proxyTo(url, maxAge = 14400) {
  return proxy({ target: url, 
                        changeOrigin: true,
                        onProxyRes: (proxyRes, req, res) => {
                          proxyRes.headers['Cache-Control'] = `public,max-age=${maxAge},s-max-age=${maxAge}`
                        }
                      })
}

let ghProxy = proxyTo('https://raw.githubusercontent.com/CocoaPods/Specs/master/')
let netlifyProxy = (maxAge) => proxyTo('https://cdn.cocoapods.org/', maxAge)
app.get('/CocoaPods-version.yml', ghProxy)
app.get('//CocoaPods-version.yml', ghProxy)
app.get('/all_pods.txt', netlifyProxy(10 * 60))
app.get('/deprecated_podspecs.txt', netlifyProxy(60 * 60))
app.get('/', (req, res) => res.redirect(301, 'https://blog.cocoapods.org/CocoaPods-1.7.2/'))
app.listen(port, () => console.log(`Example app listening on port ${port}!`))
