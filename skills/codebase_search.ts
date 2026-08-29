import type { Skill } from '../src/core/skills.js';
import * as fs from 'fs';
import * as path from 'path';
import { LocalIndex } from 'vectra';

/**
 * codebase_search — Hybrid semantic + text search across the codebase
 *
 * Combina dos estrategias de búsqueda:
 * 1. Semántica (Vectra + TF-IDF vectors) — encuentra código por significado
 * 2. Texto exacto (grep-style) — encuentra código por palabras clave exactas
 *
 * La búsqueda híbrida da mejores resultados que cualquiera sola.
 *
 * Acciones:
 *   search  — busca en el codebase (indexa automáticamente si es necesario)
 *   index   — fuerza re-indexación completa
 *   status  — estado del índice
 *   read    — lee un archivo específico con contexto de líneas
 */

const INDEX_DIR = path.join(process.cwd(), 'data', 'codebase_index');
const INDEX_META_FILE = path.join(INDEX_DIR, 'meta.json');

const SUPPORTED_EXTENSIONS = ['.ts', '.js', '.json', '.md', '.txt', '.py', '.sh', '.env.example'];
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'data', '.kiro']);
const MAX_CHUNK_CHARS = 1200;
const CHUNK_OVERLAP_LINES = 3;

interface IndexMeta {
  indexedAt: number;
  fileCount: number;
  chunkCount: number;
}

interface SearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  matchType: 'semantic' | 'exact' | 'hybrid';
}

// ── Vector embedding (TF-IDF bag-of-words, 512 dims) ─────────────────────────
// Fast, deterministic, no API calls needed. Good enough for code search.

function embed(text: string, dims = 512): number[] {
  const tokens = text.toLowerCase()
    .replace(/([A-Z])/g, ' $1')          // split camelCase
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);

  const vec = new Float32Array(dims);

  for (const token of tokens) {
    // djb2 hash
    let h = 5381;
    for (let i = 0; i < token.length; i++) {
      h = ((h << 5) + h) ^ token.charCodeAt(i);
      h = h >>> 0;
    }
    vec[h % dims] += 1;

    // Also hash bigrams for better context
    if (token.length > 3) {
      const sub = token.slice(0, 4);
      let h2 = 5381;
      for (let i = 0; i < sub.length; i++) {
        h2 = ((h2 << 5) + h2) ^ sub.charCodeAt(i);
        h2 = h2 >>> 0;
      }
      vec[h2 % dims] += 0.5;
    }
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec).map(v => v / norm);
}

// ── File scanning ─────────────────────────────────────────────────────────────

function scanFiles(rootDir: string): string[] {
  const files: string[] = [];

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const e of entries) {
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.includes(ext)) {
          files.push(path.join(dir, e.name));
        }
      }
    }
  }

  walk(rootDir);
  return files;
}

// ── Chunking ──────────────────────────────────────────────────────────────────

interface Chunk {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
}

function chunkFile(relPath: string, content: string): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];
  let i = 0;

  while (i < lines.length) {
    let charCount = 0;
    let j = i;

    while (j < lines.length && charCount < MAX_CHUNK_CHARS) {
      charCount += (lines[j]?.length || 0) + 1;
      j++;
    }

    if (j > i) {
      chunks.push({
        filePath: relPath,
        startLine: i + 1,
        endLine: j,
        content: lines.slice(i, j).join('\n'),
      });
    }

    // Overlap: go back a few lines
    i = Math.max(i + 1, j - CHUNK_OVERLAP_LINES);
  }

  return chunks;
}

// ── Index management ──────────────────────────────────────────────────────────

let _index: LocalIndex | null = null;

async function getIndex(): Promise<LocalIndex> {
  if (_index) return _index;
  if (!fs.existsSync(INDEX_DIR)) fs.mkdirSync(INDEX_DIR, { recursive: true });
  _index = new LocalIndex(INDEX_DIR);
  if (!await _index.isIndexCreated()) await _index.createIndex();
  return _index;
}

function getIndexMeta(): IndexMeta | null {
  try {
    if (fs.existsSync(INDEX_META_FILE)) return JSON.parse(fs.readFileSync(INDEX_META_FILE, 'utf-8'));
  } catch {}
  return null;
}

