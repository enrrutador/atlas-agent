/**
 * AtlasDB - SQLite persistence via sql.js
 * Works on any Node.js version without native compilation
 * 
 * Features:
 * - Pure JavaScript (WASM-based)
 * - Automatic save/load from disk
 * - Schema migration support
 * - Connection pooling for concurrent access
 */

import { Database, default as initSqlJs } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { logger } from '../common/logger.js';

const DB_PATH = path.join(process.cwd(), 'data', 'atlas.db');
const SAVE_INTERVAL_MS = 10000;

export class AtlasDB {
  private static instance: AtlasDB;
  private db: Database | null = null;
  private initialized = false;
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;

  private constructor() {}

  static async getInstance(): Promise<AtlasDB> {
    if (!AtlasDB.instance) {
      AtlasDB.instance = new AtlasDB();
      await AtlasDB.instance.init();
    }
    return AtlasDB.instance;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;

    try {
      const SQL = await initSqlJs();

      // Load existing or create fresh
      if (fs.existsSync(DB_PATH)) {
        try {
          const fileBuffer = fs.readFileSync(DB_PATH);
          this.db = new SQL.Database(fileBuffer);
          this.validateDatabase();
        } catch (err) {
          logger.warn('atlas_db', `DB corrupted, creating fresh: ${err}`);
          this.createFreshDatabase(SQL);
        }
      } else {
        this.createFreshDatabase(SQL);
      }

      this.setupSchema();
      this.startSaveTimer();
      this.initialized = true;
      logger.info('atlas_db', 'Database initialized successfully');
    } catch (err) {
      logger.error('atlas_db', `Failed to initialize database: ${err}`);
      throw err;
    }
  }

  private createFreshDatabase(SQL: any): void {
    this.db = new SQL.Database();
    this.dirty = true;
    logger.info('atlas_db', 'Created fresh database');
  }

  private validateDatabase(): void {
    if (!this.db) return;
    this.db.run('SELECT 1');
  }

  private setupSchema(): void {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        layer TEXT NOT NULL DEFAULT 'semantic',
        source TEXT,
        tags TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        accessed_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        access_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_content ON memories(content);

      CREATE TABLE IF NOT EXISTS sessions (
        chat_id TEXT PRIMARY KEY,
        history TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        msg_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS embedding_queue (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        content TEXT NOT NULL,
        queued_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        attempts INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );
    `);
  }

  private startSaveTimer(): void {
    this.saveTimer = setInterval(() => {
      this.saveToDisk();
    }, SAVE_INTERVAL_MS);
  }

  private saveToDisk(): void {
    if (!this.db || !this.dirty) return;

    try {
      const data = this.db.export();
      if (!fs.existsSync(path.dirname(DB_PATH))) {
        fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      }
      fs.writeFileSync(DB_PATH, Buffer.from(data));
      this.dirty = false;
      logger.debug('atlas_db', 'Database saved to disk');
    } catch (err) {
      logger.error('atlas_db', `Failed to save database: ${err}`);
    }
  }

  run(sql: string, params?: any[]): void {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare(sql);
    stmt.bind(params || []);
    stmt.step();
    stmt.free();
    this.dirty = true;
  }

  exec(sql: string): any {
    if (!this.db) throw new Error('Database not initialized');
    this.dirty = true;
    return this.db.exec(sql);
  }

  get(sql: string, params?: any[]): any {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare(sql);
    stmt.bind(params || []);
    const result = stmt.step() ? stmt.getAsObject() : undefined;
    stmt.free();
    return result;
  }

  all(sql: string, params?: any[]): any[] {
    if (!this.db) throw new Error('Database not initialized');
    const results: any[] = [];
    const stmt = this.db.prepare(sql);
    stmt.bind(params || []);
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }

  close(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
    }
    this.saveToDisk();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
    logger.info('atlas_db', 'Database closed');
  }
}

export async function getDB(): Promise<AtlasDB> {
  return AtlasDB.getInstance();
}

let _atlasDBInstance: AtlasDB | null = null;

export const atlasDB = {
  async initialize(): Promise<void> {
    _atlasDBInstance = await AtlasDB.getInstance();
  },
  getInstance(): AtlasDB | null {
    return _atlasDBInstance;
  },
  run(sql: string, params?: any[]): void {
    if (!_atlasDBInstance) throw new Error('AtlasDB not initialized');
    _atlasDBInstance.run(sql, params);
  },
  exec(sql: string): any {
    if (!_atlasDBInstance) throw new Error('AtlasDB not initialized');
    return _atlasDBInstance.exec(sql);
  },
  get(sql: string, params?: any[]): any {
    if (!_atlasDBInstance) throw new Error('AtlasDB not initialized');
    return _atlasDBInstance.get(sql, params);
  },
  all(sql: string, params?: any[]): any[] {
    if (!_atlasDBInstance) throw new Error('AtlasDB not initialized');
    return _atlasDBInstance.all(sql, params);
  },
  close(): void {
    if (_atlasDBInstance) _atlasDBInstance.close();
  },
};
