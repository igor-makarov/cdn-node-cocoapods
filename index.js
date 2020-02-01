const requestExt = require('request-extensible')
const RequestHttpCache = require('request-http-cache')
const express = require('express')
const pify = require('pify')
const proxy = require('http-proxy-middleware')
const compression = require('compression')

const token = process.env['GH_TOKEN']
const port = process.env['PORT']
if (!token) {
  throw new Error('No $GH_TOKEN provided')
}

if (!port) {
  throw new Error('No $PORT provided')
}

const httpRequestCache = new RequestHttpCache({
  max: 300 * 1024 * 1024
});

const requestFunc = requestExt({
  extensions: [
    function (options, callback, next) {
      /* Add a user-agent header */
      if (!options.headers) options.headers = {};
      options.headers['user-agent'] = 'request-extensible-demo/1.0';
      options.headers['authorization'] = `token ${token}`;

      return next(options, callback);
    },
    httpRequestCache.extension
  ]
})
const request = pify(requestFunc, { multiArgs: true })

const ghUrlPrefix = 'https://api.github.com/repos/CocoaPods/Specs'

const app = express()
app.use(compression({threshold: 0 }))

Array.prototype.grouped = function() {
  return this.reduce(function(groups, item) {
    const val = item.name
    groups[val] = groups[val] || []
    groups[val].push(item.version)
    return groups
  }, {})
}

const shardUrlRegex = /\/all_pods_versions_(.)_(.)_(.)\.txt/
app.get(shardUrlRegex, async (req, res) => {
  let shardList = shardUrlRegex.exec(req.url).slice(1)
  let prefix = shardList.slice(0, -1)
  let suffix = shardList.pop()
  let shardSHAUrl = `${ghUrlPrefix}/contents/Specs/${prefix.join('/')}`
  let [, bodySHA] = await request({ url: shardSHAUrl })

  let shardSHA = JSON.parse(bodySHA).find(s => s.name === suffix)
  // console.log(shardSHA)
  let shardUrl = `${ghUrlPrefix}/git/trees/${shardSHA.sha}?recursive=true`

  let ghIndexRequest = { url: shardUrl }
  if (req.headers['if-none-match']) {
    // console.log(req.headers['if-none-match'])
    ghIndexRequest.headers = {
      'if-none-match': req.headers['if-none-match']
    }
  }
  let [response, body] = await request(ghIndexRequest)

  // console.log(response.headers)
  if (response.statusCode == 304 || response.headers['etag'] == req.headers['if-none-match']) {
    res.sendStatus(304)
    return
  }
  console.log(Object.entries(response.headers).filter(([k, v]) => k.startsWith('x-ratelimit')))
  const pods = JSON.parse(body).tree
    .map(entry => entry.path.split('/'))
    .filter(p => p.length == 2)
    .map(([n, v]) => { return { name: n, version: v} })

  let versions = Object.entries(pods.grouped()).map(([k,v]) => [k, ...v].join('/'))

  res.setHeader('Cache-Control', 'public,max-age=60,s-max-age=60')
  res.setHeader('ETag', response.headers['etag'])
  res.send(versions.join('\n'))
})

const ghProxy = proxy({ target: 'https://raw.githubusercontent.com/CocoaPods/Specs/master/', 
                        changeOrigin: true,
                        onProxyRes: (proxyRes, req, res) => {
                          proxyRes.headers['Cache-Control'] = 'public,max-age=14400,s-max-age=14400'
                        }
                      })

app.use('/CocoaPods-version.yml', ghProxy)
app.use('//CocoaPods-version.yml', ghProxy)
app.get(/\/Specs\/.*\.podspec.json/, ghProxy)
app.get('/deprecated_podspecs.txt', (req, res) => res.redirect(301, 'https://cdn.cocoapods.org/deprecated_podspecs.txt'))
app.get('/', (req, res) => res.redirect(301, 'https://blog.cocoapods.org/CocoaPods-1.7.2/'))
app.listen(port, () => console.log(`Example app listening on port ${port}!`))
