let getEnv = require('../util/getEnv')
let express = require('express')
let proxy = require('http-proxy-middleware')
let compression = require('compression')
let responseTime = require('response-time')
let etag = require('etag')
let stats = require('../util/stats')
let potentialDeprecations = require('../endpoints/potentialDeprecations')
let githubRequestProxy = require('../api/githubAPIProxy')(getEnv('GH_TOKEN'))

Array.prototype.grouped = function() {
  return this.reduce(function(groups, item) {
    let val = item.name
    groups[val] = groups[val] || []
    groups[val].push(item.version)
    return groups
  }, {})
}

Array.prototype.flat = function() {
  return this.reduce((acc, val) => acc.concat(val), []);
}

module.exports = function (shards, deprecations) {
  let token = getEnv('GH_TOKEN')
  let port = getEnv('PORT')

  let app = express()
  app.use(responseTime())
  app.use(stats())
  app.use(compression({threshold: 0 }))
  app.set('etag', false)

  let shardUrlRegex = /\/all_pods_versions_(.)_(.)_(.)\.txt/
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

  app.get(`/${token}/potential_deprecations`, potentialDeprecations)

  app.get('/deprecated_podspecs.txt', async (req, res, next) => {
    let deprecationsSorted = [...deprecations].sort()
    let list = deprecationsSorted.join('\n')
    let listEtag = etag(list)
    // console.log(listEtag)
    if (req.headers["if-none-match"] && req.headers["if-none-match"] === listEtag) {
      res.setHeader('x-deprecated-podspecs', deprecationsSorted.length)
      res.setHeader('Cache-Control', 'public,stale-while-revalidate=10,max-age=60,s-max-age=60')
      res.setHeader('ETag', listEtag)
      res.sendStatus(304)
      return
    }
    res.setHeader('x-deprecated-podspecs', deprecationsSorted.length)
    res.setHeader('Cache-Control', 'public,stale-while-revalidate=10,max-age=60,s-max-age=60')
    res.setHeader('ETag', listEtag)
    res.send(list)
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

  app.get(`^/${token}/latest/?*`, githubRequestProxy((path, req) => {
      return path.replace(/^\/.*\/latest/, '/repos/CocoaPods/Specs/contents/Specs')
  }, 60))

  app.get(`^/${token}/tree/:tree_sha`, githubRequestProxy((path, req) => {
    return path.replace(/^\/.*\/tree/, '/repos/CocoaPods/Specs/git/trees') + '?recursive=true'
  }, 7 * 24 * 60 * 60))

  app.get(`^/${token}/search_deprecations`, githubRequestProxy((path, req) => {
    return `/search/code?q=(deprecated+OR+deprecated_in_favor_of)+path:Specs/${req.query.path}+language:json+repo:CocoaPods/Specs&per_page=10000&page=${req.query.page}`
  }, 60, false))

  function proxyTo(url, maxAge = 14400) {
    return proxy({ 
      target: url, 
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
  return app;
}