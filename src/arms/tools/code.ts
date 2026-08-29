/**
 * Atlas Code Tool - Code generation, analysis, and debugging via LLM
 */

import { logger } from '../../common/logger.js';

export class CodeTool {
  private static instance: CodeTool;
  private llmClient: any = null;

  private constructor() {}

  static getInstance(): CodeTool {
    if (!CodeTool.instance) {
      CodeTool.instance = new CodeTool();
    }
    return CodeTool.instance;
  }

  setLLMClient(client: any): void {
    this.llmClient = client;
  }

  async generateCode(description: string, language: string = 'typescript', context: string = ''): Promise<string> {
    if (!this.llmClient) return 'LLM no disponible para generar código.';

    try {
      const prompt = `Generá código ${language} para: ${description}
${context ? `Contexto adicional: ${context}` : ''}

Reglas:
- Código funcional, completo, listo para usar
- Incluí imports necesarios
- Incluí tipos si es TypeScript
- Comentarios mínimos, código limpio
- Respondé SOLO con el código, sin explicaciones`;

      const result = await this.llmClient.chatCompletion(
        [{ role: 'user', content: prompt }],
        2048
      );
      logger.info('code', `Generated ${language} code: ${description.slice(0, 60)}`);
      return result;
    } catch (err: any) {
      logger.error('code', `Generation failed: ${err.message}`);
      return `Error generando código: ${err.message}`;
    }
  }

  async analyzeCode(code: string, filePath: string = ''): Promise<string> {
    if (!this.llmClient) return 'LLM no disponible para analizar código.';

    try {
      const prompt = `Analizá este código${filePath ? ` (archivo: ${filePath})` : ''} y decime:
1. Qué hace
2. Problemas potenciales (bugs, seguridad, performance)
3. Mejoras sugeridas
4. Calidad general (1-10)

Código:
\`\`\`
${code}
\`\`\``;

      const result = await this.llmClient.chatCompletion(
        [{ role: 'user', content: prompt }],
        1024
      );
      logger.info('code', `Analyzed code: ${filePath || 'inline'}`);
      return result;
    } catch (err: any) {
      logger.error('code', `Analysis failed: ${err.message}`);
      return `Error analizando código: ${err.message}`;
    }
  }

  async debugCode(code: string, errorMessage: string): Promise<string> {
    if (!this.llmClient) return 'LLM no disponible para debug.';

    try {
      const prompt = `Este código tiene un error. Encontrá el bug y proveé la corrección.

Código:
\`\`\`
${code}
\`\`\`

Error:
${errorMessage}

Respondé con:
1. Causa del error
2. Código corregido completo
3. Explicación breve del fix`;

      const result = await this.llmClient.chatCompletion(
        [{ role: 'user', content: prompt }],
        2048
      );
      logger.info('code', `Debugged code (error: ${errorMessage.slice(0, 60)})`);
      return result;
    } catch (err: any) {
      logger.error('code', `Debug failed: ${err.message}`);
      return `Error debugueando: ${err.message}`;
    }
  }

  async refactorCode(code: string, instructions: string = ''): Promise<string> {
    if (!this.llmClient) return 'LLM no disponible para refactorizar.';

    try {
      const prompt = `Refactorizá este código${instructions ? ` con estos criterios: ${instructions}` : ' mejorando legibilidad, performance y mantenibilidad'}.

Código:
\`\`\`
${code}
\`\`\`

Respondé con el código refactorizado completo.`;

      const result = await this.llmClient.chatCompletion(
        [{ role: 'user', content: prompt }],
        2048
      );
      logger.info('code', `Refactored code`);
      return result;
    } catch (err: any) {
      logger.error('code', `Refactor failed: ${err.message}`);
      return `Error refactorizando: ${err.message}`;
    }
  }
}

export const codeTool = CodeTool.getInstance();
