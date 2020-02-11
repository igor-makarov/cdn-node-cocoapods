require('dotenv').config()

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

const express = require('express')
const proxy = require('http-proxy-middleware')
const compression = require('compression')
const stats = require('./stats')
const octopage = require('./octopage')
const responseTime = require('response-time')
const etag = require('etag')
const Bottleneck = require('bottleneck');
const githubAPIRequest = require('./tokenProtectedRequestToSelf')(token, process.env.GITHUB_API_SELF_CDN_URL)
const otherSelfCDNRequest = require('./tokenProtectedRequestToSelf')(token, process.env.SELF_CDN_URL)
const githubCDNRequest = require('./githubCDNRequest')
const boot = require('./boot')(token)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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

var shards = {}

const shardUrlRegex = /\/all_pods_versions_(.)_(.)_(.)\.txt/
app.get(shardUrlRegex, async (req, res, next) => {
  try {
    let shardList = shardUrlRegex.exec(req.url).slice(1)
    let prefix = shardList[0]
    // console.log(`prefix: ${prefix}`)
    let shard = shards[prefix]

    if (!shard) {
      res.setHeader('Cache-Control', 'no-cache')
      res.sendStatus(404)
      return
    }

    let etag = `"${shard.sha}"`
    if (req.headers['if-none-match'] && req.headers['if-none-match'] === etag) {
      res.setHeader('Cache-Control', 'public,stale-while-revalidate=10,max-age=60,s-max-age=60')
      res.setHeader('ETag', etag)
      res.sendStatus(304)
      return
    }

    // console.log(shard)
    let shardPath = shardList.join('/')
    let filtered = shard.podspecs
      .filter(pod => pod.startsWith(shardPath))
      .map(pod => pod.split('/'))
      .map(([,,, n, v]) => { return { name: n, version: v } })
    let versions = Object.entries(filtered.grouped()).map(([k,v]) => [k, ...v].join('/'))
    // console.log(`Parsed ${shardList}`)

    res.setHeader('Cache-Control', 'public,stale-while-revalidate=10,max-age=60,s-max-age=60')
    res.setHeader('ETag', etag)
    res.send(versions.join('\n'))
  } catch (error) {
    console.log(error)
    next(error)
  }
})

app.get(`/${token}/deprecations/:tree_sha/:prefix/:count`, async (req, res, next) => {
  let prefix = req.params.prefix
  let treeSHA = req.params.tree_sha

  if (!shards[prefix] || !shards[prefix].deprecations || shards[prefix].sha !== treeSHA) {
    res.setHeader('Cache-Control', 'no-cache')
    res.sendStatus(404)
    return
  }

  let maxAge = 7 * 24 * 60 * 60
  let resultList = shards[prefix].deprecations.sort()
  res.setHeader('Cache-Control', `public,stale-while-revalidate=10,max-age=${maxAge},s-max-age=${maxAge}`)
  res.send(resultList.join('\n'))
})

async function getDeprecationSearch(prefix, page) {
  let response = await githubAPIRequest(`search_deprecations?path=${prefix}&page=${page}`) 
  if (response.statusCode != 200) {
    console.log(response.headers)
    return []
  }
  let json = JSON.parse(response.body)
  let paging = response.headers.link ? octopage(response.headers.link) : {}
  paging.current = page
  return [paging, json]
}

app.get(`/${token}/potential_deprecations`, async (req, res, next) => {
  let prefix = req.query.path

  var podspecList = new Set()
  var paging = { next: 1 }
  var searchResult = null
  var etag = null
  do {
    [paging, searchResult] = await getDeprecationSearch(prefix, paging.next)
    if (!paging) {
      res.setHeader('Cache-Control', 'no-cache')
      res.sendStatus(404)
      return
    }
  
    etag = `"${searchResult.total_count}"`
    console.log(`prefix: ${prefix} total: ${searchResult.total_count} page: ${paging.current}, items: ${searchResult.items.length}`)
    if (req.headers['if-none-match'] && req.headers['if-none-match'] == etag && paging.next >= 1) {
      res.setHeader('Cache-Control', 'public,max-age=60,s-max-age=60')
      res.setHeader('ETag', etag)
      res.sendStatus(304)
      return
    }
    for (item of searchResult.items) {
      podspecList.add(item.path)
      // console.log(item.path)
    }
    // await wait(1000)
  } while (paging.next);

  let resultList = [...podspecList].sort()
  res.setHeader('Cache-Control', 'public,max-age=60,s-max-age=60')
  res.setHeader('ETag', etag)
  res.send(resultList.join('\n'))
})

var oldDeprecationShards = {}
function allDeprecatedPodspecs() {
  return Object.values(shards).map(s => {
    let newDeprecations = s.deprecations || []
    let oldDeprecations = oldDeprecationShards[s.prefix] || []
    if (newDeprecations.length > oldDeprecations.length) {
      // console.log(`shard: ${s.prefix} old: ${oldDeprecations} new: ${newDeprecations}, returning new`)
      oldDeprecationShards[s.prefix] = newDeprecations
      return newDeprecations
    } else {
      // console.log(`shard: ${s.prefix} old: ${oldDeprecations} new: ${newDeprecations}, returning old`)
      return oldDeprecations
    }
  }).flat().sort()
}

