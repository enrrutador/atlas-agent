/**
 * Atlas Browser Tool - Web navigation and scraping
 * Cross-platform: uses Playwright for headless browsing (optional)
 */

import { logger } from '../../common/logger.js';

export class BrowserTool {
  private static instance: BrowserTool;
  private browser: any = null;
  private playwrightAvailable: boolean | null = null;

  private constructor() {}

  static getInstance(): BrowserTool {
    if (!BrowserTool.instance) {
      BrowserTool.instance = new BrowserTool();
    }
    return BrowserTool.instance;
  }

  private async getPlaywright(): Promise<any> {
    if (this.playwrightAvailable === false) {
      return null;
    }
    try {
      // @ts-ignore - playwright is an optional dependency
      const pw = await import('playwright');
      this.playwrightAvailable = true;
      return pw;
    } catch {
      this.playwrightAvailable = false;
      logger.warn('browser', 'Playwright not installed — browser tool unavailable. Install: npm install playwright && npx playwright install chromium');
      return null;
    }
  }

  isAvailable(): boolean {
    return this.playwrightAvailable === true;
  }

  async navigate(url: string): Promise<{ title: string; content: string }> {
    const pw = await this.getPlaywright();
    if (!pw) {
      return { title: 'Playwright not available', content: `Cannot navigate to ${url} — Playwright is not installed. Run: npm install playwright && npx playwright install chromium` };
    }
    try {
      if (!this.browser) {
        this.browser = await pw.chromium.launch({ headless: true });
      }
      const page = await this.browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const title = await page.title();
      const content = await page.content();
      await page.close();
      logger.info('browser', `Navigated to: ${url}`);
      return { title, content };
    } catch (err) {
      logger.error('browser', `Navigation failed: ${err}`);
      throw err;
    }
  }

  async extractText(url: string): Promise<string> {
    const pw = await this.getPlaywright();
    if (!pw) {
      return `Cannot extract text from ${url} — Playwright is not installed. Run: npm install playwright && npx playwright install chromium`;
    }
    try {
      if (!this.browser) {
        this.browser = await pw.chromium.launch({ headless: true });
      }
      const page = await this.browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const text = await page.innerText('body');
      await page.close();
      logger.info('browser', `Extracted text from: ${url}`);
      return text;
    } catch (err) {
      logger.error('browser', `Text extraction failed: ${err}`);
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

export const browserTool = BrowserTool.getInstance();
