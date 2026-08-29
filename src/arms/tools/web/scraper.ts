import axios from 'axios';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { logger } from '../../../common/logger.js';
import { ScrapeResult, ScrapeOptions } from './types.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
}

export class Scraper {
  async scrape(url: string, options: ScrapeOptions = {}): Promise<ScrapeResult> {
    const depth = options.depth || 'full';
    const extractLinks = options.extractLinks ?? true;

    const html = await this.fetchHtml(url);
    if (!html) {
      throw new Error(`No se pudo obtener contenido de ${url}`);
    }

    const baseResult: Partial<ScrapeResult> = {
      url,
      images: [],
      links: [],
      jsonLd: [],
      ogTags: {},
      metaTags: {},
    };

    // Tier 1: Mozilla Readability
    if (depth === 'full') {
      try {
      const readabilityResult = this.extractWithReadability(html, url);
      if (readabilityResult && readabilityResult.content && readabilityResult.content.length > 200) {
          Object.assign(baseResult, readabilityResult);
        }
      } catch (err) {
        logger.warn('scraper', `Readability failed for ${url}: ${err}`);
      }
    }

    // Tier 2: Cheerio heuristics (always runs for metadata and fallback)
    try {
      const cheerioResult = this.extractWithCheerio(html, url, extractLinks);
      // Use Cheerio content if Readability didn't produce enough
      if (!baseResult.content || baseResult.content.length < 100) {
        Object.assign(baseResult, cheerioResult);
      } else {
        // Merge metadata from Cheerio into Readability result
        baseResult.images = cheerioResult.images;
        baseResult.links = cheerioResult.links;
        baseResult.jsonLd = cheerioResult.jsonLd;
        baseResult.ogTags = cheerioResult.ogTags;
        baseResult.metaTags = cheerioResult.metaTags;
        baseResult.lang = cheerioResult.lang || baseResult.lang;
      }
    } catch (err) {
      logger.warn('scraper', `Cheerio extraction failed for ${url}: ${err}`);
    }

    if (!baseResult.content || baseResult.content.trim().length === 0) {
      throw new Error(`No se pudo extraer contenido de ${url}`);
    }

    return {
      url: baseResult.url!,
      title: baseResult.title || '',
      content: baseResult.content!,
      excerpt: baseResult.excerpt || baseResult.content!.slice(0, 300),
      textLength: baseResult.content!.length,
      byline: baseResult.byline,
      siteName: baseResult.siteName,
      lang: baseResult.lang,
      publishedDate: baseResult.publishedDate,
      images: baseResult.images || [],
      links: baseResult.links || [],
      jsonLd: baseResult.jsonLd || [],
      ogTags: baseResult.ogTags || {},
      metaTags: baseResult.metaTags || {},
    };
  }

  async scrapeBatch(urls: string[], options: ScrapeOptions = {}): Promise<ScrapeResult[]> {
    const results: ScrapeResult[] = [];
    for (const url of urls) {
      try {
        const result = await this.scrape(url, options);
        results.push(result);
      } catch (err) {
        logger.error('scraper', `Batch scrape failed for ${url}: ${err}`);
      }
    }
    return results;
  }

  private async fetchHtml(url: string): Promise<string | null> {
    try {
      const res = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        },
        responseType: 'text',
        maxRedirects: 5,
      });

      if (typeof res.data === 'string' && res.data.length > 0) {
        return res.data;
      }
    } catch (err: any) {
      logger.warn('scraper', `Fetch failed for ${url}: ${err.message?.slice(0, 100)}`);
    }
    return null;
  }

  private extractWithReadability(html: string, pageUrl: string): Partial<ScrapeResult> | null {
    const dom = new JSDOM(html, { url: pageUrl });
    const doc = dom.window.document;

    // Clean non-content elements before Readability
    for (const sel of ['script', 'style', 'noscript', 'iframe', 'nav', 'footer', 'header', '.advertisement', '.ad', '.sidebar', '.menu', '.nav']) {
      try {
        doc.querySelectorAll(sel).forEach(el => el.remove());
      } catch {
        // continue
      }
    }

    const article = new Readability(doc).parse();
    if (!article) return null;

    return {
      title: article.title || '',
      content: article.textContent?.trim() || '',
      excerpt: article.excerpt?.trim() || '',
      byline: article.byline || undefined,
      publishedDate: article.publishedTime || undefined,
      siteName: this.extractSiteName(html),
    };
  }

  private extractWithCheerio(html: string, _url: string, extractLinks: boolean): Partial<ScrapeResult> {
    const $ = cheerio.load(html);

    // 1. Remove non-content elements
    $('script, style, noscript, iframe, nav, footer, header, .advertisement, .ad, .sidebar, .menu, .nav, [role="navigation"]').remove();

    // 2. Title
    const title = $('title').first().text().trim()
      || $('h1').first().text().trim()
      || $('meta[property="og:title"]').attr('content')?.trim()
      || '';

    // 3. Content: search for main containers
    let contentText = '';
    const containers = $('article, main, [role="main"], .content, #content, .post, .entry, .article');
    const container = containers.first();
    if (container.length) {
      contentText = container.text().trim();
    } else if ($('body').length) {
      // Fallback: body text minus nav/footer
      contentText = $('body').text().trim();
    }

    // Clean whitespace
    contentText = contentText.replace(/\s+/g, ' ').trim();

    // 4. Metadata extraction
    const ogTags: Record<string, string> = {};
    $('meta[property^="og:"]').each((_i, el) => {
      const prop = $(el).attr('property')?.replace('og:', '') || '';
      const content = $(el).attr('content') || '';
      if (prop && content) ogTags[prop] = content;
    });

    const metaTags: Record<string, string> = {};
    $('meta[name]').each((_i, el) => {
      const name = $(el).attr('name') || '';
      const content = $(el).attr('content') || '';
      if (name && content) metaTags[name] = content;
    });

    // 5. JSON-LD
    const jsonLd: any[] = [];
    $('script[type="application/ld+json"]').each((_i, el) => {
      try {
        const parsed = JSON.parse($(el).html() || '');
        jsonLd.push(parsed);
      } catch {
        // skip invalid JSON
      }
    });

    // 6. Images
    const images: string[] = [];
    $('img[src]').each((_i, el) => {
      const src = $(el).attr('src') || '';
      if (src.startsWith('http')) images.push(src);
    });

    // 7. Links
    const links: { href: string; text: string }[] = [];
    if (extractLinks) {
      $('a[href]').each((_i, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().trim().slice(0, 100);
        if (href.startsWith('http') && text) {
          links.push({ href, text });
        }
      });
    }

    return {
      title: decodeEntities(title),
      content: decodeEntities(contentText),
      excerpt: decodeEntities(contentText.slice(0, 300)),
      images,
      links,
      jsonLd,
      ogTags,
      metaTags,
      lang: $('html').attr('lang') || undefined,
      siteName: ogTags.site_name || metaTags.application_name || undefined,
    };
  }

  private extractSiteName(html: string): string | undefined {
    const match = html.match(/<meta[^>]+property="og:site_name"[^>]+content="([^"]+)"/i);
    return match?.[1] || undefined;
  }
}

export const scraper = new Scraper();
