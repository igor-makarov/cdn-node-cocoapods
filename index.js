require('dotenv').config()

if (process.env.PRETTY_LOG) {
  require('log-timestamp')
}

var shards = {}
var deprecations = new Set()

let app = require('./src/app/app')
app(shards, deprecations)

let runLoop = require('./src/app/mainRunLoop')
runLoop(shards, deprecations)