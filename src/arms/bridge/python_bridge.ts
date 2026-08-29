/**
 * Atlas Python Bridge - Persistent Python process for desktop automation & Python skills
 * Cross-platform: macOS (python3), Linux (python3), Windows (python)
 * 
 * Communication: JSON-RPC over stdin/stdout
 * Replaces pygetwindow with platform-specific implementations
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { EventEmitter } from 'events';
import { logger } from '../../common/logger.js';

export class PythonBridge extends EventEmitter {
  private static instance: PythonBridge;
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending: Map<number, { resolve: Function; reject: Function; timeout: NodeJS.Timeout }> = new Map();
  private buffer = '';
  private ready = false;
  private requestTimeout = 120000;

  private constructor() {
    super();
  }

  static getInstance(): PythonBridge {
    if (!PythonBridge.instance) {
      PythonBridge.instance = new PythonBridge();
    }
    return PythonBridge.instance;
  }

  private get pythonPath(): string {
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  private get bridgeScript(): string {
    return path.join(process.cwd(), 'src', 'arms', 'bridge', 'atlas_python_bridge.py');
  }

  async start(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.process = spawn(this.pythonPath, [this.bridgeScript], {
          cwd: process.cwd(),
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ATLAS_HOME: process.cwd(),
            PYTHONUNBUFFERED: '1',
          },
        });

        this.process.stdout?.on('data', (chunk) => {
          this.buffer += chunk.toString('utf-8');
          this.processBuffer();
        });

        this.process.stderr?.on('data', (chunk) => {
          const msg = chunk.toString('utf-8').trim();
          if (msg) logger.warn('python_bridge', msg);
        });

        this.process.on('error', (err) => {
          logger.error('python_bridge', `Process error: ${err.message}`);
          this.ready = false;
          resolve(false);
        });

        this.process.on('exit', (code) => {
          logger.error('python_bridge', `Process exited with code ${code}`);
          this.ready = false;
          this.rejectAllPending(new Error(`Bridge process exited with code ${code}`));
        });

        const timeout = setTimeout(() => {
          if (!this.ready) resolve(false);
        }, 15000);

        this.once('ready', () => {
          clearTimeout(timeout);
          this.ready = true;
          resolve(true);
        });
      } catch (err) {
        logger.error('python_bridge', `Failed to start: ${err}`);
        resolve(false);
      }
    });
  }

  async executeSkill(name: string, args: Record<string, any>, sessionId?: string): Promise<any> {
    return this.rpc('skill.execute', { name, args, session_id: sessionId || 'unknown' });
  }

  async listSkills(): Promise<any> {
    return this.rpc('skill.list');
  }

  async healthCheck(): Promise<any> {
    return this.rpc('skill.health');
  }

  async desktopClick(x: number, y: number, button = 'left', clicks = 1): Promise<any> {
    return this.rpc('desktop.click', { x, y, button, clicks });
  }

  async desktopType(text: string, interval = 0.02): Promise<any> {
    return this.rpc('desktop.type', { text, interval });
  }

  async desktopHotkey(keys: string[]): Promise<any> {
    return this.rpc('desktop.hotkey', { keys });
  }

  async desktopScreenshot(savePath?: string): Promise<any> {
    return this.rpc('desktop.screenshot', { save_path: savePath });
  }

  async desktopLaunch(app: string): Promise<any> {
    return this.rpc('desktop.launch', { app });
  }

  async windowList(): Promise<any> {
    return this.rpc('desktop.window_list');
  }

  async windowFocus(title: string): Promise<any> {
    return this.rpc('desktop.window_focus', { title });
  }

  async desktopScroll(amount: number, direction = 'down'): Promise<any> {
    return this.rpc('desktop.scroll', { amount, direction });
  }

  async desktopOCR(imagePath?: string): Promise<any> {
    return this.rpc('desktop.ocr', { image_path: imagePath });
  }

  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.ready = false;
    }
  }

  isReady(): boolean {
    return this.ready && this.process !== null;
  }

  private async rpc(method: string, params: Record<string, any> = {}): Promise<any> {
    if (!this.ready || !this.process?.stdin) {
      throw new Error('Python bridge not ready');
    }

    const id = ++this.requestId;
    const request = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (${this.requestTimeout}ms)`));
      }, this.requestTimeout);

      this.pending.set(id, { resolve, reject, timeout });

      try {
        if (!this.process?.stdin) {
          throw new Error('Bridge stdin not available');
        }
        this.process.stdin.write(JSON.stringify(request) + '\n');
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error(`Failed to write to bridge: ${(err as Error).message}`));
      }
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject, timeout } = this.pending.get(msg.id)!;
          clearTimeout(timeout);
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        } else if (msg.method === 'bridge.ready') {
          this.emit('ready', msg.params);
          logger.info('python_bridge', `Ready — ${msg.params?.skills || 0} skills loaded`);
        } else if (msg.method) {
          this.emit(msg.method, msg.params);
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export const pythonBridge = PythonBridge.getInstance();
