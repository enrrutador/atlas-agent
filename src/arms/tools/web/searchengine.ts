import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../../../common/logger.js';
import { SearchResult, SearchOptions } from './types.js';
import { webCache } from './cache.js';

const USER_AGENTS = [
  'Mozilla/5.0 (compatible)',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Mozilla/5.0 (X11; Linux x86_64)',
];

function pickUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/').replace(/&#(\d+);/g, (_m: string, c: string) => String.fromCharCode(parseInt(c, 10)));
}

export class SearchEngine {
  private lastDdgCall = 0;
  private minDdgInterval = 2000;

  private circuitBreakers = new Map<string, { failures: number; blockedUntil: number }>();

  private canUseSource(source: string): boolean {
    const cb = this.circuitBreakers.get(source);
    if (cb && cb.blockedUntil > Date.now()) {
      logger.warn('search', `${source} blocked (${Math.round((cb.blockedUntil - Date.now()) / 1000)}s)`);
      return false;
    }
    return true;
  }

  private recordFailure(source: string): void {
    const cb = this.circuitBreakers.get(source) || { failures: 0, blockedUntil: 0 };
    cb.failures++;
    if (cb.failures >= 3) {
      cb.blockedUntil = Date.now() + 120_000;
      cb.failures = 0;
      logger.warn('search', `${source} circuit breaker opened for 120s`);
    }
    this.circuitBreakers.set(source, cb);
  }

  private recordSuccess(source: string): void {
    this.circuitBreakers.set(source, { failures: 0, blockedUntil: 0 });
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const type = options.type || 'web';
    const count = options.count || 8;
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    const cacheKey = `${cleanQuery}|${type}|${count}`;
    const cached = webCache.get<SearchResult[]>(cacheKey, type);
    if (cached) {
      logger.info('search', `Cache hit: "${cleanQuery}" (${cached.length})`);
      return cached;
    }

    const engines: (() => Promise<SearchResult[]>)[] = [
      () => this.searchDuckDuckGoLite(cleanQuery, count),
      () => this.searchSearXNG(cleanQuery, count),
      () => this.searchGoogleScrape(cleanQuery, count),
      () => this.searchBrave(cleanQuery, count),
    ];

    for (const engine of engines) {
      try {
        logger.info('search', `Trying engine...`);
        const results = await engine();
        logger.info('search', `Engine returned ${results.length} results`);
        if (results.length > 0) {
          const deduped = this.deduplicate(results).slice(0, count);
          webCache.set(cacheKey, deduped, type);
          logger.info('search', `"${cleanQuery}" → ${deduped.length} results (cached)`);
          return deduped;
        }
      } catch (err) {
        logger.warn('search', `Engine error: ${(err as Error)?.message?.slice(0, 80)}`);
      }
    }

    logger.warn('search', `All engines returned 0 for "${cleanQuery}"`);
    return [];
  }

  // ── SearXNG (5 public instances, 4s timeout each) ──
  private async searchSearXNG(query: string, count: number): Promise<SearchResult[]> {
    const instances = [
      'https://searx.be', 'https://searx.work', 'https://search.sapti.me',
      'https://searxng.ch', 'https://opnxng.com',
    ];

    for (const instance of instances) {
      if (!this.canUseSource(`sx:${instance}`)) continue;

      try {
        const res = await axios.get(`${instance}/search`, {
          params: { q: query, format: 'json', categories: 'general', pageno: 1 },
          timeout: 3000,
          headers: { 'User-Agent': pickUA() },
        });

        const results = (res.data?.results || [])
          .filter((r: any) => r.title && r.url)
          .slice(0, count)
          .map((r: any) => ({
            title: decodeEntities(r.title),
            url: r.url,
            snippet: decodeEntities((r.content || '').slice(0, 300)),
            source: 'searxng',
            type: 'web' as const,
            publishedDate: r.publishedDate,
          }));

        if (results.length > 0) {
          this.recordSuccess(`sx:${instance}`);
          return results;
        }
      } catch {
        this.recordFailure(`sx:${instance}`);
      }
    }
    return [];
  }

