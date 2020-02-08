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

  return async function(shards) { 
    let latest = await getLatest()
    for ([prefix, sha] of latest.map(p => [p.name, p.sha])) {
      console.log(`prefix: ${prefix}, sha: ${sha}`)
      shards[prefix] = await getTree(prefix, sha)
      console.log(`prefix: ${prefix}, sha: ${sha} - done, truncated: ${shards[prefix].truncated}`)
    }
  }
}