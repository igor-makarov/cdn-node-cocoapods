const requestExt = require('request-extensible')
const RequestHttpCache = require('request-http-cache')
const express = require('express')
const pify = require('pify');

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

const request = pify(requestExt({
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
}), { multiArgs: true })

const ghUrlPrefix = 'https://api.github.com/repos/CocoaPods/Specs/contents'

async function getPodNames(shard) {
  const ghUrl = `${ghUrlPrefix}/Specs/${shard.join('/')}`
}

const app = express()
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

app.get('/CocoaPods-version.yml', redir)
app.get(/\/Specs\/.*\.podspec.json/, redir)
app.get('/deprecated_podspecs.txt', (req, res) => res.redirect(301, 'https://cdn.cocoapods.org/deprecated_podspecs.txt'))
app.listen(port, () => console.log(`Example app listening on port ${port}!`))


// // Now use request as you would request/request
// request({
//     url: 'https://api.github.com/users/suprememoocow'
// }, function (err, response, body) {

// });