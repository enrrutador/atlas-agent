/**
 * Atlas Search Tool - Web search via SearXNG or DuckDuckGo HTML
 */

import axios from 'axios';
import { logger } from '../../common/logger.js';

export class SearchTool {
  private static instance: SearchTool;

  private constructor() {}

  static getInstance(): SearchTool {
    if (!SearchTool.instance) {
      SearchTool.instance = new SearchTool();
    }
    return SearchTool.instance;
  }

  async search(query: string, maxResults: number = 5): Promise<Array<{ title: string; url: string; snippet: string }>> {
    if (!query || query.trim().length === 0) {
      return [];
    }

    // Try SearXNG public instances first (returns real search results)
    const searxngResults = await this.searchSearXNG(query, maxResults);
    if (searxngResults.length > 0) return searxngResults;

    // Fallback: DuckDuckGo HTML parsing
    const ddgResults = await this.searchDuckDuckGo(query, maxResults);
    if (ddgResults.length > 0) return ddgResults;

    logger.info('search', `Search: "${query}" → 0 results`);
    return [];
  }

  private async searchSearXNG(query: string, maxResults: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
    const instances = [
      'https://searx.be',
      'https://search.sapti.me',
      'https://searxng.ch',
    ];

    for (const instance of instances) {
      try {
        const response = await axios.get(`${instance}/search`, {
          params: { q: query, format: 'json', categories: 'general' },
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Atlas Agent)' },
        });

        const results = (response.data?.results || [])
          .slice(0, maxResults)
          .map((r: any) => ({
            title: r.title || '',
            url: r.url || '',
            snippet: r.content || '',
          }))
          .filter((r: any) => r.title && r.url);

        if (results.length > 0) {
          logger.info('search', `SearXNG (${instance}): "${query}" → ${results.length} results`);
          return results;
        }
      } catch {
        // Try next instance
      }
    }
    return [];
  }

  private async searchDuckDuckGo(query: string, maxResults: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
    try {
      const response = await axios.get('https://html.duckduckgo.com/html/', {
        params: { q: query },
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        responseType: 'text',
      });

      const html = response.data;
      if (typeof html !== 'string') return [];

      const results: Array<{ title: string; url: string; snippet: string }> = [];
      const resultRegex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;

      while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
        const url = this.decodeHtml(match[1]);
        const title = this.stripTags(match[2]).trim();
        const snippet = this.stripTags(match[3]).trim();
        if (url && title) {
          results.push({ title, url, snippet: snippet || title });
        }
      }

      // Fallback: simpler regex if the first one didn't match
      if (results.length === 0) {
        const simpleRegex = /class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
        while ((match = simpleRegex.exec(html)) !== null && results.length < maxResults) {
          const url = this.decodeHtml(match[1]);
          const title = this.stripTags(match[2]).trim();
          if (url && title && url.startsWith('http')) {
            results.push({ title, url, snippet: title });
          }
        }
      }

      logger.info('search', `DuckDuckGo HTML: "${query}" → ${results.length} results`);
      return results;
    } catch (err) {
      logger.error('search', `DuckDuckGo HTML failed: ${err}`);
      return [];
    }
  }

  private stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }

  private decodeHtml(html: string): string {
    return this.stripTags(html);
  }
}

export const searchTool = SearchTool.getInstance();