app.get('/deprecated_podspecs.txt', async (req, res, next) => {
  let list = allDeprecatedPodspecs().join('\n')
  let deprecationShardCount = Object.values(shards).filter(s => !!s.deprecations).length
  let listEtag = etag(list)
  // console.log(listEtag)
  if (req.headers["if-none-match"] && req.headers["if-none-match"] === listEtag) {
    res.setHeader('Cache-Control', 'public,stale-while-revalidate=10,max-age=60,s-max-age=60')
    res.setHeader('ETag', listEtag)
    res.setHeader('X-Deprecation-Shards', deprecationShardCount)
    res.sendStatus(304)
    return
  }
  res.setHeader('Cache-Control', 'public,stale-while-revalidate=10,max-age=60,s-max-age=60')
  res.setHeader('ETag', listEtag)
  res.setHeader('X-Deprecation-Shards', deprecationShardCount)
  res.send(list)
})

app.get('/deprecation_shard_count', async (req, res, next) => {
  res.send(Object.values(shards).filter(s => !!s.deprecations).length + '')
})

app.get('/all_pods.txt', async (req, res, next) => {
  try {
    let allEtag = `"${Object.values(shards).map(s => s.sha).join('-')}"`
    if (req.headers['if-none-match'] && req.headers['if-none-match'] === allEtag) {
      res.setHeader('Cache-Control', 'public,stale-while-revalidate=10,max-age=60,s-max-age=60')
      res.setHeader('ETag', allEtag)
      res.sendStatus(304)
      return
    }

    let pods = Object.values(shards).map(s => s.pods).flat().sort()
    res.setHeader('Cache-Control', 'public,stale-while-revalidate=10,max-age=60,s-max-age=60')
    res.setHeader('ETag', allEtag)
    res.send(pods.join('\n'))
  } catch (error) {
    console.log(error)
    next(error)
  }
})

app.get(`^/${token}/keep_alive`, async (req, res, next) => {
  // console.log('keep-alive received!')
  res.setHeader('Cache-Control', 'no-cache')
  res.send('keep-alive')
})

const githubRequestProxy = require('./githubAPIProxy')(token)
app.get(`^/${token}/latest/?*`, githubRequestProxy((path, req) => {
    return path.replace(/^\/.*\/latest/, '/repos/CocoaPods/Specs/contents/Specs')
}, 60))

app.get(`^/${token}/tree/:tree_sha`, githubRequestProxy((path, req) => {
  return path.replace(/^\/.*\/tree/, '/repos/CocoaPods/Specs/git/trees') + '?recursive=true'
}, 7 * 24 * 60 * 60))

app.get(`^/${token}/search_deprecations`, githubRequestProxy((path, req) => {
  return `/search/code?q=(deprecated+OR+deprecated_in_favor_of)+path:Specs/${req.query.path}+language:json+repo:CocoaPods/Specs&per_page=10000&page=${req.query.page}`
}, 60))

app.get(`^/${token}/commit/:commit_sha`, githubRequestProxy((path, req) => {
  return `/repos/CocoaPods/Specs/commits/${req.params.commit_sha}`
}, 7 * 24 * 60 * 60))

function proxyTo(url, maxAge = 14400) {
  return proxy({ target: url, 
                        changeOrigin: true,
                        onProxyRes: (proxyRes, req, res) => {
                          proxyRes.headers['Cache-Control'] = `public,stale-while-revalidate=10,max-age=${maxAge},s-max-age=${maxAge}`
                        }
                      })
}

let ghOriginUrl = 'https://raw.githubusercontent.com/CocoaPods/Specs/master/'
app.get('/CocoaPods-version.yml', proxyTo(ghOriginUrl, 60 * 60))
app.get('//CocoaPods-version.yml', proxyTo(ghOriginUrl, 60 * 60))
app.get('/Specs/?*', proxyTo(ghOriginUrl, 1 * 60))
app.get('/', (req, res) => res.redirect(301, 'https://blog.cocoapods.org/CocoaPods-1.7.2/'))
app.listen(port, () => console.log(`Example app listening on port ${port}!`))

async function finalBoot () {
  setInterval(() => {
    otherSelfCDNRequest('keep_alive')
  }, 30 * 1000)


  try {
    let minWaitTime = 10 * 1000
    while (true) {
      let startTime = new Date()
      await boot(shards)
      let elapsed = (new Date()) - startTime
      if (elapsed < minWaitTime) {
        let waitTime = minWaitTime - elapsed
        // console.log(`Waiting ${waitTime/1000}s`)
        await wait(waitTime)
      }
    }
  } catch (error) {
    console.log(error)
  }
}

finalBoot()