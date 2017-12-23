// TODO: add writing to file (make this separate module?)
// TODO: make error reporting similar to non Rx scraper
// TODO: randomize delays

// TODO: aggregation of failed requests with Either Monad (can't do it now since can't figure out
// how to keep trakc of processed and afailed observables)

const R = require('ramda')
const Rx = require('rxjs/Rx')
const chalk = require('chalk')

const { log } = require('../console-tools')
const { logHttpErrorForObservable } = require('./utils/console-utils')
const { get } = require('./utils/ramda-utils')
const { httpError } = require('./utils/rx-utils')

const buildRequest = require('../build-request')
const {
  buildRequestWithRotatingUserAgent,
} = require('../build-request-with-rotating-user-agent')
const requestWithoutCookies = buildRequest({ useCookies: false })
const O = Rx.Observable

const createScraper = ({
  // a function that will be called for every result returned by requesting every url passed to scraper
  scrapingFunc = () => [],
  // defines when to stop scraping, useful when generator function is used
  // to produce urls, infinte by default
  scrapeWhile = request => true,
  createPagedUrl,
  concurrency = 3,
  delay = 1000,
  // would randomize given delay, so it's within [x/2, x*2] range
  randomizeDelay = true,
  retryAttempts = 5,
  retryBackoffMs = 1000,
  // retryAttempt * retryBackoffMs
  exponentialRetryBackoff = true,
  // a function that accetps a number representing "totalPages"
  // called whenever any progress is made (URL is finished fetching)
  onProgress = R.identity,
  // a function that can fetch URL
  request = requestWithoutCookies,
  // if response status code is not one of the described below request would be reated as failed
  successStatusCodes = [200],
  proxyUrl = '',
  headers = {},
  writeResultsToFile = false,
}) => {
  const httpGet = buildRequestWithRotatingUserAgent({
    request,
    successStatusCodes,
    proxyUrl,
    headers,
  })

  let totalCount = 0
  let successCount = 0

  return urlsWithContext =>
    O.from(urlsWithContext)
      .do(() => (totalCount += 1))
      .mergeMap(
        ({ url }) =>
          O.of(url)
            .flatMap(url => httpGet(url))
            .do(() => (successCount += 1))
            .delay(delay)
            .retryWhen(
              httpError({
                maxRetries: retryAttempts,
                backoffMs: retryBackoffMs,
                exponentialBackoff: exponentialRetryBackoff,
              }),
            ),
        // result selector, defines shape of the observable data passed further
        (url, response) => ({ response, urlWithContext: url }),
        concurrency,
      )
      .takeWhile(scrapeWhile)
      .do(({ response, urlWithContext }) =>
        log.done(`[${response.statusCode}] ${urlWithContext.url}`),
      )
      .map(scrapingFunc)
      .reduce((results, currentResults) => {
        if (!Array.isArray(results)) {
          throw new Error(
            "Scraping function must return an array, but it didn't. " +
              `Instead returned value was: "${currentResults}"`,
          )
        }

        return results.concat(currentResults)
      })
      .do(results => {
        if (results) {
          // TODO: fix calculation when "takeUntill" is used
          const failedWithRetryCount = totalCount - successCount
          const failedCount = failedWithRetryCount / (retryAttempts + 1)
          const trueTotal = successCount + failedCount

          console.log(
            chalk`
            Total/succeded/failed: {white ${trueTotal}} = {green ${successCount}}` +
              (failedCount === 0
                ? chalk` + {gray ${failedCount}}`
                : chalk` + {rgb(255,20,0) ${failedCount}}`),
          )
        } else {
          log.info('Results were null or undefined after scraping.')
        }

        if (writeResultsToFile) {
          return writeJsonToFile(`data/${fileName}.json`, results, { spaces: 2 })
            .then(fileName => log.done(`Saved results to "data/${fileName}"`))
            .then(() => results)
        }
      })
}

module.exports = {
  createScraper,
}
