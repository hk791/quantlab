/** Port of `config/settings.py`. */

export interface MarketConfig {
  market: string
  minCommission: number
  commissionRate: number
  exchangeRate: number
  minOrderQuantity: number
  lotSize: number
}

/** Default configs for CRYPTO markets. */
export const DEFAULT_TRADING_CONFIGS: Record<string, MarketConfig> = {
  CRYPTO: {
    market: 'CRYPTO',
    minCommission: 0.1, // $0.1 minimum commission for crypto
    commissionRate: 0.001, // 0.1% commission rate (typical for crypto)
    exchangeRate: 1.0, // USD base
    minOrderQuantity: 1, // Can trade fractional amounts
    lotSize: 1,
  },
}
