/**
 * Atlas Session DB - Chat session persistence
 * Stores conversation history per chat ID
 */

import { atlasDB } from './atlas_db.js';
import { logger } from '../common/logger.js';
import { Message } from '../common/types.js';

const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export class SessionDB {
  private static instance: SessionDB;
  private pruneTimer: NodeJS.Timeout | null = null;

  private constructor() {}

  static getInstance(): SessionDB {
    if (!SessionDB.instance) {
      SessionDB.instance = new SessionDB();
    }
    return SessionDB.instance;
  }

  async getSession(chatId: string): Promise<{ messages: Message[] }> {
    try {
      const row = atlasDB.get('SELECT history FROM sessions WHERE chat_id = ?', [chatId]);
      if (row?.history) {
        return { messages: JSON.parse(row.history) };
      }
    } catch (err) {
      logger.error('session_db', `Failed to load session ${chatId}: ${err}`);
    }
    return { messages: [] };
  }

  async saveSession(chatId: string, messages: Message[]): Promise<void> {
    try {
      const historyJson = JSON.stringify(messages);
      atlasDB.run(
        `INSERT INTO sessions (chat_id, history, updated_at, msg_count)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_id)
        DO UPDATE SET history = ?, updated_at = ?, msg_count = ?`,
        [chatId, historyJson, Date.now(), messages.length, historyJson, Date.now(), messages.length]
      );
    } catch (err) {
      logger.error('session_db', `Failed to save session ${chatId}: ${err}`);
    }
  }

  clear(chatId: string): void {
    try {
      atlasDB.run('DELETE FROM sessions WHERE chat_id = ?', [chatId]);
      logger.info('session_db', `Cleared session: ${chatId}`);
    } catch (err) {
      logger.error('session_db', `Failed to clear session ${chatId}: ${err}`);
    }
  }

  startPruneCycle(): void {
    this.pruneTimer = setInterval(() => {
      this.prune();
    }, PRUNE_INTERVAL_MS);
    logger.info('session_db', 'Prune cycle started (24h interval)');
  }

  private prune(): void {
    try {
      const cutoff = Date.now() - MAX_SESSION_AGE_MS;
      atlasDB.run('DELETE FROM sessions WHERE updated_at < ?', [cutoff]);
      logger.info('session_db', 'Pruned old sessions');
    } catch (err) {
      logger.error('session_db', `Failed to prune sessions: ${err}`);
    }
  }

  stopPruneCycle(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }
}

export const sessionDB = SessionDB.getInstance();
