/**
 * Atlas TUI Logs Panel - Real-time log viewer for the terminal UI
 * Subscribes to Logger events and displays them in a scrollable panel
 */

import { logger, LogEntry } from '../../common/logger.js';
import { EventEmitter } from 'events';

export class LogsPanel extends EventEmitter {
  private static instance: LogsPanel;
  private entries: LogEntry[] = [];
  private maxEntries = 1000;
  private active = false;
  private filter?: string;
  private minLevel: LogEntry['level'] = 'info';

  private constructor() {
    super();
    this.subscribe();
  }

  static getInstance(): LogsPanel {
    if (!LogsPanel.instance) {
      LogsPanel.instance = new LogsPanel();
    }
    return LogsPanel.instance;
  }

  private subscribe(): void {
    logger.on('log', (entry: LogEntry) => {
      if (!this.active) return;
      if (this.shouldFilter(entry)) return;

      this.entries.push(entry);
      if (this.entries.length > this.maxEntries) {
        this.entries = this.entries.slice(-this.maxEntries);
      }

      this.emit('update', this.formatEntry(entry));
    });
  }

  activate(): void {
    this.active = true;
  }

  deactivate(): void {
    this.active = false;
  }

  setFilter(source?: string): void {
    this.filter = source;
  }

  setMinLevel(level: LogEntry['level']): void {
    this.minLevel = level;
  }

  getRecent(count: number = 50): LogEntry[] {
    return this.entries.slice(-count);
  }

  getFiltered(count: number = 50): LogEntry[] {
    let filtered = this.entries;
    if (this.filter) {
      filtered = filtered.filter(e => e.source === this.filter);
    }
    return filtered.slice(-count);
  }

  clear(): void {
    this.entries = [];
    this.emit('clear');
  }

  formatEntry(entry: LogEntry): string {
    const time = new Date(entry.timestamp).toISOString().slice(11, 19);
    const levelColors: Record<string, string> = {
      debug: '\x1b[36m',
      info: '\x1b[32m',
      warn: '\x1b[33m',
      error: '\x1b[31m',
      critical: '\x1b[35m',
    };
    const reset = '\x1b[0m';
    const color = levelColors[entry.level] || '';
    return `${time} ${color}[${entry.level.toUpperCase()}]${reset} ${entry.source}: ${entry.message}`;
  }

  getStats(): { total: number; byLevel: Record<string, number>; bySource: Record<string, number> } {
    const byLevel: Record<string, number> = {};
    const bySource: Record<string, number> = {};

    for (const entry of this.entries) {
      byLevel[entry.level] = (byLevel[entry.level] || 0) + 1;
      bySource[entry.source] = (bySource[entry.source] || 0) + 1;
    }

    return { total: this.entries.length, byLevel, bySource };
  }

  private shouldFilter(entry: LogEntry): boolean {
    if (this.filter && entry.source !== this.filter) return true;
    const levels: LogEntry['level'][] = ['debug', 'info', 'warn', 'error', 'critical'];
    const currentIdx = levels.indexOf(this.minLevel);
    const entryIdx = levels.indexOf(entry.level);
    return entryIdx < currentIdx;
  }
}

export const logsPanel = LogsPanel.getInstance();
