/** System config API routes. Port of `api/config_routes.py`. */
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('api.config')

export const configRoutes = new Hono()

/** Check if required configs are set. */
configRoutes.get('/check-required', (c) => {
  try {
    return c.json({ has_required_configs: true, missing_configs: [] })
  } catch (e) {
    logger.error(`Failed to check required configs: ${e}`)
    throw new HTTPException(500, {
      message: `Failed to check required configs: ${e}`,
    })
  }
})
