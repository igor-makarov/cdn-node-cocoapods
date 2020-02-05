require('dotenv').config()
const requestBase = require('request')
const express = require('express')
const pify = require('pify')
const proxy = require('http-proxy-middleware')
const compression = require('compression')
const stats = require('./stats')
const responseTime = require('response-time')
const etag = require('etag')
const Bottleneck = require('bottleneck');

if (process.env.PRETTY_LOG) {
  require('log-timestamp')
}

const token = process.env.GH_TOKEN
const port = process.env.PORT
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

function selfProxyUrlPrefix(req, path) {
  let host = req.get('host')
  let protocol = host === 'localhost:3000' ? 'http' : 'https'
  let newPath = `${protocol}://${host}`
  // console.log(`new path: ${newPath}`)
  return newPath
}

function githubProxyUrl(req, path) {
  return `${selfProxyUrlPrefix(req)}/${token}/${path}`
}

function githubCDNProxyUrl(req, path) {
  let result = `${process.env.GH_CDN || selfProxyUrlPrefix(req)}/${path}`
  // console.log(result)
  return result
}

var deprecatedPodspecs = {}
function allDeprecatedPodspecs() {
  return Object.values(deprecatedPodspecs).map(l => [...l]).flat().sort()
}

let bottleneck = (args) => new Bottleneck(args)

async function parseDeprecationsImpl(req, shardList, shardSHA) {
  try {
    let deprecationUrl = githubProxyUrl(req, `deprecations/${shardSHA}/${shardList.join('/')}`)
    let [response, deprecated] = await request({ url: deprecationUrl })
    if (response.statusCode != 200) {
      console.log(`Deprecations returned error: ${shardList} ${response.statusCode} `)
      deprecatedPodspecs[shardList] = null
      return
    }
    deprecatedPodspecs[shardList] = deprecated.split('\n').filter(s => s !== '')
    // console.log(`Current deprecations: ${allDeprecatedPodspecs()}`)
  } catch (error) {
    console.log(`Deprecation poll error: ${shardList} ${error}`)
  }
  console.log(`Parsed Deprecations: ${shardList}`)
}

let parseDeprecations = bottleneck({ maxConcurrent: 5 }).wrap(parseDeprecationsImpl)

async function parsePods(req, shardTwo, shardSHA, ifNoneMatch = null) {
  // console.log(shardSHA)
  let shardUrl = githubProxyUrl(req, `tree/${shardSHA}`)
  let shardRequest = { url: shardUrl }
  if (ifNoneMatch) {
    shardRequest.headers = { 'if-none-match': ifNoneMatch }
  }
  let [response, body] = await request(shardRequest)

  if (response.statusCode == 304) {
    return [response, []]
  }

  try {
    console.log(`Received body ${shardTwo}`)
    let json = JSON.parse(body)
    console.log(`truncated: ${json.truncated}`)
    let pods = json.tree
      .map(entry => entry.path.split('/'))
      .filter(p => p.length == 3)
      .map(([s, n, v]) => { return { name: n, suffix: s, version: v } })
    return [response, pods]
  } catch (error) {
    console.log(`Body: ${body} headers: ${Object.entries(response.headers)}`)
    throw error
  }
}

const shardUrlRegex = /\/all_pods_versions_(.)_(.)_(.)\.txt/
app.get(shardUrlRegex, async (req, res, next) => {
  try {
    let shardList = shardUrlRegex.exec(req.url).slice(1)
    let shardTwo = shardList.slice(0, 2)
    let prefix = shardList[0]
    let infix = shardList[1]
    let suffix = shardList[2]
    // console.log(`prefix: ${prefix}`)
    let shardSHAUrl = githubProxyUrl(req, `latest/${prefix}`)
    let [responseSha, bodySHA] = await request({ url: shardSHAUrl })

    if (responseSha.statusCode != 200 && responseSha.statusCode != 304) {
      // printRateLimit(responseSha)
      console.log(`error from latest: ${responseSha.statusCode}`)
      res.setHeader('Cache-Control', 'no-cache')
      res.sendStatus(403)
      return
    }
    // console.log(bodySHA)
    let shardSHA = JSON.parse(bodySHA).find(s => s.name === infix).sha

    let [response, pods] = await parsePods(req, shardTwo, shardSHA, req.headers['if-none-match'])

    // console.log(response.headers)
    if ((response.statusCode == 200 || response.statusCode == 304) && (response.headers['etag'] == req.headers['if-none-match'])) {
      res.setHeader('Cache-Control', 'public,stale-while-revalidate=10,max-age=60,s-max-age=60')
      res.setHeader('ETag', response.headers['etag'])
      res.sendStatus(304)
      if (!deprecatedPodspecs[shardList]) {
        deprecatedPodspecs[shardList] = deprecatedPodspecs[shardList] || new Set()
        // setTimeout(() => {
        //   parseDeprecations(req, shardList, shardSHA)
        // }, 10000)
      }
      return
    }

    // printRateLimit(response)
    if (response.statusCode != 200 && response.statusCode != 304) {
      console.log(`error from latest: ${response.statusCode}`)
      res.setHeader('Cache-Control', 'no-cache')
      res.sendStatus(403)
      return
    }
    // console.log(body)

    let filtered = pods.filter(pod => pod.suffix === suffix)
    let versions = Object.entries(filtered.grouped()).map(([k,v]) => [k, ...v].join('/'))
    console.log(`Parsed ${shardList}`)

    res.setHeader('Cache-Control', 'public,stale-while-revalidate=10,max-age=60,s-max-age=60')
    res.setHeader('ETag', response.headers['etag'])
    res.send(versions.join('\n'))
    deprecatedPodspecs[shardList] = deprecatedPodspecs[shardList] || new Set()
    // setTimeout(() => {
    //   parseDeprecations(req, shardList, shardSHA)
    // }, 10000)
  } catch (error) {
    console.log(error)
    next(error)
  }
})

