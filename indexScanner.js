
module.exports = function (token) {
  let githubAPIRequest = require('./tokenProtectedRequestToSelf')(token, process.env.GITHUB_API_SELF_CDN_URL)

  async function getLatest() {
    let response = await githubAPIRequest('latest')
    let parsed = JSON.parse(response.body)
    return parsed
  }
  
  async function getTree(prefix, sha) {
    let response = await githubAPIRequest(`tree/${sha}`)
    if (response.statusCode != 200) {
      console.log(`prefix: ${prefix}, sha: ${sha}, error: ${response.statusCode}`)
      return { truncated: true }
    }
    let json = JSON.parse(response.body)

    let result = {}
    result.prefix = prefix
    result.sha = json.sha
    result.truncated = json.truncated
    let pods = new Set()
    result.podspecs = []
    for (entry of json.tree) {
      let pathComponents = entry.path.split('/')
      if (pathComponents.length == 5) {
        pods.add(pathComponents[2])
        result.podspecs.push([prefix, ...pathComponents].join('/'))
      }
    }
    result.pods = [...pods]
    return result
  }

  return async function(shards) { 
    let latest = await getLatest()
    var modifiedCount = 0
    for ([prefix, sha] of latest.map(p => [p.name, p.sha])) {
      // console.log(`prefix: ${prefix}, sha: ${sha}`)
      if (shards[prefix] && shards[prefix].sha === sha) {
        // console.log(`prefix: ${prefix}, sha: ${sha} - unmodified, skipping!`)
        continue
      }
      shards[prefix] = await getTree(prefix, sha)
      console.log(`prefix: ${prefix}, sha: ${sha} - done, truncated: ${shards[prefix].truncated}`)
      modifiedCount += 1
    }
    if (modifiedCount == 0) {
      console.log(`all shards unmodified!`)
    }
  }
}