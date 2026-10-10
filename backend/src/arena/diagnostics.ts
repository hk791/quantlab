/** Display-only portfolio/cost diagnostics. Pure; never controls trading. */
import type { ArenaModelConfig, ModelBillingConfig } from './config.js'

interface DiagnosticPosition {
  symbol: string; side: 'LONG' | 'SHORT'; quantity: number; entry_price: number;
  margin: number; stop_loss: number | null;
}

export function portfolioDiagnostics(
  positions: DiagnosticPosition[], prices: Record<string, number>, equity: number,
  costs: { feeRate: number; slippageBps: number }, priceAsOf: number, now: number,
) {
  const stale = !Number.isFinite(priceAsOf) || priceAsOf <= 0 || now - priceAsOf > 30_000
  const missingPrices = positions.filter(p => !Number.isFinite(prices[p.symbol]) || prices[p.symbol]! <= 0).map(p => p.symbol)
  const missingStops = positions.filter(p => !Number.isFinite(p.stop_loss) || p.stop_loss! <= 0).map(p => p.symbol)
  const margin = positions.reduce((s, p) => s + p.margin, 0)
  const valid = !positions.length || (!stale && !missingPrices.length)
  const slip = costs.slippageBps / 10_000
  let longNotional = 0, shortNotional = 0, stopScenarioLoss = 0
  if (valid) for (const p of positions) {
    const price = prices[p.symbol]!
    const long = p.side === 'LONG'
    if (long) longNotional += p.quantity * price
    else shortNotional += p.quantity * price
    if (p.stop_loss == null) continue
    // Use the worse of stop/current price, as the ledger's stop execution does.
    const trigger = long ? Math.min(price, p.stop_loss) : Math.max(price, p.stop_loss)
    const exit = trigger * (long ? 1 - slip : 1 + slip)
    const sign = long ? 1 : -1
    const before = Math.max(0, p.margin + sign * p.quantity * (price - p.entry_price))
    const after = Math.max(0, p.margin + sign * p.quantity * (exit - p.entry_price) - p.quantity * exit * costs.feeRate)
    stopScenarioLoss += Math.max(0, before - after)
  }
  const pct = (v: number | null) => v != null && valid && Number.isFinite(equity) && equity > 0 ? v / equity * 100 : null
  const stopLoss = valid && !missingStops.length && Number.isFinite(slip) && slip >= 0 && slip < 1 ? stopScenarioLoss : null
  return {
    positions: positions.length, longs: positions.filter(p => p.side === 'LONG').length,
    shorts: positions.filter(p => p.side === 'SHORT').length,
    margin, marginPct: pct(margin),
    longNotional: valid ? longNotional : null, shortNotional: valid ? shortNotional : null,
    grossExposurePct: pct(valid ? longNotional + shortNotional : null),
    netExposurePct: pct(valid ? longNotional - shortNotional : null),
    stopScenarioLoss: stopLoss, stopScenarioPct: pct(stopLoss),
    priceAsOf: priceAsOf > 0 ? priceAsOf : null, priceStale: stale, missingPrices, missingStops,
  }
}

export interface TradingCostTotals {
  closedFees: number; closedFunding: number; openFees: number; openFunding: number;
  buyFillNotional: number; sellFillNotional: number; closedTrades: number;
}

export function tradingCostDiagnostics(t: TradingCostTotals, slippageBps: number) {
  const s = slippageBps / 10_000
  // Infer the no-slippage reference from fills. Historical rates were not persisted.
  // Liquidation exits (no ledger slippage) must be excluded by the input aggregator.
  const slippageEstimate = Number.isFinite(s) && s >= 0 && s < 1
    ? t.buyFillNotional * s / (1 + s) + t.sellFillNotional * s / (1 - s) : null
  return {
    fees: t.closedFees + t.openFees, funding: t.closedFunding + t.openFunding,
    closedFees: t.closedFees, closedFunding: t.closedFunding, openFees: t.openFees, openFunding: t.openFunding,
    explicitCosts: t.closedFees + t.openFees + t.closedFunding + t.openFunding,
    slippageEstimate, slippageBps, closedTrades: t.closedTrades,
  }
}

export function modelCostDiagnostics(
  model: Pick<ArenaModelConfig, 'model' | 'apiKeyEnv' | 'baseUrl'>,
  activeModels: Pick<ArenaModelConfig, 'apiKeyEnv'>[], billing: ModelBillingConfig[],
  usage: { calls: number; measuredCalls: number; prompt: number; completion: number },
) {
  const plans = billing.filter(p => p.apiKeyEnv === model.apiKeyEnv)
  const plan = plans.find(p => p.mode === 'usage' && p.model === model.model)
    ?? plans.find(p => p.mode === 'subscription' || p.model == null)
  let tokenplan = false
  try { const u = new URL(model.baseUrl); tokenplan = u.hostname === 'api.lkeap.cloud.tencent.com' && u.pathname.startsWith('/plan/') } catch { /* unknown endpoint */ }
  const mode = plan?.mode ?? (tokenplan ? 'subscription' : 'unknown')
  const sharers = activeModels.filter(m => m.apiKeyEnv === model.apiKeyEnv).length
  // Published general Token Plan prices, verified 2026-10-06. These are
  // scenarios, not the customer's invoice or inferred purchased tier.
  const referencePlans = tokenplan && mode === 'subscription' ? [
    { tier: 'Lite', monthlyFee: 39, monthlyCredits: 780 },
    { tier: 'Standard', monthlyFee: 99, monthlyCredits: 1980 },
    { tier: 'Pro', monthlyFee: 299, monthlyCredits: 5980 },
    { tier: 'Max', monthlyFee: 599, monthlyCredits: 11980 },
  ].map(p => ({ ...p, dailyTotal: p.monthlyFee / 30,
    dailyAllocation: sharers > 0 ? p.monthlyFee / 30 / sharers : null })) : []
  return {
    mode, currency: plan?.currency ?? (tokenplan ? 'CNY' : null),
    monthlyFee: plan?.mode === 'subscription' ? plan.monthlyFee ?? null : null,
    dailyAllocation: plan?.mode === 'subscription' && plan.monthlyFee != null && sharers > 0 ? plan.monthlyFee / 30 / sharers : null,
    allocationAccounts: mode === 'subscription' ? sharers : null,
    usageEstimate: plan?.mode === 'usage' ? (usage.prompt * plan.inputPerMillion + usage.completion * plan.outputPerMillion) / 1_000_000 : null,
    measuredCalls: usage.measuredCalls, calls: usage.calls,
    referencePlans, referenceDate: tokenplan ? '2026-10-06' : null,
    referenceUrl: tokenplan ? 'https://cloud.tencent.com/document/product/1823/130060' : null,
  }
}
