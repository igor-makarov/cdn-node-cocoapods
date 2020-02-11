/**
 * @param  {String} linkStr String from API's response in 'Link' field
 * @return {Object}
 */
module.exports = function parser(linkStr) {
  return linkStr.split(',').map(function(rel) {
    return rel.split(';').map(function(curr, idx) {
      if (idx === 0) return /(\?|&)page=(\d+)/.exec(curr)[2];
      if (idx === 1) return /rel="(.+)"/.exec(curr)[1];
    })
  }).reduce(function(obj, curr, i) {
    obj[curr[1]] = curr[0];
    return obj;
  }, {});
}
