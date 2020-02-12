let getEnv = require('../util/getEnv')
let githubAPIRequest = require('../api/tokenProtectedRequestToSelf')(getEnv('GITHUB_API_SELF_CDN_URL'))
let octopage = require('../util/octopage')

async function getDeprecationSearch(prefix, page) {
  let response = await githubAPIRequest(`search_deprecations?path=${prefix}&page=${page}`) 
  if (response.statusCode != 200) {
    console.log(`deprecations search error: ${response.statusCode}`)
    return []
  }
  let json = JSON.parse(response.body)
  let paging = response.headers.link ? octopage(response.headers.link) : {}
  paging.current = page
  return [paging, json]
}

module.exports = async function (req, res) {
  let maxAge = 5 * 60
  let prefix = req.query.path

  var podspecList = new Set()
  var paging = { next: 1 }
  var searchResult = null
  do {
    [paging, searchResult] = await getDeprecationSearch(prefix, paging.next)
    if (!paging) {
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('retry-after', '60')
      res.sendStatus(403)
      return
    }
  
    console.log(`prefix: ${prefix} total: ${searchResult.total_count} page: ${paging.current}, items: ${searchResult.items.length}`)

    for (let item of searchResult.items) {
      podspecList.add(item.path)
      // console.log(item.path)
    }
    // await wait(1000)
  } while (paging.next);

  let resultList = [...podspecList].sort()
  res.setHeader('Cache-Control', `public,max-age=${maxAge},s-max-age=${maxAge}`)
  res.send(resultList.join('\n'))
}