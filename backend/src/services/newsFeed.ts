/** Port of `services/news_feed.py`. */
import { XMLParser } from 'fast-xml-parser'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('services.newsFeed')

const NEWS_FEED_URL = 'https://coinjournal.net/news/feed/'

const parser = new XMLParser({
  ignoreAttributes: true,
  processEntities: true,
  trimValues: true,
})

/** Mirrors Python's `html.unescape` for the handful of named entities in RSS. */
function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h: string) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&amp;/g, '&')
}

function stripHtmlTags(text: string): string {
  if (!text) return ''
  const cleaned = unescapeHtml(text).replace(/<[^>]+>/g, ' ')
  return cleaned.replace(/\s+/g, ' ').trim()
}

/** RFC 2822 pubDate -> 'YYYY-MM-DD HH:MM:SSZ' in UTC. */
function formatPubDate(raw: string): string {
  if (!raw) return raw
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw
  return `${parsed.toISOString().slice(0, 19).replace('T', ' ')}Z`
}

function asText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object' && '#text' in (value as object)) {
    return String((value as Record<string, unknown>)['#text'] ?? '')
  }
  return ''
}

export async function fetchLatestNews(maxChars = 4000): Promise<string> {
  try {
    const response = await fetch(NEWS_FEED_URL, {
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status !== 200) {
      logger.warning(`Failed to fetch news feed: status ${response.status}`)
      return ''
    }

    const xml = await response.text()
    const doc = parser.parse(xml) as Record<string, any>
    const channel = doc?.rss?.channel ?? doc?.channel
    if (!channel) return ''

    const rawItems = channel.item
    const items: Record<string, unknown>[] = Array.isArray(rawItems)
      ? rawItems
      : rawItems
        ? [rawItems]
        : []

    const entries: string[] = []

    for (const item of items) {
      const title = stripHtmlTags(asText(item.title))
      const pubDateRaw = asText(item.pubDate).trim()

      let summary = stripHtmlTags(asText(item.description))
      summary = summary
        .replace(/The post .*? appeared first on .*/i, '')
        .trim()

      const formattedTime = pubDateRaw ? formatPubDate(pubDateRaw) : pubDateRaw

      const parts: string[] = []
      if (formattedTime) parts.push(formattedTime)
      if (title) parts.push(title)

      let entryText = parts.join(' | ')
      if (summary) {
        entryText = entryText ? `${entryText}: ${summary}` : summary
      }
      entryText = entryText.trim()
      if (!entryText) continue

      const existingText = entries.join('\n')
      const candidateText = existingText
        ? `${existingText}\n${entryText}`
        : entryText

      if (candidateText.length > maxChars) {
        let remaining = maxChars - existingText.length
        if (existingText) remaining -= 1
        if (remaining <= 0) break

        let truncated = entryText.slice(0, remaining).replace(/\s+$/, '')
        if (truncated) {
          if (truncated.length < entryText.length) {
            truncated = `${truncated.replace(/[ .,;:-]+$/, '')}...`
          }
          entries.push(truncated)
        }
        break
      }

      entries.push(entryText)
    }

    return entries.join('\n')
  } catch (err) {
    logger.warning(`Failed to process news feed: ${err}`)
    return ''
  }
}
