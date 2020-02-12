# CocoaPods CDN Server

## Rationale 
While Netlify is great in the automation respect, there are several reasons to look for an alternative:

* Netlify is expensive, we don't want @dnkoutso to keep paying for it!
* Publish latency is problematic - builds take 4-5 minutes and sometimes get delayed until a previous build finishes.  
@paulb777 and [others](https://github.com/CocoaPods/CocoaPods/issues/9497) have trouble publishing interlinked pods.

## Proposed alternative
Use GitHub API to get the latest index data directly. Use a registered GH API token.

* Use git tree API to retrieve directory listings. This API supports ETags, and therefore only consumes API calls when data changes.
* Use GH Search API to retrieve probably deprecated podspecs. This currently produces false positives, but those will get ruled out by the client during dependency resolution.
* Use a CDN both for user-facing calls, and for reducing GH API usage.