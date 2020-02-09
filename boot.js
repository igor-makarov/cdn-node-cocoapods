let githubCDNProxyRequest = require('./githubCDNRequest')
let Bottleneck = require('bottleneck');
let bottleneck = (args) => new Bottleneck(args)

let deprecationRegex = /\s\"deprecated(|_in_favor_of)\":/
function isDeprecated(body) {
   if (deprecationRegex.test(body)) {
     let json = JSON.parse(body)
     return json.deprecated || json.deprecated_in_favor_of
   } else {
     return false
   }
}

module.exports = function (token) {
  let githubAPIRequest = require('./tokenProtectedRequestToSelf')(token, process.env.GITHUB_API_SELF_CDN_URL)
  let otherSelfCDNRequest = require('./tokenProtectedRequestToSelf')(token, process.env.SELF_CDN_URL)

  async function getLatest() {
    let response = await githubAPIRequest('latest')
    let parsed = JSON.parse(response.body)
    return parsed
  }
  
  async function getTree(prefix, sha) {
    let response = await githubAPIRequest(`tree/${sha}`) 
    let json = JSON.parse(response.body)

    let result = {}
    result.sha = json.sha
    result.truncated = json.truncated
    let pods = new Set()
    result.podspecs = []
    for (entry of json.tree) {
      let pathComponents = entry.path.split('/')
      if (pathComponents.length == 3) {
        pods.add(pathComponents[2])
      } else if (pathComponents.length == 5) {
        result.podspecs.push([prefix, ...pathComponents].join('/'))
      }
    }
    result.pods = [...pods]
    return result
  }

  async function getDeprecations(prefix, shard) {
    let sha = shard.sha

    let podspecs = shard.podspecs
    // let podspecs = shard.podspecs.slice(0, 1000)

    let cached = await otherSelfCDNRequest(`deprecations/${sha}/${prefix}/${podspecs.length}`)
    if (cached.statusCode == 200) {
      console.log(`prefix: ${prefix}, sha: ${sha} - returning cached deprecations`)
      shard.deprecations = cached.body.split('\n')
      return
    } 

    console.log(`prefix: ${prefix}, sha: ${sha} - parsing ${shard.podspecs.length} podspecs for deprecations`)
    let result = new Set()
    let count = 0
    let deprecations = podspecs.map(async podspec => {
      try {
        let encodedPathComponents = ['Specs', ...podspec.split('/')].map(encodeURIComponent)
        let path = encodedPathComponents.join('/')
        let response = await githubCDNProxyRequest(path, { 
          throwHttpErrors: true,
          retry: {
            limit: 5
          }
        })
        // console.log(response.httpVersion)
        let body = response.body
        // console.log(`Body: ${body}`)
        // let json = JSON.parse(body)
        if (isDeprecated(body)) {
          // console.log(`Deprecated: ${path}`)
          result.add(encodedPathComponents.map(decodeURIComponent).join('/'))
        }
        count += 1
        if (count % 2000 == 0) {
          console.log(`prefix: ${prefix}, sha: ${sha} - parsed ${count} deprecations`)
        }
      } catch (error) {
        console.log(`error retrieving podspec ${podspec}: ${error}`)
        throw error
      }
    })

    try {
    await Promise.all(deprecations)
    } catch (error) {
      console.log(`prefix: ${prefix}, sha: ${sha} - error retrieving podspecs!`)
      return
    }

    console.log(`prefix: ${prefix}, sha: ${sha} - parsed ${count} deprecations - done!`)
    shard.deprecations = [...result].sort()

    let forceCache = await otherSelfCDNRequest(`deprecations/${sha}/${prefix}/${podspecs.length}`)
    if (forceCache.statusCode == 200) {
      console.log(`prefix: ${prefix}, sha: ${sha} - deprecations cached`)
      return
    } 
  }

  let getDeprecationsLimited = bottleneck({ maxConcurrent: 1 }).wrap(getDeprecations)

  return async function(shards) { 
    let latest = await getLatest()
    var modifiedCount = 0
    for ([prefix, sha] of latest.map(p => [p.name, p.sha])) {
      // console.log(`prefix: ${prefix}, sha: ${sha}`)
      if (shards[prefix] && shards[prefix].sha === sha) {
        // console.log(`prefix: ${prefix}, sha: ${sha} - unmodified, skipping!`)
        getDeprecationsLimited(prefix, shards[prefix])
        continue
      }
      let oldDeprecations = shards[prefix] ? shards[prefix].deprecations : null

      shards[prefix] = await getTree(prefix, sha)
      shards[prefix].oldDeprecations = oldDeprecations
      console.log(`prefix: ${prefix}, sha: ${sha} - done, truncated: ${shards[prefix].truncated}`)
      modifiedCount += 1
      getDeprecationsLimited(prefix, shards[prefix])
    }
    if (modifiedCount == 0) {
      console.log(`all shards unmodified!`)
    }
  }
}