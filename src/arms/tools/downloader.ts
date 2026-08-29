/**
 * Atlas Downloader Tool - File download from URLs
 * Cross-platform: macOS, Linux, Windows
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { logger } from '../../common/logger.js';
import { toolGuardian } from '../../shield/tool_guardian.js';

export class DownloaderTool {
  private static instance: DownloaderTool;
  private downloadDir: string;

  private constructor() {
    this.downloadDir = path.join(process.cwd(), 'data', 'downloads');
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  static getInstance(): DownloaderTool {
    if (!DownloaderTool.instance) {
      DownloaderTool.instance = new DownloaderTool();
    }
    return DownloaderTool.instance;
  }

  async download(url: string, filename?: string): Promise<string> {
    const guard = toolGuardian.canUseTool('download_file');
    if (!guard.allowed) {
      throw new Error(guard.reason || 'Download not allowed');
    }

    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 60000,
      });

      const finalName = filename || path.basename(new URL(url).pathname) || `download_${Date.now()}`;
      const savePath = path.join(this.downloadDir, finalName);

      fs.writeFileSync(savePath, response.data);
      logger.info('downloader', `Downloaded: ${url} → ${savePath}`);
      return savePath;
    } catch (err) {
      logger.error('downloader', `Download failed: ${err}`);
      throw err;
    }
  }
}

export const downloaderTool = DownloaderTool.getInstance();
