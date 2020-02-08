let Bottleneck = require('bottleneck');
let bottleneck = (args) => new Bottleneck(args)
let githubCDNRequestBase = require('./githubCDNRequest')(process.env.GH_CDN)
let githubCDNProxyRequest = bottleneck({ maxConcurrent: 50 }).wrap(githubCDNRequestBase)

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

  async function getLatest() {
    let [, body] = await githubAPIRequest('latest')
    let parsed = JSON.parse(body)
    return parsed
  }
  
  async function getTree(prefix, sha) {
    let [, body] = await githubAPIRequest(`tree/${sha}`) 
    let json = JSON.parse(body)

    let result = {}
    result.sha = json.sha
    result.truncated = json.truncated
    result.pods = []
    result.podspecs = []
    for (entry of json.tree) {
      let pathComponents = entry.path.split('/')
      if (pathComponents.length == 4) {
        result.pods.push([prefix, ...pathComponents].join('/'))
      } else if (pathComponents.length == 5) {
        result.podspecs.push([prefix, ...pathComponents].join('/'))
      }
    }
    return result
  }

  async function getDeprecations(prefix, shard) {
    console.log(`prefix: ${prefix}, sha: ${sha} - parsing ${shard.podspecs.length} podspecs for deprecations`)
    let result = new Set()
    let count = 0
    let deprecations = shard.podspecs.map(async podspec => {
      try {
        let encodedPathComponents = ['Specs', ...podspec.split('/')].map(encodeURIComponent)
        let path = encodedPathComponents.join('/')
        let [podResponse, body] = await githubCDNProxyRequest(path)
        // console.log(`Body: ${body}`)
        // let json = JSON.parse(body)
        if (isDeprecated(body)) {
          // console.log(`Deprecated: ${path}`)
          result.add(encodedPathComponents.map(decodeURIComponent).join('/'))
        }
        count += 1
        if (count % 500 == 0) {
          console.log(`prefix: ${prefix}, sha: ${sha} - parsed ${count} deprecations`)
        }
      } catch (error) {
        console.log(error)
      }
    })
    await Promise.all(deprecations)
    console.log(`prefix: ${prefix}, sha: ${sha} - parsed ${count} deprecations - done!`)
    shard.deprecations = [...result]
  }

  return async function(shards) { 
    let latest = await getLatest()
    for ([prefix, sha] of latest.map(p => [p.name, p.sha])) {
      console.log(`prefix: ${prefix}, sha: ${sha}`)
      if (shards[prefix] && shards[prefix].sha === sha) {
        console.log(`prefix: ${prefix}, sha: ${sha} - unmodified, skipping!`)
        continue
      }
      shards[prefix] = await getTree(prefix, sha)
      console.log(`prefix: ${prefix}, sha: ${sha} - done, truncated: ${shards[prefix].truncated}`)
      await getDeprecations(prefix, shards[prefix])
    }
  }
}