/**
 * Atlas Monitor - Error tracking and alerting
 * Logs errors to file and optionally notifies admin via Telegram
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../common/logger.js';

const ERROR_LOG_PATH = path.join(process.cwd(), 'data', 'error_log.json');

export class Monitor {
  private static instance: Monitor;
  private enabled = true;

  private constructor() {
    if (!fs.existsSync(ERROR_LOG_PATH)) {
      fs.writeFileSync(ERROR_LOG_PATH, JSON.stringify([]));
    }
  }

  static getInstance(): Monitor {
    if (!Monitor.instance) {
      Monitor.instance = new Monitor();
    }
    return Monitor.instance;
  }

  logError(type: string, error: Error | string): void {
    if (!this.enabled) return;

    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : undefined;

    logger.error('monitor', `${type}: ${errMsg}`);

    try {
      const logs = JSON.parse(fs.readFileSync(ERROR_LOG_PATH, 'utf-8'));
      logs.push({
        type,
        message: errMsg,
        stack: errStack,
        timestamp: Date.now(),
      });
      fs.writeFileSync(ERROR_LOG_PATH, JSON.stringify(logs.slice(-100), null, 2));
    } catch (err) {
      logger.error('monitor', `Failed to write error log: ${err}`);
    }

    this.notifyAdmin(type, errMsg);
  }

  private async notifyAdmin(type: string, errorMsg: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.ADMIN_CHAT_ID;
    if (!token || !chatId) return;

    try {
      const https = await import('https');
      const data = JSON.stringify({
        chat_id: chatId,
        text: `Atlas Error Report\n\nType: ${type}\nMessage: ${errorMsg.slice(0, 500)}`,
      });

      const req = https.request({
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
        },
      });
      req.write(data);
      req.end();
    } catch {
      // Silent fail - don't create error loops
    }
  }

  getRecentErrors(limit: number = 10): any[] {
    try {
      return JSON.parse(fs.readFileSync(ERROR_LOG_PATH, 'utf-8')).slice(-limit);
    } catch {
      return [];
    }
  }

  enable(): void { this.enabled = true; }
  disable(): void { this.enabled = false; }
}

export const monitor = Monitor.getInstance();