  // ── DuckDuckGo Lite (reliable, no captcha) ──
  private async searchDuckDuckGoLite(query: string, count: number): Promise<SearchResult[]> {
    if (!this.canUseSource('ddg_lite')) return [];

    await this.throttleDdg();

    try {
      const res = await axios.post('https://lite.duckduckgo.com/lite/',
        new URLSearchParams({ q: query }),
        {
          timeout: 6000,
          headers: {
            'User-Agent': pickUA(),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      const $ = cheerio.load(res.data);
      const results: SearchResult[] = [];

      // DDG Lite: each result is in a <table> with rows
      // Link is in a <td>, snippet in the next <td>
      const links = $('a[rel="nofollow"]').toArray();
      logger.info('search', `DDG Lite: found ${links.length} nofollow links`);
      for (const a of links) {
        const href = $(a).attr('href') || '';
        if (!href.startsWith('http')) continue;

        const title = $(a).text().trim();
        if (!title) continue;

        // Find snippet: look for .result-snippet or sibling td
        let snippet = '';
        const row = $(a).closest('tr');
        const nextRow = row.next('tr');
        if (nextRow.length) {
          snippet = nextRow.text().trim().slice(0, 300);
        }
        // If no snippet from next tr, try the link's own td
        if (!snippet) {
          snippet = $(a).closest('td').text().replace(title, '').trim().slice(0, 200);
        }

        results.push({
          title: decodeEntities(title),
          url: href,
          snippet: decodeEntities(snippet),
          source: 'duckduckgo',
          type: 'web',
        });

        if (results.length >= count) break;
      }

      if (results.length > 0) {
        this.recordSuccess('ddg_lite');
        return results;
      }
    } catch (err) {
      this.recordFailure('ddg_lite');
    }
    return [];
  }

  // ── Google scrape (lightweight HTML fallback) ──
  private async searchGoogleScrape(query: string, count: number): Promise<SearchResult[]> {
    if (!this.canUseSource('google')) return [];

    try {
      const res = await axios.get('https://www.google.com/search', {
        params: { q: query, hl: 'es' },
        timeout: 6000,
        headers: {
          'User-Agent': pickUA(),
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        },
      });

      const $ = cheerio.load(res.data);
      const results: SearchResult[] = [];

      // Google search result selectors (multiple fallbacks)
      const selectors = [
        'div.g',              // Standard
        'div[data-hveid]',    // Modern
        '.yuRUbf',            // Alternative
      ];

      for (const sel of selectors) {
        $(sel).each((_i, el) => {
          if (results.length >= count) return false;
          const a = $(el).find('a[href^="http"]').first();
          const href = a.attr('href') || '';
          const title = a.text().trim();
          const snippet = $(el).find('.VwiC3b, .lEBKkf, [data-sncf], span.aCOpRe').first().text().trim();
          if (href && title && !href.includes('google.com')) {
            results.push({
              title: decodeEntities(title),
              url: href,
              snippet: decodeEntities(snippet.slice(0, 300)),
              source: 'google',
              type: 'web',
            });
          }
          return true;
        });
        if (results.length > 0) break;
      }

      if (results.length > 0) {
        this.recordSuccess('google');
        return results;
      }
    } catch {
      this.recordFailure('google');
    }
    return [];
  }

  // ── Brave Search API (requires BRAVE_API_KEY) ──
  private async searchBrave(query: string, count: number): Promise<SearchResult[]> {
    const apiKey = process.env.BRAVE_API_KEY;
    if (!apiKey) return [];
    if (!this.canUseSource('brave')) return [];

    try {
      const res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
        params: { q: query, count: Math.min(count, 10) },
        timeout: 6000,
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': apiKey,
        },
      });

      const results: SearchResult[] = (res.data?.web?.results || [])
        .slice(0, count)
        .map((r: any) => ({
          title: r.title || '',
          url: r.url || '',
          snippet: (r.description || '').slice(0, 300),
          source: 'brave',
          type: 'web' as const,
          publishedDate: r.age,
        }));

      if (results.length > 0) {
        this.recordSuccess('brave');
        return results;
      }
    } catch {
      this.recordFailure('brave');
    }
    return [];
  }

  private deduplicate(results: SearchResult[]): SearchResult[] {
    const seen = new Set<string>();
    const domainCount = new Map<string, number>();
    const diverse: SearchResult[] = [];
    const rest: SearchResult[] = [];

    for (const r of results) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      try {
        const domain = new URL(r.url).hostname;
        const cnt = domainCount.get(domain) || 0;
        if (cnt < 1) {
          diverse.push(r);
          domainCount.set(domain, cnt + 1);
        } else {
          rest.push(r);
        }
      } catch {
        diverse.push(r);
      }
    }
    return [...diverse, ...rest];
  }

  private async throttleDdg(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastDdgCall;
    if (elapsed < this.minDdgInterval) {
      await new Promise(r => setTimeout(r, this.minDdgInterval - elapsed));
    }
    this.lastDdgCall = Date.now();
  }
}

export const searchEngine = new SearchEngine();
