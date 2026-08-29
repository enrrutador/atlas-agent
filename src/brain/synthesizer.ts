import { logger } from '../common/logger.js';
import { QueryCategory, RoutedResult } from '../common/types.js';

const FILLER_PATTERNS = [
  /¿Puedo ayudarte con algo más\??/gi,
  /Avísame si necesitas algo\.?/gi,
  /Estoy aquí para ayudarte\.?/gi,
  /No dudes en preguntar\.?/gi,
  /¿Hay algo más en lo que pueda ayudarte\??/gi,
  /Let me know if you need anything else\.?/gi,
  /Is there anything else I can help with\??/gi,
];

const MAX_SYNTHESIS_TOKENS = 512;

export class Synthesizer {
  private static instance: Synthesizer;
  private llmClient: any = null;

  private constructor() {}

  static getInstance(): Synthesizer {
    if (!Synthesizer.instance) {
      Synthesizer.instance = new Synthesizer();
    }
    return Synthesizer.instance;
  }

  setLLMClient(client: any): void {
    this.llmClient = client;
  }

  async synthesize(
    result: RoutedResult,
    category: QueryCategory,
    originalQuery: string,
  ): Promise<string> {
    if (category === 'general' && result.source === 'llm') {
      return this.cleanupFillers(result.content);
    }

    if (category === 'memory' && result.source === 'memory_store') {
      return this.synthesizeMemory(result.content, originalQuery);
    }

    if (category === 'web' && (result.source === 'web_search' || result.source === 'web_scrape')) {
      return this.synthesizeWeb(result.content, originalQuery, result.subIntent || '');
    }

    if (category === 'tool' && result.source === 'skill_direct') {
      return this.synthesizeTool(result.content, originalQuery);
    }

    if (category === 'project' && (result.source === 'file_system' || result.source === 'git')) {
      return this.synthesizeProject(result.content, originalQuery);
    }

    if (category === 'code' && result.source === 'llm_with_context') {
      return this.cleanupFillers(result.content);
    }

    if (this.llmClient && this.needsSynthesis(result.content)) {
      return this.synthesizeWithLLM(result.content, originalQuery);
    }

    return this.cleanupFillers(result.content);
  }

  private needsSynthesis(content: string): boolean {
    if (!content) return false;
    const hasJson = content.includes('{') && content.includes('"') && (content.includes(':') || content.includes(','));
    const hasSnippets = /(?:snippet|result|url|title|link)[:\s]/i.test(content.slice(0, 500));
    const hasCodeBlocks = content.includes('```');
    const isTooRaw = hasJson || hasSnippets || hasCodeBlocks;
    return isTooRaw;
  }

  private cleanupFillers(text: string): string {
    let cleaned = text;
    for (const pattern of FILLER_PATTERNS) {
      cleaned = cleaned.replace(pattern, '');
    }
    return cleaned.trim() || text;
  }

  private synthesizeMemory(content: string, _query: string): string {
    if (!content || content.includes('No encontré nada')) {
      return 'No tengo nada guardado sobre eso en memoria. Si querés, puedo buscarlo en la web.';
    }
    const lines = content.split('\n').filter((l: string) => l.trim());
    if (lines.length === 1) {
      const match = lines[0].match(/^\d+\.\s*\[(\w+)\]\s*(.+)/);
      if (match) {
        return `En memoria tengo: ${match[2].trim()}`;
      }
      return `En memoria tengo: ${lines[0].trim()}`;
    }
    const items = lines.slice(0, 5).map((l: string) => {
      const match = l.match(/^\d+\.\s*\[(\w+)\]\s*(.+)/);
      if (match) return `• ${match[2].trim()}`;
      return `• ${l.trim()}`;
    });
    return `Esto es lo que tengo en memoria:\n\n${items.join('\n')}`;
  }

  private async synthesizeWeb(content: string, query: string, subIntent: string): Promise<string> {
    if (subIntent === 'weather') {
      if (/🌤️|🌡️|Temperatura|Sensación/i.test(content)) {
        return this.cleanupFillers(content);
      }
    }

    if (!this.needsSynthesis(content)) {
      return this.cleanupFillers(content);
    }

    if (!this.llmClient) {
      return this.fallbackFormat(content, query);
    }

    try {
      const synthesis = await this.llmClient.chatCompletion([
        {
          role: 'system',
          content: 'Sos Atlas. Sintetizá la información del resultado de búsqueda en una respuesta coloquial en español. NUNCA pegues JSON, snippets, URLs ni datos crudos. Contá lo que encontraste de forma natural y breve (2-3 párrafos). Respondé SIEMPRE en español rioplatense.',
        },
        {
          role: 'user',
          content: `El usuario preguntó: "${query}"\n\nResultado de búsqueda:\n${content.slice(0, 3000)}\n\nSintetizá esto en una respuesta natural y coloquial.`,
        },
      ], MAX_SYNTHESIS_TOKENS);

      return this.cleanupFillers(synthesis);
    } catch (err) {
      logger.warn('synthesizer', `LLM synthesis failed: ${err}`);
      return this.fallbackFormat(content, query);
    }
  }

  private synthesizeTool(content: string, _query: string): string {
    if (/Error|error|falló|failed/i.test(content)) {
      return `No pude completar eso. ${content}`;
    }
    if (/Archivo guardado|Descargado|Eliminado/i.test(content)) {
      return `Listo! ${content}`;
    }
    return this.cleanupFillers(content);
  }

  private synthesizeProject(content: string, _query: string): string {
    return this.cleanupFillers(content);
  }

  private async synthesizeWithLLM(content: string, query: string): Promise<string> {
    if (!this.llmClient) {
      return this.cleanupFillers(content);
    }

    try {
      const synthesis = await this.llmClient.chatCompletion([
        {
          role: 'system',
          content: 'Sintetizá el siguiente resultado en una respuesta coloquial en español rioplatense. NUNCA devuelvas datos crudos. Contá lo que encontraste de forma natural.',
        },
        {
          role: 'user',
          content: `Query: "${query}"\n\nResultado:\n${content.slice(0, 3000)}\n\nSintetizá en español coloquial.`,
        },
      ], MAX_SYNTHESIS_TOKENS);

      return this.cleanupFillers(synthesis);
    } catch (err) {
      logger.warn('synthesizer', `LLM synthesis failed: ${err}`);
      return this.cleanupFillers(content);
    }
  }

  private fallbackFormat(content: string, query: string): string {
    const lines = content.split('\n').filter((l: string) => l.trim());
    if (lines.length <= 3) {
      return this.cleanupFillers(content);
    }

    const topLines = lines.slice(0, 5);
    const formatted = topLines
      .map((l: string) => {
        const cleaned = l.replace(/^\d+\.\s*/, '').replace(/\*\*/g, '');
        return `• ${cleaned.trim()}`;
      })
      .join('\n');

    return `Esto encontré sobre "${query}":\n\n${formatted}`;
  }
}

export const synthesizer = Synthesizer.getInstance();
