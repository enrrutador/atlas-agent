/**
 * Atlas Translate Tool - Translation via LLM
 */

import { logger } from '../../common/logger.js';

export class TranslateTool {
  private static instance: TranslateTool;
  private llmClient: any = null;

  private constructor() {}

  static getInstance(): TranslateTool {
    if (!TranslateTool.instance) {
      TranslateTool.instance = new TranslateTool();
    }
    return TranslateTool.instance;
  }

  setLLMClient(client: any): void {
    this.llmClient = client;
  }

  async translate(text: string, targetLang: string = 'english'): Promise<string> {
    if (!this.llmClient) return 'LLM no disponible para traducir.';

    try {
      const langMap: Record<string, string> = {
        'inglés': 'English', 'english': 'English', 'en': 'English',
        'español': 'Spanish', 'spanish': 'Spanish', 'es': 'Spanish',
        'portugués': 'Portuguese', 'portuguese': 'Portuguese', 'pt': 'Portuguese',
        'francés': 'French', 'french': 'French', 'fr': 'French',
        'alemán': 'German', 'german': 'German', 'de': 'German',
        'italiano': 'Italian', 'italian': 'Italian', 'it': 'Italian',
        'chino': 'Chinese', 'chinese': 'Chinese', 'zh': 'Chinese',
        'japonés': 'Japanese', 'japanese': 'Japanese', 'ja': 'Japanese',
        'ruso': 'Russian', 'russian': 'Russian', 'ru': 'Russian',
        'árabe': 'Arabic', 'arabic': 'Arabic', 'ar': 'Arabic',
        'coreano': 'Korean', 'korean': 'Korean', 'ko': 'Korean',
      };

      const lang = langMap[targetLang.toLowerCase()] || targetLang;

      const result = await this.llmClient.chatCompletion([
        { role: 'system', content: `Sos un traductor profesional. Traducí el texto a ${lang}. Respondé SOLO con la traducción, sin explicaciones.` },
        { role: 'user', content: text },
      ], 1024);

      logger.info('translate', `Translated to ${lang}: ${text.slice(0, 60)}`);
      return result;
    } catch (err: any) {
      logger.error('translate', `Translation failed: ${err.message}`);
      return `Error traduciendo: ${err.message}`;
    }
  }
}

export const translateTool = TranslateTool.getInstance();
