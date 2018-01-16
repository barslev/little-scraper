// TODO: add writing to file (make this separate module?)
// TODO:  there is a big bug with "takeWhile" it would discard all results in a
// concurrent chunk if first result happen to meet takeWhile condition

const R = require('ramda')
const Rx = require('rxjs/Rx')
const chalk = require('chalk')

const { log } = require('../console-tools')

const { httpError } = require('./utils/rx-utils')
const { rnd } = require('./utils/rnd')
const { writeJsonToFile } = require('./utils/file-utils')
const IteratorSubject = require('./iterator-subject')

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
  fileName,
  logProgress = true,
  logHttpRequests = false,
}) => {
  if (writeResultsToFile && !fileName) {
    throw new Error('"fileName" must be provided when "writeResultsToFile" is true')
  }

  const httpGet = url => {
    if (logHttpRequests) {
      console.log(chalk.gray('HTTP: ' + url))
    }
    return buildRequestWithRotatingUserAgent({
      request,
      successStatusCodes,
      proxyUrl,
      headers,
    })(url)
  }

  return ({ fromUrls: urlsWithContext, fromUrlsIterator: urlsIterator }) => {
    if (urlsIterator && !scrapeWhile) {
      throw new Error(
        '"scrapeWhile" parameter is required when using an' +
          ' url generator function' +
          'otherwise scraping will not know where to stop and will run forever'
      )
    }

    // log.json(urlsIterator.next())

    let successCount = 0
    let failedCount = 0

    function printSummary(results) {
      if (results) {
        const totalCount = successCount + failedCount

        console.log(
          chalk`Total = succeded + failed: ` +
            chalk`{white ${totalCount}} = {green ${successCount}}` +
            (failedCount === 0
              ? chalk` + {gray ${failedCount}}`
              : chalk` + {rgb(255,70,0) ${failedCount}}`)
        )
      } else {
        log.info('Results were null or undefined after scraping.')
      }
    }

    async function writeResultsToJsonFile(results) {
      return writeJsonToFile(`data/${fileName}.json`, results, {
        spaces: 2,
      }).then(fileName => log.done(`Saved results to "data/${fileName}"`))
    }

    const fromUrlsIterator = (urlsIterator, scrapeWhile) => {
      const urlsIteratorSubject = new IteratorSubject(urlsIterator)

      const scrapingPromise = urlsIteratorSubject
        .mergeMap(
          ({ url }) =>
            O.of(url)
              .flatMap(url => httpGet(url))
              .delay(randomizeDelay ? rnd(delay / 1.5, delay * 1.5) : delay)
              .retryWhen(
                httpError({
                  maxRetries: retryAttempts,
                  backoffMs: retryBackoffMs,
                  exponentialBackoff: exponentialRetryBackoff,
                  logProgress,
                  onFinalRetryFail: () => {
                    failedCount += 1
                    urlsIteratorSubject.next()
                  },
                })
              ),
          // result selector, defines shape of the observable data passed further
          (urlWithContext, response) => ({ response, urlWithContext }),
          concurrency
        )
        .do(({ response, urlWithContext }) => {
          if (scrapeWhile({ response })) {
            urlsIteratorSubject.next()
          } else {
            urlsIteratorSubject.complete()
          }

          if (logProgress) {
            if (scrapeWhile({ response, urlWithContext })) {
              log.done(
                `[${response.statusCode}] ${urlWithContext.url}` +
                  ` ${chalk.gray(response.timeToCompleteMs + 'ms')}`
              )
            } else {
              log.doneBut(
                `[${response.statusCode}] ${urlWithContext.url}` +
                  ` ${chalk.gray(response.timeToCompleteMs + 'ms')}`
              )
            }
          }
        })
        .do(({ response }) => {
          // increment success count only when scrape while is defined
          if (scrapeWhile && scrapeWhile({ response })) {
            successCount += 1
          }
        })
        .map(scrapingFunc)
        .reduce((results, currentResults) => {
          if (!Array.isArray(results)) {
            throw new Error(
              "Scraping function must return an array, but it didn't. " +
                `Instead returned value was: "${currentResults}"`
            )
          }

          return results.concat(currentResults)
        })
        // side-effects
        .do(printSummary)
        .toPromise()
        .then(results => (writeResultsToFile ? writeResultsToJsonFile(results) : results))

      // kicks in urlsIteratorSubject observable
      R.times(() => urlsIteratorSubject.next(), concurrency)

      return scrapingPromise.then(x => ({
        data: x,
        failedCount: failedCount,
        successCount: successCount,
      }))
    }

    const fromUrls = urls => {
      const urlsIterator = makeIterator(urls)
      return fromUrlsIterator(urlsIterator, () => true)
    }

    return urlsWithContext
      ? fromUrls(urlsWithContext)
      : fromUrlsIterator(urlsIterator, scrapeWhile)
  }
}

// creates iterator from arrray
function makeIterator(array) {
  let nextIndex = 0

  return {
    next: () =>
      nextIndex < array.length
        ? { value: array[nextIndex++], done: false }
        : { done: true },
  }
}

module.exports = {
  createScraper,
}
