module.exports = function(varName) {
  if (process.env[varName]) {
    return process.env[varName]
  } else {
    console.log(`couldn't find $${varName} in env`)
    exit(0)
  }
}