let githubCDNProxyRequest = bottleneck({ maxConcurrent: 50 }).wrap(request)
app.get(`/${token}/deprecations/:tree_sha/:prefix/:infix/:suffix`, async (req, res, next) => {
  let maxAge = 7 * 24 * 60 * 60
  let shardSHA = req.params.tree_sha
  let shardTwo = [req.params.prefix, req.params.infix]
  let suffix = req.params.suffix
  console.log(`${[...shardTwo, suffix]} shardSha: ${shardSHA}`)
  let [response, pods] = await parsePods(req, shardTwo, shardSHA, req.headers['if-none-match'])
  if (response.statusCode == 304) {
    res.setHeader('Cache-Control', `public,stale-while-revalidate=10,max-age=${maxAge},s-max-age=${maxAge}`)
    res.setHeader('ETag', response.headers.etag)
    res.sendStatus(304)
    return  
  }
  let result = new Set()
  let deprecations = pods.filter(pod => pod.suffix === suffix).map(async pod => {
    try {
      let encodedPodName = encodeURIComponent(pod.name)
      let path = ['Specs', ...shardTwo, pod.suffix, encodedPodName, pod.version, `${encodedPodName}.podspec.json`].join('/')
      let [podResponse, body] = await githubCDNProxyRequest({ url: githubCDNProxyUrl(req, path) })
      // console.log(`Body: ${body}`)
      // let json = JSON.parse(body)
      if (body.includes('"deprecated": true')) {
        // console.log(`Deprecated: ${path}`)
        result.add(path)
      }
    } catch (error) {
      console.log(error)
    }
  })
  await Promise.all(deprecations)
  let resultList = [...result]
  console.log(`${[...shardTwo, suffix]} Deprecated: ${resultList.length}`)
  res.setHeader('Cache-Control', `public,stale-while-revalidate=10,max-age=${maxAge},s-max-age=${maxAge}`)
  res.setHeader('ETag', response.headers.etag)
  res.send(resultList.join('\n'))
})

app.get('/deprecated_podspecs.txt', async (req, res, next) => {
  // console.log(allDeprecatedPodspecs())
  let list = allDeprecatedPodspecs().join('\n')
  let listEtag = etag(list)
  console.log(listEtag)
  if (req.headers["if-none-match"] && req.headers["if-none-match"] === listEtag) {
    res.setHeader('Cache-Control', 'public,stale-while-revalidate=10,max-age=60,s-max-age=60')
    res.setHeader('ETag', listEtag)
    res.sendStatus(304)
    return
  }
  res.setHeader('Cache-Control', 'public,stale-while-revalidate=10,max-age=60,s-max-age=60')
  res.setHeader('ETag', listEtag)
  res.send(list)
})

app.get('/all_pods.txt', async (req, res, next) => {
  try {
    let shardSHAUrl = githubProxyUrl(req, 'latest')
    let shardSHARequest = { url: shardSHAUrl }
    if (req.headers['if-none-match']) {
      shardSHARequest.headers = { 'if-none-match': req.headers['if-none-match'] }
    }
    let [responseSha, bodySHA] = await request(shardSHARequest)

    if (responseSha.statusCode != 200 && responseSha.statusCode != 304) {
      console.log(`error from latest: ${responseSha.statusCode}`)
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
      let shardUrl = githubProxyUrl(req, `tree/${sha}`)
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
      // console.log(`GH API status: ${proxyRes.statusCode}`)
      proxyRes.headers['Cache-Control'] = `public,stale-while-revalidate=10,max-age=${maxAge},s-max-age=${maxAge}`
    }
  })
}

app.get(`^/${token}/latest/?*`, githubRequestProxy((path, req) => {
    return path.replace(/^\/.*\/latest/, '/contents/Specs')
}, 60))

app.get(`^/${token}/tree/:tree_sha`, githubRequestProxy((path, req) => {
  return path.replace(/^\/.*\/tree/, '/git/trees') + '?recursive=true'
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
// app.get('/deprecated_podspecs.txt', netlifyProxy(60 * 60))
app.get('/', (req, res) => res.redirect(301, 'https://blog.cocoapods.org/CocoaPods-1.7.2/'))
app.listen(port, () => console.log(`Example app listening on port ${port}!`))
