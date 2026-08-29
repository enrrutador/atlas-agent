/**
 * Atlas Forge Memory - Specialized memory for Forge reasoning
 * Stores: past decisions, reasoning chains, learned patterns, proposals
 */

import { logger } from '../../common/logger.js';
import { generateId } from '../../common/utils.js';
import { atlasDB } from '../../memory/atlas_db.js';

export interface ForgeMemoryEntry {
  id: string;
  type: 'decision' | 'reasoning' | 'pattern' | 'proposal';
  input: string;
  output: string;
  confidence: number;
  tags: string[];
  createdAt: number;
}

export class ForgeMemory {
  private static instance: ForgeMemory;
  private localCache: Map<string, ForgeMemoryEntry> = new Map();
  private maxCacheSize = 200;

  private constructor() {}

  static getInstance(): ForgeMemory {
    if (!ForgeMemory.instance) {
      ForgeMemory.instance = new ForgeMemory();
    }
    return ForgeMemory.instance;
  }

  async store(entry: Omit<ForgeMemoryEntry, 'id' | 'createdAt'>): Promise<string> {
    const id = generateId('fmem');
    const record: ForgeMemoryEntry = {
      ...entry,
      id,
      createdAt: Date.now(),
    };

    this.localCache.set(id, record);

    try {
      atlasDB.exec(
        `CREATE TABLE IF NOT EXISTS forge_memory (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          input TEXT NOT NULL,
          output TEXT NOT NULL,
          confidence REAL,
          tags TEXT,
          created_at INTEGER
        )`
      );
      atlasDB.run(
        `INSERT INTO forge_memory (id, type, input, output, confidence, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, entry.type, entry.input, entry.output, entry.confidence, entry.tags.join(','), record.createdAt]
      );
    } catch (err) {
      logger.warn('forge_memory', `DB persist failed, using cache only: ${err}`);
    }

    // Evict old entries if cache is full
    if (this.localCache.size > this.maxCacheSize) {
      const oldest = Array.from(this.localCache.entries())
        .sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) this.localCache.delete(oldest[0]);
    }

    logger.info('forge_memory', `Stored: ${id} (${entry.type})`);
    return id;
  }

  async search(query: string, limit: number = 5): Promise<ForgeMemoryEntry[]> {
    const results: ForgeMemoryEntry[] = [];
    const lower = query.toLowerCase();

    for (const entry of this.localCache.values()) {
      if (entry.input.toLowerCase().includes(lower) || entry.output.toLowerCase().includes(lower)) {
        results.push(entry);
      }
      if (results.length >= limit) break;
    }

    // Sort by confidence
    results.sort((a, b) => b.confidence - a.confidence);
    return results;
  }

  async getSimilar(input: string): Promise<ForgeMemoryEntry | null> {
    const results = await this.search(input, 1);
    return results[0] || null;
  }
}

export const forgeMemory = ForgeMemory.getInstance();
