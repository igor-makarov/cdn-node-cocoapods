let getEnv = require('../util/getEnv')
const otherSelfCDNRequest = require('../api/tokenProtectedRequestToSelf')(getEnv('GH_TOKEN'), getEnv('SELF_CDN_URL'))
const indexScanner = require('../scanners/indexScanner')(getEnv('GH_TOKEN'))
const deprecationScanner = require('../scanners/deprecationScanner')(getEnv('GH_TOKEN'))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function (shards, deprecations) {
  setInterval(() => {
    otherSelfCDNRequest('keep_alive')
  }, 30 * 1000)

  async function loop(intervalSeconds, functionToCall) {
      let minWaitTime = intervalSeconds * 1000
      while (true) {
        let startTime = new Date()
        try {
          await functionToCall()
        } catch (error) {
          console.log(error)
        }
        let elapsed = (new Date()) - startTime
        if (elapsed < minWaitTime) {
          let waitTime = minWaitTime - elapsed
          // console.log(`Waiting ${waitTime/1000}s`)
          await wait(waitTime)
        }
      }
  }

  await Promise.all([loop(10, async () => await indexScanner(shards)), 
                     loop(30, async () => await deprecationScanner(deprecations))])
}