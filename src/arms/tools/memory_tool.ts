/**
 * Atlas Memory Tool - Recall and store information in Atlas memory
 */

import { logger } from '../../common/logger.js';
import { memoryStore } from '../../memory/memory_store.js';

export class MemoryTool {
  private static instance: MemoryTool;

  private constructor() {}

  static getInstance(): MemoryTool {
    if (!MemoryTool.instance) {
      MemoryTool.instance = new MemoryTool();
    }
    return MemoryTool.instance;
  }

  async store(args: { content: string; layer?: string; source?: string }): Promise<string> {
    try {
      const id = await memoryStore.store(args.content, (args.layer as any) || 'semantic', args.source || 'memory_tool');
      logger.info('memory', `Stored: "${args.content.slice(0, 60)}"`);
      return `Guardado en memoria (id: ${id}): "${args.content.slice(0, 100)}"`;
    } catch (err: any) {
      logger.error('memory', `Store failed: ${err.message}`);
      return `Error guardando en memoria: ${err.message}`;
    }
  }

  async recall(args: { query: string; limit?: number }): Promise<string> {
    try {
      const results = await memoryStore.search(args.query, args.limit || 5);
      if (results.length === 0) {
        return 'No encontré nada en memoria sobre eso.';
      }
      logger.info('memory', `Recalled: "${args.query}" -> ${results.length} results`);
      return results.map((r, i) => `${i + 1}. [${r.layer}] ${r.content}`).join('\n');
    } catch (err: any) {
      logger.error('memory', `Recall failed: ${err.message}`);
      return `Error buscando en memoria: ${err.message}`;
    }
  }

  async delete(args: { id: string }): Promise<string> {
    try {
      await memoryStore.delete(args.id);
      logger.info('memory', `Deleted: "${args.id}"`);
      return `Eliminado de memoria: "${args.id}"`;
    } catch (err: any) {
      logger.error('memory', `Delete failed: ${err.message}`);
      return `Error eliminando de memoria: ${err.message}`;
    }
  }

  async getStats(): Promise<string> {
    try {
      const stats = await memoryStore.getStats();
      return `Memoria Atlas: ${stats.total} entradas`;
    } catch {
      return 'Estadísticas de memoria no disponibles.';
    }
  }
}

export const memoryTool = MemoryTool.getInstance();