function saveIndexMeta(meta: IndexMeta): void {
  try { fs.writeFileSync(INDEX_META_FILE, JSON.stringify(meta, null, 2)); } catch {}
}

async function isIndexStale(rootDir: string): Promise<boolean> {
  const meta = getIndexMeta();
  if (!meta) return true;

  // Re-index if older than 1 hour or if file count changed significantly
  const ageMs = Date.now() - meta.indexedAt;
  if (ageMs > 60 * 60 * 1000) return true;

  const currentFiles = scanFiles(rootDir);
  if (Math.abs(currentFiles.length - meta.fileCount) > 5) return true;

  return false;
}

async function buildIndex(rootDir: string): Promise<IndexMeta> {
  // Reset
  _index = null;
  if (fs.existsSync(INDEX_DIR)) fs.rmSync(INDEX_DIR, { recursive: true, force: true });
  fs.mkdirSync(INDEX_DIR, { recursive: true });

  const index = await getIndex();
  const files = scanFiles(rootDir);
  let chunkCount = 0;
  let errors = 0;

  console.log(`[CODEBASE] Indexing ${files.length} files...`);

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.length < 20) continue;

      const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');
      const chunks = chunkFile(relPath, content);

      for (const chunk of chunks) {
        const text = `${chunk.filePath}\n${chunk.content}`;
        await index.insertItem({
          vector: embed(text),
          metadata: {
            filePath: chunk.filePath,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            content: chunk.content.slice(0, 500),
          },
        });
        chunkCount++;
      }
    } catch {
      errors++;
    }
  }

  const meta: IndexMeta = { indexedAt: Date.now(), fileCount: files.length, chunkCount };
  saveIndexMeta(meta);

  console.log(`[CODEBASE] Done: ${files.length} files, ${chunkCount} chunks, ${errors} errors`);
  return meta;
}

// ── Exact text search (grep-style) ───────────────────────────────────────────

function exactSearch(query: string, rootDir: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const files = scanFiles(rootDir);
  const queryLower = query.toLowerCase();
  const terms = queryLower.split(/\s+/).filter(t => t.length > 2);

  for (const filePath of files) {
    if (results.length >= maxResults) break;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');

      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i]!.toLowerCase();
        const matchCount = terms.filter(t => lineLower.includes(t)).length;
        if (matchCount === 0) continue;

        const start = Math.max(0, i - 2);
        const end = Math.min(lines.length - 1, i + 4);
        const snippet = lines.slice(start, end + 1).join('\n');

        results.push({
          filePath: relPath,
          startLine: start + 1,
          endLine: end + 1,
          content: snippet,
          score: matchCount / terms.length,
          matchType: 'exact',
        });

        if (results.length >= maxResults) break;
      }
    } catch {}
  }

  return results.sort((a, b) => b.score - a.score);
}

// ── Semantic search ───────────────────────────────────────────────────────────

async function semanticSearch(query: string, topK: number): Promise<SearchResult[]> {
  const index = await getIndex();
  if (!await index.isIndexCreated()) return [];

  const queryVec = embed(query);
  const items = await index.queryItems(queryVec, topK);

  return items.map(item => ({
    filePath: String(item.item.metadata.filePath || ''),
    startLine: Number(item.item.metadata.startLine || 0),
    endLine: Number(item.item.metadata.endLine || 0),
    content: String(item.item.metadata.content || ''),
    score: item.score,
    matchType: 'semantic' as const,
  }));
}

// ── Hybrid search ─────────────────────────────────────────────────────────────

