
module.exports = function (token) {
  let getEnv = require('../util/getEnv')
  let prefixes = getEnv('DEPRECATION_SEARCH_PREFIXES').split(' ')
  let otherSelfCDNRequest = require('../api/tokenProtectedRequestToSelf')(token, getEnv('SELF_CDN_URL'))

  async function getDeprecationsSearch(prefix) {
    let response = await otherSelfCDNRequest(`potential_deprecations?path=${prefix}`, { 
      retry: {
        limit: 10,
        statusCodes: [403]
      }
    }) 
    if (response.statusCode != 200) {
      // console.log(response.headers)
      return []
    }
    return response.body.split('\n')
  }

  return async function scanDeprecations(deprecations) {
    var addedDeprecations = 0
    for (let prefix of prefixes) {
      let found = await getDeprecationsSearch(prefix)
      let filtered = found.filter(podspec => !deprecations.has(podspec))
      if (filtered.length > 0 || found.length == 0) {
        console.log(`prefix: ${prefix} potential deprecations: ${filtered.length}/${found.length}`)
      }
      for (let deprecatedPodspec of filtered) {
        addedDeprecations += 1
        deprecations.add(deprecatedPodspec)
      }
    }
    console.log(`added ${addedDeprecations} deprecations!`)
  }
}