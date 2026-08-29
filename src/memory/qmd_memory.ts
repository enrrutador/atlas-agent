/**
 * Atlas QMD Memory - Daily memory logs with vector indexing
 * QMD = Quick Memory Directory
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../common/logger.js';

const MAX_RETENTION_DAYS = 120;

export class QMDMemory {
  private static instance: QMDMemory;
  private workspaceDir: string;
  private memoryDir: string;
  private indexPath: string;
  private index: any = null;

  private constructor() {
    this.workspaceDir = path.join(process.cwd(), 'workspace');
    this.memoryDir = path.join(this.workspaceDir, 'memory');
    this.indexPath = path.join(process.cwd(), 'data', 'memory_index');
    this.ensureDirectories();
    this.initIndex().catch(() => {});
  }

  static getInstance(): QMDMemory {
    if (!QMDMemory.instance) {
      QMDMemory.instance = new QMDMemory();
    }
    return QMDMemory.instance;
  }

  private ensureDirectories(): void {
    [this.workspaceDir, this.memoryDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  private async initIndex(): Promise<void> {
    try {
      if (!fs.existsSync(this.indexPath)) {
        fs.mkdirSync(this.indexPath, { recursive: true });
      }
      // @ts-ignore - vectra is optional
      const vectra = await import('vectra');
      const LocalIndex = vectra.LocalIndex;
      this.index = new LocalIndex(this.indexPath);
      if (!await this.index.isIndexCreated()) {
        await this.index.createIndex();
      }
      logger.info('qmd_memory', 'Vector index initialized');
    } catch {
      logger.warn('qmd_memory', 'Vectra not available — vector search disabled, using file-based search only');
      this.index = null;
    }
  }

  logEntry(content: string, tags: string[] = []): void {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timestamp = now.toISOString();
    const filename = path.join(this.memoryDir, `${dateStr}.md`);

    let entry = `\n## ${timestamp}\n${content}\n`;
    if (tags.length > 0) {
      entry += `Tags: ${tags.join(', ')}\n`;
    }

    if (fs.existsSync(filename)) {
      fs.appendFileSync(filename, entry);
    } else {
      fs.writeFileSync(filename, `# Memory Log - ${dateStr}\n${entry}`);
    }

    this.indexEntry(content, dateStr, tags).catch(() => {});
  }

  private async indexEntry(content: string, date: string, tags: string[]): Promise<void> {
    if (!this.index) return;

    try {
      const embedding = this.simpleEmbed(content);
      await this.index.insertItem({
        vector: embedding,
        metadata: {
          content: content.slice(0, 1000),
          date,
          tags: tags.join(','),
          timestamp: Date.now(),
        },
      });
    } catch {
      // Silently fail - daily file is primary storage
    }
  }

  private simpleEmbed(text: string): number[] {
    const words = text.toLowerCase().split(/\s+/);
    const embedding = new Array(128).fill(0);
    words.forEach((word) => {
      const hash = this.hashString(word) % 128;
      embedding[hash] += 1;
    });
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    return embedding.map(v => magnitude > 0 ? v / magnitude : 0);
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  searchRecent(query: string, days: number = 7): string {
    const results: string[] = [];
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const filename = path.join(this.memoryDir, `${dateStr}.md`);

      if (fs.existsSync(filename)) {
        const content = fs.readFileSync(filename, 'utf-8');
        if (content.toLowerCase().includes(query.toLowerCase())) {
          results.push(`[${dateStr}]\n${content.slice(0, 1500)}`);
        }
      }
    }

    return results.join('\n---\n').slice(0, 3000);
  }

  getCuratedMemory(): string {
    const memoryFile = path.join(this.workspaceDir, 'MEMORY.md');
    if (fs.existsSync(memoryFile)) {
      return fs.readFileSync(memoryFile, 'utf-8').slice(0, 2000);
    }
    return '';
  }

  getContextForPrompt(userMessage: string): string {
    const curated = this.getCuratedMemory();
    const recent = this.searchRecent(userMessage, 3);
    let context = '';
    if (curated) context += `## Curated Memory\n${curated}\n\n`;
    if (recent) context += `## Recent Activity\n${recent}\n\n`;
    return context;
  }

  storeFact(fact: string, layer: string = 'semantic'): void {
    this.logEntry(`[${layer.toUpperCase()}] ${fact}`, [layer]);
    if (layer === 'critical' || layer === 'user_preference') {
      this.updateCuratedMemory(fact);
    }
  }

  private updateCuratedMemory(fact: string): void {
    const memoryFile = path.join(this.workspaceDir, 'MEMORY.md');
    const timestamp = new Date().toISOString().split('T')[0];
    const entry = `\n- [${timestamp}] ${fact}`;
    if (fs.existsSync(memoryFile)) {
      fs.appendFileSync(memoryFile, entry);
    }
  }

  cleanupOldEntries(): void {
    const today = new Date();
    const archiveDir = path.join(this.workspaceDir, 'archive', 'memory');

    try {
      const files = fs.readdirSync(this.memoryDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const filePath = path.join(this.memoryDir, file);
        const stats = fs.statSync(filePath);
        const ageDays = (today.getTime() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);

        if (ageDays > MAX_RETENTION_DAYS) {
          if (!fs.existsSync(archiveDir)) {
            fs.mkdirSync(archiveDir, { recursive: true });
          }
          fs.renameSync(filePath, path.join(archiveDir, file));
          logger.info('qmd_memory', `Archived old memory: ${file}`);
        }
      }
    } catch (err) {
      logger.error('qmd_memory', `Cleanup failed: ${err}`);
    }
  }

  trackMessage(_index: number): void {
    // no-op: kept for API compat
  }
}

export const qmdMemory = QMDMemory.getInstance();
