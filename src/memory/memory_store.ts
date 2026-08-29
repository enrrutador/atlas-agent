/**
 * Atlas Memory Store - Abstraction over AtlasDB
 * Provides high-level memory operations for all modules
 */

import { atlasDB } from './atlas_db.js';
import { logger } from '../common/logger.js';
import { MemoryEntry } from '../common/types.js';
import { generateId } from '../common/utils.js';

export class MemoryStore {
  private static instance: MemoryStore;
  private totalEntries = 0;

  private constructor() {}

  static getInstance(): MemoryStore {
    if (!MemoryStore.instance) {
      MemoryStore.instance = new MemoryStore();
    }
    return MemoryStore.instance;
  }

  async store(content: string, layer: MemoryEntry['layer'] = 'semantic', source: string = ''): Promise<string> {
    const id = generateId();
    try {
      atlasDB.run('INSERT INTO memories (id, content, layer, source) VALUES (?, ?, ?, ?)', [id, content, layer, source]);
      this.totalEntries++;
      logger.debug('memory_store', `Stored memory [${layer}]: ${content.slice(0, 60)}...`);
      return id;
    } catch (err) {
      logger.error('memory_store', `Failed to store memory: ${err}`);
      throw err;
    }
  }

  async retrieve(id: string): Promise<MemoryEntry | null> {
    try {
      const row = atlasDB.get('SELECT * FROM memories WHERE id = ?', [id]);
      if (!row) return null;

      atlasDB.run('UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?', [Date.now(), id]);

      return this.rowToMemoryEntry(row);
    } catch (err) {
      logger.error('memory_store', `Failed to retrieve memory: ${err}`);
      return null;
    }
  }

  async search(query: string, limit: number = 10): Promise<MemoryEntry[]> {
    try {
      const rows = atlasDB.all(
        "SELECT * FROM memories WHERE content LIKE ? ORDER BY accessed_at DESC LIMIT ?",
        [`%${query}%`, limit]
      );
      return rows.map(row => this.rowToMemoryEntry(row));
    } catch (err) {
      logger.error('memory_store', `Failed to search memories: ${err}`);
      return [];
    }
  }

  async getByLayer(layer: MemoryEntry['layer'], limit: number = 50): Promise<MemoryEntry[]> {
    try {
      const rows = atlasDB.all(
        'SELECT * FROM memories WHERE layer = ? ORDER BY created_at DESC LIMIT ?',
        [layer, limit]
      );
      return rows.map(row => this.rowToMemoryEntry(row));
    } catch (err) {
      logger.error('memory_store', `Failed to get memories by layer: ${err}`);
      return [];
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      atlasDB.run('DELETE FROM memories WHERE id = ?', [id]);
      this.totalEntries--;
      logger.debug('memory_store', `Deleted memory: ${id}`);
      return true;
    } catch (err) {
      logger.error('memory_store', `Failed to delete memory: ${err}`);
      return false;
    }
  }

  async getStats(): Promise<{ total: number }> {
    try {
      const result = atlasDB.get('SELECT COUNT(*) as count FROM memories');
      this.totalEntries = result?.count || 0;
    } catch {
      // DB not ready yet
    }
    return { total: this.totalEntries };
  }

  stats(): { total: number } {
    return { total: this.totalEntries };
  }

  private rowToMemoryEntry(row: any): MemoryEntry {
    return {
      id: row.id,
      content: row.content,
      layer: row.layer,
      source: row.source || '',
      tags: row.tags ? row.tags.split(',') : [],
      createdAt: row.created_at,
      accessedAt: row.accessed_at,
      accessCount: row.access_count,
    };
  }
}

export const memoryStore = MemoryStore.getInstance();
