/**
 * Zod request/response schemas, replacing `schemas/*.py`.
 * Only the shapes used by the mounted routers are modelled.
 */
import { z } from 'zod'

export const orderSideSchema = z.enum(['BUY', 'SELL'])
export const orderTypeSchema = z.enum(['MARKET', 'LIMIT'])

/** Body of POST /api/orders/create. */
export const orderCreateRequestSchema = z.object({
  user_id: z.number().int(),
  symbol: z.string(),
  name: z.string(),
  side: z.string(), // BUY/SELL
  order_type: z.string(), // MARKET/LIMIT
  price: z.number().nullish(),
  quantity: z.number(),
  /** Username for verification (required if no session_token). */
  username: z.string().nullish(),
  /** Trading password (required if no session_token). */
  password: z.string().nullish(),
  /** Auth session token (alternative to username+password). */
  session_token: z.string().nullish(),
})
export type OrderCreateRequest = z.infer<typeof orderCreateRequestSchema>

/** Body of POST /api/account/ (create AI trading account). */
export const accountCreateSchema = z.object({
  name: z.string(),
  model: z.string().default('gpt-4-turbo'),
  base_url: z.string().default('https://api.openai.com/v1'),
  api_key: z.string(),
  initial_capital: z.number().default(10000.0),
  account_type: z.string().default('AI'),
})
export type AccountCreate = z.infer<typeof accountCreateSchema>

/** Body of PUT /api/account/{account_id}. */
export const accountUpdateSchema = z.object({
  name: z.string().nullish(),
  model: z.string().nullish(),
  base_url: z.string().nullish(),
  api_key: z.string().nullish(),
})
export type AccountUpdate = z.infer<typeof accountUpdateSchema>

/** Body of POST /api/account/test-llm. */
export const testLLMSchema = z.object({
  model: z.string(),
  base_url: z.string(),
  api_key: z.string(),
})
export type TestLLMRequest = z.infer<typeof testLLMSchema>