async function hybridSearch(query: string, rootDir: string, topK: number): Promise<SearchResult[]> {
  const [semantic, exact] = await Promise.all([
    semanticSearch(query, topK).catch(() => [] as SearchResult[]),
    Promise.resolve(exactSearch(query, rootDir, topK)),
  ]);

  // Merge and deduplicate by file+line
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  // Interleave results, preferring exact matches for short queries
  const isShortQuery = query.split(/\s+/).length <= 2;
  const primary = isShortQuery ? exact : semantic;
  const secondary = isShortQuery ? semantic : exact;

  for (const r of [...primary, ...secondary]) {
    const key = `${r.filePath}:${r.startLine}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(r);
    }
  }

  return merged.slice(0, topK);
}

// ── Skill ─────────────────────────────────────────────────────────────────────

const codebaseSearchSkill: Skill = {
  name: 'codebase_search',
  description: `Búsqueda híbrida (semántica + texto exacto) en todo el codebase del proyecto.
Se auto-indexa la primera vez. Encuentra código por significado o por palabras clave.
JSON Args: { "query": "qué buscar", "topK": 5 } para buscar.
{ "action": "index" } para re-indexar. { "action": "status" } para ver estado del índice.
{ "action": "read", "file": "src/core/openai_client.ts", "startLine": 1, "endLine": 50 } para leer un archivo.`,

  execute: async (args: {
    query?: string;
    topK?: number;
    action?: 'index' | 'status' | 'read';
    file?: string;
    startLine?: number;
    endLine?: number;
    rootDir?: string;
  }) => {
    const rootDir = args.rootDir || process.cwd();
    const { action, query, topK = 5 } = args;

    // ── Read file ─────────────────────────────────────────────────────────
    if (action === 'read') {
      const filePath = args.file;
      if (!filePath) return { success: false, message: 'Especificá el archivo con "file"' };

      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);
      if (!fs.existsSync(fullPath)) return { success: false, message: `Archivo no encontrado: ${filePath}` };

      try {
        const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
        const start = Math.max(1, args.startLine || 1);
        const end = Math.min(lines.length, args.endLine || lines.length);
        const content = lines.slice(start - 1, end)
          .map((l, i) => `${start + i}: ${l}`)
          .join('\n');

        return {
          success: true,
          filePath,
          startLine: start,
          endLine: end,
          totalLines: lines.length,
          content,
          message: `${filePath} (líneas ${start}-${end} de ${lines.length}):\n\n${content}`,
        };
      } catch (e: any) {
        return { success: false, message: `Error leyendo ${filePath}: ${e.message}` };
      }
    }

    // ── Force re-index ────────────────────────────────────────────────────
    if (action === 'index') {
      try {
        const meta = await buildIndex(rootDir);
        return {
          success: true,
          ...meta,
          message: `✅ Codebase indexado: ${meta.fileCount} archivos, ${meta.chunkCount} fragmentos`,
        };
      } catch (e: any) {
        return { success: false, message: `Error indexando: ${e.message}` };
      }
    }

    // ── Status ────────────────────────────────────────────────────────────
    if (action === 'status') {
      const meta = getIndexMeta();
      if (!meta) {
        return { success: true, indexed: false, message: 'Sin índice. Se creará automáticamente en la próxima búsqueda.' };
      }
      const ageMin = Math.floor((Date.now() - meta.indexedAt) / 60_000);
      return {
        success: true,
        indexed: true,
        fileCount: meta.fileCount,
        chunkCount: meta.chunkCount,
        ageMinutes: ageMin,
        message: `✅ Índice activo: ${meta.fileCount} archivos, ${meta.chunkCount} fragmentos (hace ${ageMin}min)`,
      };
    }

    // ── Search (default) ──────────────────────────────────────────────────
    if (!query) {
      return { success: false, message: 'Especificá "query" para buscar, o "action" para otras operaciones.' };
    }

    try {
      // Auto-index if needed
      if (await isIndexStale(rootDir)) {
        console.log('[CODEBASE] Index stale, rebuilding...');
        await buildIndex(rootDir);
      }

      const results = await hybridSearch(query, rootDir, topK);

      if (results.length === 0) {
        return {
          success: true,
          results: [],
          message: `Sin resultados para: "${query}"`,
        };
      }

      const formatted = results.map((r, i) =>
        `**${i + 1}. ${r.filePath}** (líneas ${r.startLine}-${r.endLine})\n\`\`\`\n${r.content.slice(0, 300)}\n\`\`\``
      ).join('\n\n');

      return {
        success: true,
        query,
        count: results.length,
        results: results.map(r => ({
          filePath: r.filePath,
          startLine: r.startLine,
          endLine: r.endLine,
          preview: r.content.slice(0, 200),
          score: Math.round(r.score * 100) / 100,
          matchType: r.matchType,
        })),
        formatted,
        message: `Encontré ${results.length} resultados para "${query}":\n\n${formatted}`,
      };
    } catch (e: any) {
      return { success: false, message: `Error en búsqueda: ${e.message}` };
    }
  },
};

export default codebaseSearchSkill;
