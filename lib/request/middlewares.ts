import { Histogram } from 'prom-client'
import { extractErrorBody, getUrl, isNotServerError } from './index.js'
import { makeLogger } from '../logger/index.js'
import type { InternalConfig, Middleware } from './types'
import { HttpException } from './errors.js'

type PromReturnTypeSerializer =
  | Partial<Record<string, string | number>>
  | undefined

const defaultSerializer = (
  config: InternalConfig,
  response: Response,
  error?: Error
): PromReturnTypeSerializer => {
  const url = getUrl(config.baseUrl, config.url)
  return {
    result: error ? 'error' : 'success',
    status: error ? 'unknown' : response.status,
    url: url.toString(),
  }
}

/**
 * Simple middleware for prom-client
 *
 * ```ts
 * const h = new Histogram({
 *   name: 'name',
 *   help: 'help',
 *   buckets: [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 20],
 *   labelNames: ['result', 'status'],
 * });
 * // With default serializer
 * prom(h)
 * // With custom serializer
 * prom(h, (config, res, error) => ({
 *  result: error ? 'error' : 'result',
 *  status: 200,
 *  url: config.url.toString(),
 * }));
 * ```
 * @param prom Histogram instance
 * @param serialize callback fn for pick values from iteration
 * @returns Response
 */
export const prom =
  (
    prom: Histogram,
    serialize: (
      conf: InternalConfig,
      response: Response,
      error?: Error
    ) => PromReturnTypeSerializer = defaultSerializer
  ): Middleware =>
  async (config, next) => {
    let response!: Response
    const timer = prom.startTimer()
    try {
      response = await next(config)
      timer(serialize(config, response))
    } catch (error) {
      if (!(error instanceof Error)) {
        timer(serialize(config, response))
        throw error
      }
      timer(serialize(config, response, error))
      throw error
    }
    return response
  }

export const retry =
  (maxTries = 3, retryConfig: { ignoreAbort: boolean }): Middleware =>
  async (config, next) => {
    const loop = async () => {
      let response!: Response
      config.attempt++
      try {
        response = await next(config)
      } catch (error) {
        if (error.name === 'AbortError' && !retryConfig.ignoreAbort) throw error
        if (isNotServerError(error)) throw error
        if (maxTries <= config.attempt) throw error

        response = await loop()
      }
      return response
    }

    return await loop()
  }

export const logger =
  (logger: ReturnType<typeof makeLogger>): Middleware =>
  async (config, next) => {
    let response!: Response
    logger.log('Start request', config)
    try {
      response = await next(config)
    } finally {
      logger.log('End request', config)
    }
    return response
  }

export const notOkError = (): Middleware => async (config, next) => {
  const response = await next(config)
  if (!response?.ok) {
    const errorBody = await extractErrorBody(response)
    throw new HttpException(errorBody, response.status)
  }
  return response
}
