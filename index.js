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

let cached = new ETagRequest({
  max: 300 * 1024 * 1024
}, rateLimited);

const request = pify(cached, { multiArgs: true })

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

const shardUrlRegex = /\/all_pods_versions_(.)_(.)_(.)\.txt/
app.get(shardUrlRegex, async (req, res, next) => {
  try {
    let shardList = shardUrlRegex.exec(req.url).slice(1)
    let prefix = shardList.slice(0, -2)
    let infix = shardList[1]
    let suffix = shardList[2]
    // console.log(`prefix: ${prefix}`)
    let shardSHAUrl = `${ghUrlPrefix}/contents/Specs/${prefix.join('/')}`
    let [responseSha, bodySHA] = await request({ url: shardSHAUrl, family: 4 })

    if (responseSha.statusCode != 200 && responseSha.statusCode != 304) {
      printRateLimit(responseSha)
      res.setHeader('Cache-Control', 'no-cache')
      res.sendStatus(403)
      return
    }
    // console.log(bodySHA)
    let shardSHA = JSON.parse(bodySHA).find(s => s.name === infix)
    // console.log(shardSHA)
    let shardUrl = `${ghUrlPrefix}/git/trees/${shardSHA.sha}?recursive=true`

    let [response, body] = await request({ url: shardUrl, family: 4 })

    // console.log(response.headers)
    if ((response.statusCode == 200 || response.statusCode == 304) && (response.headers['etag'] == req.headers['if-none-match'])) {
      res.setHeader('Cache-Control', 'public,max-age=60,s-max-age=60')
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

    res.setHeader('Cache-Control', 'public,max-age=60,s-max-age=60')
    res.setHeader('ETag', response.headers['etag'])
    res.send(versions.join('\n'))
  } catch (error) {
    console.log(error)
    next(error)
  }
})

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
