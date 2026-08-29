/**
 * Atlas Forge LLM - Lightweight LLM client for mission execution
 * Reuses the same OpenAI-compatible pattern as the main LLMClient
 */

import { logger } from '../../common/logger.js';
import { AtlasConfig } from '../../common/types.js';

export class ForgeLLMClient {
  private config: AtlasConfig;
  private maxRetries = 3;

  constructor(config: AtlasConfig) {
    this.config = config;
  }

  async chat(messages: any[], maxTokens: number = 2048, temperature: number = 0.7): Promise<string> {
    const axios = (await import('axios')).default;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          logger.warn('forge_llm', `Retry ${attempt}/${this.maxRetries}`);
          await new Promise(r => setTimeout(r, attempt * 3000));
        }

        const clean = messages.map(m => ({
          role: m.role,
          content: m.content ?? '',
        }));

        const response = await axios.post(
          `${this.config.openaiBaseUrl}/chat/completions`,
          {
            model: this.config.modelName,
            messages: clean,
            temperature,
            max_tokens: maxTokens,
          },
          {
            headers: {
              'Authorization': `Bearer ${this.config.openaiApiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 60000,
          }
        );

        return response.data.choices?.[0]?.message?.content || 'No response';
      } catch (err: any) {
        lastError = err;
        const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
        const isRateLimit = err.response?.status === 429;
        const isRetryable = isTimeout || isRateLimit || err.response?.status >= 500;

        logger.warn('forge_llm', `Attempt ${attempt + 1} failed: ${err.message}`);

        if (isRateLimit) {
          const wait = Math.min(10000, attempt * 5000);
          logger.warn('forge_llm', `Rate limited, waiting ${wait}ms`);
          await new Promise(r => setTimeout(r, wait));
        }

        if (!isRetryable) throw err;
      }
    }
    throw lastError || new Error('Forge LLM request failed');
  }
}
