/**
 * Atlas Context Compressor - Reduces conversation context to fit token limits
 * Strategies: summarization, truncation, key-extraction
 */

import { logger } from '../common/logger.js';
import { Message } from '../common/types.js';

const MAX_CONTEXT_MESSAGES = 50;
const MAX_CHARS_PER_MESSAGE = 2000;

export class ContextCompressor {
  private static instance: ContextCompressor;

  private constructor() {}

  static getInstance(): ContextCompressor {
    if (!ContextCompressor.instance) {
      ContextCompressor.instance = new ContextCompressor();
    }
    return ContextCompressor.instance;
  }

  compress(messages: Message[], maxTokens: number = 4000): Message[] {
    // Keep system messages
    const systemMsgs = messages.filter(m => m.role === 'system');
    const conversationMsgs = messages.filter(m => m.role !== 'system');

    // Truncate to max messages
    let trimmed = conversationMsgs.slice(-MAX_CONTEXT_MESSAGES);

    // Truncate individual messages
    trimmed = trimmed.map(m => ({
      ...m,
      content: (m.content ?? '').length > MAX_CHARS_PER_MESSAGE
        ? (m.content ?? '').slice(0, MAX_CHARS_PER_MESSAGE) + '...[truncated]'
        : (m.content ?? ''),
    }));

    // Estimate tokens (rough: 1 token ≈ 4 chars)
    const estimateTokens = (msgs: Message[]) =>
      msgs.reduce((sum, m) => sum + Math.ceil((m.content ?? '').length / 4), 0);

    let result = [...systemMsgs, ...trimmed];
    let tokens = estimateTokens(result);

    // Aggressively trim from the oldest if still over budget
    while (tokens > maxTokens && trimmed.length > 2) {
      trimmed = trimmed.slice(1);
      result = [...systemMsgs, ...trimmed];
      tokens = estimateTokens(result);
    }

    logger.info('context_compressor', `Compressed: ${messages.length} → ${result.length} messages (~${tokens} tokens)`);
    return result;
  }

  extractKeyPoints(messages: Message[]): string {
    const userMessages = messages
      .filter(m => m.role === 'user')
      .map(m => m.content ?? '')
      .slice(-5);

    return userMessages.join(' | ');
  }
}

export const contextCompressor = ContextCompressor.getInstance();
