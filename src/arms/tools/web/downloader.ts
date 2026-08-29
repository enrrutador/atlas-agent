import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { logger } from '../../../common/logger.js';
import { DownloadResult, DownloadProgress, DownloadOptions, BatchDownloadOptions } from './types.js';

interface QueueItem {
  id: string;
  url: string;
  destPath: string;
  fileName: string;
  resolve: (result: DownloadResult) => void;
  opts: DownloadOptions;
}

export class DownloadManager {
  private queue: QueueItem[] = [];
  private active = 0;
  private maxConcurrent = 3;
  private downloadMap = new Map<string, { abort: () => void; status: DownloadProgress['status'] }>();

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, n);
  }

  async download(url: string, destDir: string, options: DownloadOptions = {}): Promise<DownloadResult> {
    const fileName = options.fileName || path.basename(new URL(url).pathname) || 'download';
    const destPath = path.resolve(destDir, fileName);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise<DownloadResult>((resolve) => {
      this.queue.push({ id, url, destPath, fileName, resolve, opts: options });
      this.processQueue();
    });
  }

  async downloadBatch(items: { url: string; fileName?: string }[], options: BatchDownloadOptions): Promise<DownloadResult[]> {
    const maxConcurrent = options.maxConcurrent || this.maxConcurrent;
    this.setMaxConcurrent(maxConcurrent);

    const promises = items.map(item =>
      this.download(item.url, options.destDir, {
        fileName: item.fileName,
        timeout: options.timeout,
        retries: options.retries,
      })
    );

    return Promise.all(promises);
  }

  getProgress(id: string): DownloadProgress | null {
    const entry = this.downloadMap.get(id);
    if (!entry) return null;
    return {
      id,
      url: '',
      destPath: '',
      received: 0,
      total: 0,
      percent: 0,
      speedBps: 0,
      status: entry.status,
    };
  }

  pause(id: string): void {
    const entry = this.downloadMap.get(id);
    if (entry && entry.status === 'downloading') {
      entry.abort();
      entry.status = 'paused';
    }
  }

  cancel(id: string): void {
    const entry = this.downloadMap.get(id);
    if (entry) {
      entry.abort();
      entry.status = 'error';
    }
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get activeCount(): number {
    return this.active;
  }

  private async processQueue(): Promise<void> {
    while (this.queue.length > 0 && this.active < this.maxConcurrent) {
      const item = this.queue.shift()!;
      this.active++;
      this.executeDownload(item).finally(() => {
        this.active--;
        this.processQueue();
      });
    }
  }

  private async executeDownload(item: QueueItem): Promise<void> {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = item.opts.timeout || 60_000;
    const retries = item.opts.retries ?? 3;

    this.downloadMap.set(item.id, {
      abort: () => controller.abort(),
      status: 'downloading',
    });

    let lastError: string | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          logger.info('downloader', `Retry ${attempt}/${retries} for ${item.url} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        }

        // Ensure dest dir exists
        fs.mkdirSync(path.dirname(item.destPath), { recursive: true });

        const res = await axios.get(item.url, {
          responseType: 'stream',
          timeout,
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          },
        });

        const writer = fs.createWriteStream(item.destPath);
        let received = 0;

        res.data.on('data', (chunk: Buffer) => {
          received += chunk.length;
        });

        await new Promise<void>((resolve, reject) => {
          res.data.pipe(writer);
          writer.on('finish', () => {
            const elapsed = Date.now() - startTime;
            const result: DownloadResult = {
              url: item.url,
              destPath: item.destPath,
              fileName: item.fileName,
              fileSize: received,
              elapsedMs: elapsed,
              success: true,
            };
            this.downloadMap.set(item.id, { abort: () => {}, status: 'completed' });
            item.resolve(result);
            resolve();
          });
          writer.on('error', (err) => {
            writer.close();
            reject(err);
          });
        });

        return; // Success
      } catch (err: any) {
        if (controller.signal.aborted) {
          lastError = 'Cancelado';
          break;
        }
        lastError = err.message || 'Error de descarga';
        logger.warn('downloader', `Attempt ${attempt + 1} failed: ${lastError?.slice(0, 100)}`);
        // Clean up partial file
        try { fs.unlinkSync(item.destPath); } catch {}
      }
    }

    const result: DownloadResult = {
      url: item.url,
      destPath: item.destPath,
      fileName: item.fileName,
      fileSize: 0,
      elapsedMs: Date.now() - startTime,
      success: false,
      error: lastError,
    };
    this.downloadMap.set(item.id, { abort: () => {}, status: 'error' });
    item.resolve(result);
  }
}

export const downloadManager = new DownloadManager();
