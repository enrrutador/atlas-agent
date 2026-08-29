export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  type: 'web' | 'news' | 'image';
  publishedDate?: string;
  imageUrl?: string;
}

export interface ScrapeResult {
  url: string;
  title: string;
  content: string;
  excerpt: string;
  textLength: number;
  byline?: string;
  siteName?: string;
  lang?: string;
  publishedDate?: string;
  images: string[];
  links: { href: string; text: string }[];
  jsonLd: any[];
  ogTags: Record<string, string>;
  metaTags: Record<string, string>;
}

export interface DownloadResult {
  url: string;
  destPath: string;
  fileName: string;
  fileSize: number;
  elapsedMs: number;
  success: boolean;
  error?: string;
}

export interface DownloadProgress {
  id: string;
  url: string;
  destPath: string;
  received: number;
  total: number;
  percent: number;
  speedBps: number;
  status: 'downloading' | 'paused' | 'completed' | 'error';
}

export interface SearchOptions {
  type?: 'web' | 'news' | 'image';
  count?: number;
  sources?: string[];
}

export interface ScrapeOptions {
  depth?: 'basic' | 'full';
  extractLinks?: boolean;
  screenshot?: boolean;
}

export interface DownloadOptions {
  fileName?: string;
  timeout?: number;
  retries?: number;
}

export interface BatchDownloadOptions {
  maxConcurrent?: number;
  timeout?: number;
  retries?: number;
  destDir: string;
}
