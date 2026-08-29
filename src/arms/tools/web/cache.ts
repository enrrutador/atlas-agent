const DEFAULT_TTL_MS = {
  web: 5 * 60_000,
  news: 2 * 60_000,
  image: 10 * 60_000,
};

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class WebCache {
  private store = new Map<string, CacheEntry<any>>();
  private maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  private key(query: string, type: string): string {
    return `${type}:${query.toLowerCase().trim()}`;
  }

  get<T>(query: string, type: string = 'web'): T | null {
    const entry = this.store.get(this.key(query, type));
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(this.key(query, type));
      return null;
    }
    return entry.data as T;
  }

  set<T>(query: string, data: T, type: string = 'web', ttl?: number): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest) this.store.delete(oldest);
    }
    const ttlMs = ttl ?? DEFAULT_TTL_MS[type as keyof typeof DEFAULT_TTL_MS] ?? DEFAULT_TTL_MS.web;
    this.store.set(this.key(query, type), { data, expiresAt: Date.now() + ttlMs });
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

export const webCache = new WebCache();
