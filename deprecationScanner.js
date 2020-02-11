// let githubCDNProxyRequest = require('./githubCDNRequest')

let deprecationRegex = /\s\"deprecated(|_in_favor_of)\":/
function isDeprecated(body) {
   if (deprecationRegex.test(body)) {
     let json = JSON.parse(body)
     return json.deprecated || json.deprecated_in_favor_of
   } else {
     return false
   }
}

Array.prototype.flat = function() {
  return this.reduce((acc, val) => acc.concat(val), []);
}

module.exports = function (token) {
  let otherSelfCDNRequest = require('./tokenProtectedRequestToSelf')(token, process.env.SELF_CDN_URL)

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

  // async function isDeprecatedPodspec(podspec) {
  //   let encodedPathComponents = podspec.split('/').map(encodeURIComponent)
  //   let path = encodedPathComponents.join('/')
  //   let response = await githubCDNProxyRequest(path, { 
  //     retry: {
  //       limit: 5
  //     }
  //   })
  //   // console.log(response.httpVersion)
  //   let body = response.body
  //   if (response.statusCode != 200) {
  //     console.log(`podspec: ${podspec} error: ${response.statusCode}`)
  //     return false
  //   }
  //   // console.log(`Body: ${body}`)
  //   // let json = JSON.parse(body)
  //   return isDeprecated(body)
  // }

  return async function scanDeprecations(deprecations) {
    let prefixes = '0123456789abcdef'.split('')
    prefixes.push('1/c/3')
    prefixes.push('c/0/0')
    var addedDeprecations = 0
    for (prefix of prefixes) {
      let found = await getDeprecationsSearch(prefix)
      let filtered = found.filter(podspec => !deprecations.has(podspec))
      if (filtered.length > 0 || found.length == 0) {
        console.log(`prefix: ${prefix} potential deprecations: ${filtered.length}/${found.length}`)
      }
      // let deprecationPromises = filtered.map(async podspec => {
      //   let deprecated = await isDeprecatedPodspec(podspec)
      //   return deprecated ? [podspec] : []
      // })

      // let deprecated = (await Promise.all(deprecationPromises)).flat()
      let deprecated = filtered
      for (deprecatedPodspec of deprecated) {
        addedDeprecations += 1
        deprecations.add(deprecatedPodspec)
      }
    }
    console.log(`added ${addedDeprecations} deprecations!`)
  }
}