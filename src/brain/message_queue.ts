/**
 * Atlas Message Queue - Priority-based async message processing
 * Ensures messages are processed in order with priority support
 */

import { logger } from '../common/logger.js';

export interface QueueMessage {
  id: string;
  payload: any;
  priority: number;
  createdAt: number;
  retries: number;
  maxRetries: number;
}

export class MessageQueue {
  private static instance: MessageQueue;
  private queue: QueueMessage[] = [];
  private processing = false;
  private handler?: (msg: QueueMessage) => Promise<any>;

  private constructor() {}

  static getInstance(): MessageQueue {
    if (!MessageQueue.instance) {
      MessageQueue.instance = new MessageQueue();
    }
    return MessageQueue.instance;
  }

  setHandler(handler: (msg: QueueMessage) => Promise<any>): void {
    this.handler = handler;
  }

  enqueue(payload: any, priority: number = 5): string {
    const msg: QueueMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      payload,
      priority,
      createdAt: Date.now(),
      retries: 0,
      maxRetries: 3,
    };

    this.queue.push(msg);
    this.queue.sort((a, b) => a.priority - b.priority); // Lower = higher priority
    logger.info('message_queue', `Enqueued: ${msg.id} (priority: ${priority}, queue size: ${this.queue.length})`);

    if (!this.processing) {
      this.processNext();
    }

    return msg.id;
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0 || !this.handler) return;

    this.processing = true;
    const msg = this.queue.shift()!;

    try {
      await this.handler(msg);
      logger.info('message_queue', `Processed: ${msg.id}`);
    } catch (err) {
      msg.retries++;
      if (msg.retries <= msg.maxRetries) {
        logger.warn('message_queue', `Retry ${msg.retries}/${msg.maxRetries}: ${msg.id}`);
        this.queue.push(msg);
        this.queue.sort((a, b) => a.priority - b.priority);
      } else {
        logger.error('message_queue', `Dropped after ${msg.retries} retries: ${msg.id}`);
      }
    } finally {
      this.processing = false;
      if (this.queue.length > 0) {
        setImmediate(() => this.processNext());
      }
    }
  }

  size(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue = [];
    logger.info('message_queue', 'Cleared');
  }
}

export const messageQueue = MessageQueue.getInstance();
