/**
 * Atlas Logger - Centralized logging system
 * Multiplatform: macOS, Linux, Windows, iOS, Android
 * 
 * Features:
 * - Multiple log levels (debug, info, warn, error, critical)
 * - Source tracking (brain, forge, shield, arms, interfaces, system)
 * - Real-time event emission for TUI integration
 * - File persistence with daily rotation
 * - Export in JSON or plain text
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { LogEntry } from './types.js';

export type { LogEntry };

export class Logger extends EventEmitter {
  private static instance: Logger;
  private logDir: string;
  private currentFile: string;
  private maxFileSize: number = 10 * 1024 * 1024; // 10MB
  private logLevels = ['debug', 'info', 'warn', 'error', 'critical'] as const;
  private currentLevel: number = 1; // info by default

  private constructor() {
    super();
    this.logDir = path.join(process.cwd(), 'data', 'logs');
    this.ensureDirectory();
    this.currentFile = this.getLogFilePath();
    this.setupExitHandlers();
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private getLogFilePath(): string {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.logDir, `atlas_${date}.log`);
  }

  private setupExitHandlers(): void {
    const flush = () => {
      this.emit('flush');
    };
    process.on('exit', flush);
    process.on('SIGINT', () => { flush(); process.exit(0); });
    process.on('SIGTERM', () => { flush(); process.exit(0); });
  }

  private shouldLog(level: string): boolean {
    return this.logLevels.indexOf(level as any) >= this.currentLevel;
  }

  private formatMessage(entry: LogEntry): string {
    const timestamp = new Date(entry.timestamp).toISOString();
    return `[${timestamp}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}`;
  }

  private writeToFile(entry: LogEntry): void {
    try {
      const line = JSON.stringify(entry) + '\n';
      fs.appendFileSync(this.currentFile, line);

      // Check rotation
      const stats = fs.statSync(this.currentFile);
      if (stats.size > this.maxFileSize) {
        this.rotateFile();
      }
    } catch (err) {
      console.error('[LOGGER] Failed to write to file:', err);
    }
  }

  private rotateFile(): void {
    const timestamp = Date.now();
    const newPath = this.currentFile.replace('.log', `_${timestamp}.log`);
    try {
      fs.renameSync(this.currentFile, newPath);
      this.currentFile = this.getLogFilePath();
    } catch (err) {
      console.error('[LOGGER] Failed to rotate file:', err);
    }
  }

  log(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) return;

    // Emit for real-time listeners (TUI)
    this.emit('log', entry);

    // Write to file
    this.writeToFile(entry);

    // Console output for errors
    if (entry.level === 'error' || entry.level === 'critical') {
      console.error(this.formatMessage(entry));
    }
  }

  debug(source: string, message: string, metadata?: Record<string, any>): void {
    this.log({ level: 'debug', source, message, timestamp: Date.now(), metadata });
  }

  info(source: string, message: string, metadata?: Record<string, any>): void {
    this.log({ level: 'info', source, message, timestamp: Date.now(), metadata });
  }

  warn(source: string, message: string, metadata?: Record<string, any>): void {
    this.log({ level: 'warn', source, message, timestamp: Date.now(), metadata });
  }

  error(source: string, message: string, metadata?: Record<string, any>): void {
    this.log({ level: 'error', source, message, timestamp: Date.now(), metadata });
  }

  critical(source: string, message: string, metadata?: Record<string, any>): void {
    this.log({ level: 'critical', source, message, timestamp: Date.now(), metadata });
  }

  getRecentLogs(count: number = 100): LogEntry[] {
    try {
      if (!fs.existsSync(this.currentFile)) return [];
      const content = fs.readFileSync(this.currentFile, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());
      return lines
        .slice(-count)
        .map(line => JSON.parse(line))
        .filter(Boolean);
    } catch (err) {
      console.error('[LOGGER] Failed to read logs:', err);
      return [];
    }
  }

  exportLogs(format: 'json' | 'text' = 'text', since?: number): string {
    const logs = this.getRecentLogs(1000);
    const filtered = since ? logs.filter(l => l.timestamp >= since) : logs;

    if (format === 'json') {
      return JSON.stringify(filtered, null, 2);
    }

    return filtered.map(l => this.formatMessage(l)).join('\n');
  }
}

export const logger = Logger.getInstance();
