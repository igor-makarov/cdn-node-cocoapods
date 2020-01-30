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
  max: 4 * 1024 * 1024
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

const ghUrlPrefix = 'https://api.github.com/repos/CocoaPods/Specs/contents'

async function getPodNames(shard) {
  const ghUrl = `${ghUrlPrefix}/Specs/${shard.join('/')}`
}

const app = express()
app.use(compression({threshold: 0 }))

const shardUrlRegex = /\/all_pods_versions_(.)_(.)_(.)\.txt/
app.get(shardUrlRegex, async (req, res) => {
  let shard = shardUrlRegex.exec(req.url).slice(1)
  let shardUrl = `${ghUrlPrefix}/Specs/${shard.join('/')}`
  let ghIndexRequest = { url: shardUrl }
  if (req.headers['if-none-match']) {
    ghIndexRequest.headers = {
      'if-none-match': req.headers['if-none-match']
    }
  }
  let [response, body] = await request(ghIndexRequest)

  if (response.statusCode == 304) {
    res.sendStatus(304)
    return
  }
  console.log(response.headers)
  const pods = JSON.parse(body).map(entry => entry.name)

  let promises = pods.map( async (pod) => {
    let podUrl = `${ghUrlPrefix}/Specs/${shard.join('/')}/${pod}`
    let [, body] = await request({ url: podUrl })
    let parsed = JSON.parse(body).map(entry => entry.name)
    return [pod, ...parsed].join('/')
  })

  let versions = await Promise.all(promises)
  res.setHeader('etag', response.headers['etag'])
  res.send(versions.join('\n'))
})

function redir(req, res) {
  res.redirect(301, `https://raw.githubusercontent.com/CocoaPods/Specs/master/${req.url}`)
}

const ghProxy = proxy({ target: 'https://raw.githubusercontent.com/CocoaPods/Specs/master/', changeOrigin: true })

app.use('/CocoaPods-version.yml', ghProxy)
app.use('//CocoaPods-version.yml', ghProxy)
app.get(/\/Specs\/.*\.podspec.json/, redir)
app.get('/deprecated_podspecs.txt', (req, res) => res.redirect(301, 'https://cdn.cocoapods.org/deprecated_podspecs.txt'))
app.get('/', (req, res) => res.redirect(301, 'https://blog.cocoapods.org/CocoaPods-1.7.2/'))
app.listen(port, () => console.log(`Example app listening on port ${port}!`))
