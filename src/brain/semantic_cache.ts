import { logger } from '../common/logger.js';
import { QueryCategory, RoutedResult } from '../common/types.js';

interface CacheEntry {
  query: string;
  normalizedQuery: string;
  category: QueryCategory;
  result: RoutedResult;
  synthesizedResponse: string;
  timestamp: number;
  hitCount: number;
  ttlMs: number;
}

interface SemanticCacheConfig {
  maxEntries: number;
  defaultTtlMs: number;
  categoryTtl: Record<QueryCategory, number>;
  similarityThreshold: number;
}

const DEFAULT_CONFIG: SemanticCacheConfig = {
  maxEntries: 500,
  defaultTtlMs: 30 * 60 * 1000,
  categoryTtl: {
    general: 60 * 60 * 1000,
    memory: 10 * 60 * 1000,
    project: 5 * 60 * 1000,
    code: 20 * 60 * 1000,
    web: 5 * 60 * 1000,
    tool: 2 * 60 * 1000,
  },
  similarityThreshold: 0.75,
};

export class SemanticCache {
  private static instance: SemanticCache;
  private cache: Map<string, CacheEntry> = new Map();
  private config: SemanticCacheConfig = DEFAULT_CONFIG;
  private stats = { hits: 0, misses: 0, stores: 0, evictions: 0 };

  private constructor() {}

  static getInstance(): SemanticCache {
    if (!SemanticCache.instance) {
      SemanticCache.instance = new SemanticCache();
    }
    return SemanticCache.instance;
  }

  setConfig(config: Partial<SemanticCacheConfig>): void {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get(input: string, category: QueryCategory): { result: RoutedResult; synthesizedResponse: string } | null {
    const normalized = this.normalize(input);
    const now = Date.now();

    const exactKey = `${category}:${normalized}`;
    const exactEntry = this.cache.get(exactKey);
    if (exactEntry && now - exactEntry.timestamp < exactEntry.ttlMs) {
      exactEntry.hitCount++;
      this.stats.hits++;
      logger.info('semantic_cache', `Exact hit: "${input.slice(0, 60)}" → ${category}`);
      return { result: exactEntry.result, synthesizedResponse: exactEntry.synthesizedResponse };
    }

    if (exactEntry) {
      this.cache.delete(exactKey);
    }

    for (const [key, entry] of this.cache) {
      if (!key.startsWith(`${category}:`)) continue;
      if (now - entry.timestamp >= entry.ttlMs) {
        this.cache.delete(key);
        continue;
      }

      const similarity = this.computeSimilarity(normalized, entry.normalizedQuery);
      if (similarity >= this.config.similarityThreshold) {
        entry.hitCount++;
        this.stats.hits++;
        logger.info('semantic_cache', `Semantic hit (sim=${similarity.toFixed(2)}): "${input.slice(0, 60)}" ≈ "${entry.query.slice(0, 60)}"`);
        return { result: entry.result, synthesizedResponse: entry.synthesizedResponse };
      }
    }

    this.stats.misses++;
    return null;
  }

  store(
    input: string,
    category: QueryCategory,
    result: RoutedResult,
    synthesizedResponse: string,
  ): void {
    const normalized = this.normalize(input);
    const key = `${category}:${normalized}`;
    const ttlMs = this.config.categoryTtl[category] || this.config.defaultTtlMs;

    if (this.cache.size >= this.config.maxEntries) {
      this.evict();
    }

    this.cache.set(key, {
      query: input,
      normalizedQuery: normalized,
      category,
      result,
      synthesizedResponse,
      timestamp: Date.now(),
      hitCount: 0,
      ttlMs,
    });

    this.stats.stores++;
    logger.debug('semantic_cache', `Stored: "${input.slice(0, 60)}" → ${category} (TTL: ${ttlMs / 1000}s)`);
  }

  invalidate(input: string, category: QueryCategory): boolean {
    const normalized = this.normalize(input);
    const key = `${category}:${normalized}`;
    return this.cache.delete(key);
  }

  invalidateCategory(category: QueryCategory): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${category}:`)) {
        this.cache.delete(key);
        count++;
      }
    }
    logger.info('semantic_cache', `Invalidated ${count} entries for category: ${category}`);
    return count;
  }

  clear(): void {
    this.cache.clear();
    logger.info('semantic_cache', 'Cache cleared');
  }

  getStats(): { hits: number; misses: number; stores: number; evictions: number; size: number; hitRate: number } {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      size: this.cache.size,
      hitRate: total > 0 ? this.stats.hits / total : 0,
    };
  }

  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp >= entry.ttlMs) {
        this.cache.delete(key);
        pruned++;
      }
    }
    if (pruned > 0) {
      logger.info('semantic_cache', `Pruned ${pruned} expired entries`);
    }
    return pruned;
  }

  private normalize(input: string): string {
    return input
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[¿?¡!.,;:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private computeSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (!a || !b) return 0;

    const wordsA = new Set(a.split(' '));
    const wordsB = new Set(b.split(' '));

    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);

    if (union.size === 0) return 0;

    const jaccard = intersection.size / union.size;

    const lenA = a.length;
    const lenB = b.length;
    const lenRatio = Math.min(lenA, lenB) / Math.max(lenA, lenB);

    const prefixBonus = this.commonPrefixRatio(a, b);

    return jaccard * 0.5 + lenRatio * 0.25 + prefixBonus * 0.25;
  }

  private commonPrefixRatio(a: string, b: string): number {
    let i = 0;
    const maxLen = Math.min(a.length, b.length);
    while (i < maxLen && a[i] === b[i]) i++;
    return maxLen > 0 ? i / maxLen : 0;
  }

  private evict(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    let lowestHitKey: string | null = null;
    let lowestHits = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.hitCount < lowestHits) {
        lowestHits = entry.hitCount;
        lowestHitKey = key;
      }
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    const keyToEvict = lowestHits === 0 && lowestHitKey ? lowestHitKey : oldestKey;
    if (keyToEvict) {
      this.cache.delete(keyToEvict);
      this.stats.evictions++;
    }
  }
}

export const semanticCache = SemanticCache.getInstance();
