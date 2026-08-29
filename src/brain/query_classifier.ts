import { logger } from '../common/logger.js';
import { QueryCategory, ClassificationResult } from '../common/types.js';

const CLASSIFIER_SYSTEM_PROMPT = `You are a query classifier. Classify into EXACTLY ONE category. Reply with ONLY the category word.

Categories:
- general: ANY knowledge the LLM already knows (geography, history, science, definitions, culture, math calculations, translations, greetings, chat, opinions, "what is", "who is", "where is", "how many", "when did")
- memory: Personal memory (remember X, what did we discuss, our conversation, recall something)
- project: Current project/workspace (codebase, repo, workspace files, show me the code)
- code: Code generation/debugging (write a function, fix this bug, analyze code, implement feature)
- web: ONLY time-sensitive current info (weather NOW, price TODAY, news TODAY, current events, latest)
- tool: Direct action execution (execute command, create/delete/download file, git operation)

KEY RULE: If the user asks a factual question that does NOT change over time, it is "general" NOT "web". Only "web" if the answer changes daily (weather, prices, news).`;

const REGEX_RULES: Array<{ category: QueryCategory; patterns: RegExp[]; confidence: number }> = [
  {
    category: 'general',
    confidence: 0.92,
    patterns: [
      /donde (queda|esta|se encuentra|es)/i,
      /cual es la capital/i,
      /quien (fue|es|escribio|pinto|invento|descubrio|compuso)/i,
      /que (es|significa|quiere decir)/i,
      /cuando (fue|se|nacio|murio|termino|empezo)/i,
      /como se (dice|llama|llamaba|escribe)/i,
      /en que (anio|fecha|siglo|continente)/i,
      /cuantos (habitantes|km|metros|anos)/i,
      /^que (sabes|puedes)/i,
      /^(hola|hey|buenas|que tal|como estas|como andas|buen dia|buenos dias|buenas noches)/i,
      /^(gracias|thx|thanks|genial|perfecto|dale|ok|si|no|bien|chau|adios|nos vemos)[\s.!?]*$/i,
      /cuanto es|cuanto da|cuanto resulta|suma|resta|multiplica|dividi/i,
      /traduc[ei]|translate|como se dice/i,
      /que edad tiene|cuando nacio|cuando murio|quien fue|que fue|que hizo/i,
      /fotosintesis|gravedad|relatividad|atomos|celula|evolucion|democracia|renacimiento/i,
      /^contame|decime|explicame|contame\s+(?:algo|un|una|de|sobre)/i,
    ],
  },
  {
    category: 'memory',
    confidence: 0.90,
    patterns: [
      /que (hablamos|dimos|charlamos|conversamos|platicamos) (la ultima vez|ayer|antes|la vez pasada)/i,
      /recorda|recordá|recuerda|acordate/i,
      /que (guard|almacen|memoriz|guarde|anote)/i,
      /olvid(e|é)|no me acuerdo|perdí el contexto/i,
      /session anterior|sesion anterior|ultima (sesion|conversacion|charla)/i,
      /que (sabes|tenes|tienes) en memoria sobre/i,
      /historial|history/i,
    ],
  },
  {
    category: 'web',
    confidence: 0.90,
    patterns: [
      /como (esta|esta|esta) el clima|pronostico|temperatura (de|en|actual|hoy)/i,
      /a cuanto (esta|cotiza|vale) (el|la)?\s*(dolar|euro|bitcoin|cripto)/i,
      /noticias|ultimas (noticias|novedades)|que paso (hoy|ayer|esta semana)/i,
      /precio (del|de la|actual|hoy)|cotizacion (del|de la)/i,
      /resultados? (de|del) (partido|futbol|liga|copa)/i,
      /que (paso|pasa|esta pasando) (hoy|ahora|actualmente|en el mundo|en argentina)/i,
      /busca (en internet|en la web|online)|buscá en internet/i,
      /ultim[oa]s? (noticias|novedades|resultados|precios|cotizaciones)/i,
    ],
  },
  {
    category: 'tool',
    confidence: 0.90,
    patterns: [
      /^(ejecut[áa]|corré|corre|run|execute)\s+/i,
      /en la terminal|shell|bash|cmd/i,
      /^(cre[áa]|crear|elimin[áa]|borr[áa]|descarg[áa]|baj[áa])\s+(el|la|un|una)?\s*(archivo|file|directorio|carpeta|folder)/i,
      /^(git|commit|push|pull|branch|merge|clone)\s+/i,
      /guard[áa] (en|el|la) (archivo|file|memoria)/i,
      /^(ls|list|dir|cat|head|tail|chmod|chown|cp|mv|mkdir|rmdir)\s+/i,
    ],
  },
  {
    category: 'code',
    confidence: 0.88,
    patterns: [
      /escrib[íi]|program[áa]|implement[áa]|desarroll[áa]|cre[áa]\s+(un[ao]?\s+)?(funcion|function|clase|class|componente|component|api|endpoint|script|modulo|module)/i,
      /debug|fixear|arregl[áa]|correg[íi]r?|solucion[áa]/i,
      /code (review|analyze|generate|debug)|analiz[áa] (el |este )?c[óo]digo/i,
      /error en (el |este )?(c[óo]digo|code|script|programa)/i,
      /refactor|optimiz[áa]|revis[áa] (el |este )?c[óo]digo/i,
    ],
  },
  {
    category: 'project',
    confidence: 0.88,
    patterns: [
      /que (archivos|carpetas|directorios|files) hay (en|en el|en la)/i,
      /mostr[áa]|ver|listar (el |la |los )?(repo|proyecto|workspace|codebase|directorio)/i,
      /que (hay en|tiene) (el |la |este )?(repo|proyecto|workspace|codebase)/i,
      /estructura del (proyecto|repo|workspace)/i,
      /que (tecnolog[ií]a|stack|framework|librer[ií]a) usa/i,
    ],
  },
];

export class QueryClassifier {
  private static instance: QueryClassifier;
  private llmClient: any = null;
  private classifierModel: string = 'nvidia/nemotron-mini-4b-instruct';
  private timeoutMs: number = 3000;

  private constructor() {}

  static getInstance(): QueryClassifier {
    if (!QueryClassifier.instance) {
      QueryClassifier.instance = new QueryClassifier();
    }
    return QueryClassifier.instance;
  }

  setLLMClient(client: any): void {
    this.llmClient = client;
  }

  setClassifierModel(model: string): void {
    this.classifierModel = model;
  }

  setTimeoutMs(ms: number): void {
    this.timeoutMs = ms;
  }

  async classify(input: string): Promise<ClassificationResult> {
    const normalized = input.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

    for (const rule of REGEX_RULES) {
      for (const pattern of rule.patterns) {
        if (pattern.test(normalized)) {
          const subIntent = this.detectSubIntent(normalized, rule.category);
          logger.info('query_classifier', `Regex match: "${input.slice(0, 60)}" → ${rule.category} (${rule.confidence}) [${subIntent || 'none'}]`);
          return {
            category: rule.category,
            confidence: rule.confidence,
            source: 'regex',
            subIntent,
          };
        }
      }
    }

    if (this.llmClient) {
      try {
        const llmResult = await this.classifyWithLLM(input);
        if (llmResult) {
          logger.info('query_classifier', `LLM classify: "${input.slice(0, 60)}" → ${llmResult.category} (${llmResult.confidence}) [${llmResult.source}]`);
          return llmResult;
        }
      } catch (err) {
        logger.warn('query_classifier', `LLM classify failed: ${err}`);
      }
    }

    logger.info('query_classifier', `Fallback: "${input.slice(0, 60)}" → general`);
    return {
      category: 'general',
      confidence: 0.5,
      source: 'fallback',
    };
  }

  private async classifyWithLLM(input: string): Promise<ClassificationResult | null> {
    const axios = (await import('axios')).default;
    const apiKey = process.env.OPENAI_API_KEY || '';
    const baseUrl = process.env.OPENAI_BASE_URL || 'https://integrate.api.nvidia.com/v1';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await axios.post(
        `${baseUrl}/chat/completions`,
        {
          model: this.classifierModel,
          messages: [
            { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
            { role: 'user', content: input },
          ],
          temperature: 0.1,
          max_tokens: 10,
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
          timeout: this.timeoutMs,
        }
      );

      clearTimeout(timer);

      const raw = (response.data?.choices?.[0]?.message?.content || '').trim().toLowerCase();
      const category = this.parseCategory(raw);
      const subIntent = this.detectSubIntent(input.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''), category);

      return {
        category,
        confidence: 0.80,
        source: 'llm',
        subIntent,
        rawResponse: raw,
      };
    } catch (err: any) {
      clearTimeout(timer);
      if (err.code === 'ECONNABORTED' || err.code === 'ERR_CANCELED' || err.message?.includes('timeout') || err.name === 'AbortError' || err.message?.includes('cancel')) {
        logger.warn('query_classifier', 'LLM classify timed out');
        return null;
      }
      throw err;
    }
  }

  private parseCategory(raw: string): QueryCategory {
    const cleaned = raw.replace(/[^a-z]/g, '');
    const categoryMap: Record<string, QueryCategory> = {
      'general': 'general',
      'memory': 'memory',
      'project': 'project',
      'code': 'code',
      'web': 'web',
      'tool': 'tool',
      'greetings': 'general',
      'chat': 'general',
      'greeting': 'general',
      'conversation': 'general',
      'knowledge': 'general',
      'fact': 'general',
      'math': 'general',
      'translation': 'general',
      'translate': 'general',
      'action': 'tool',
      'execute': 'tool',
      'shell': 'tool',
      'terminal': 'tool',
      'search': 'web',
      'news': 'web',
      'weather': 'web',
      'current': 'web',
      'debug': 'code',
      'programming': 'code',
      'development': 'code',
      'repo': 'project',
      'repository': 'project',
      'workspace': 'project',
      'codebase': 'project',
    };
    return categoryMap[cleaned] || 'general';
  }

  private detectSubIntent(normalized: string, category: QueryCategory): string | undefined {
    if (category === 'web') {
      if (/clima|pronostico|temperatura|weather|lluvia|soleado|nublado/.test(normalized)) return 'weather';
      if (/dolar|euro|precio|cotiz|bitcoin|cripto|mercado/.test(normalized)) return 'price';
      if (/notici|new|actualidad|ultimo|breaking|novedad/.test(normalized)) return 'news';
      if (/resultado|partido|deporte|futbol|liga|copa/.test(normalized)) return 'sports';
      if (/horoscopo|signo|zodiaco/.test(normalized)) return 'horoscope';
    }
    if (category === 'tool') {
      if (/ejecut|corr|run|terminal|shell|bash|cmd|comando/.test(normalized)) return 'shell';
      if (/cre[áa]|crear|guard|save|write/.test(normalized)) return 'file_write';
      if (/elimin|borrar|delete|remove/.test(normalized)) return 'file_delete';
      if (/descarg|download|baj/.test(normalized)) return 'download';
      if (/git|commit|push|pull|branch/.test(normalized)) return 'git';
    }
    if (category === 'code') {
      if (/debug|fix|error|bug|arregl|correg/.test(normalized)) return 'debug';
      if (/escrib|gener|cre[áa]|program|implement|desarroll/.test(normalized)) return 'generate';
      if (/analiz|revis|review|audit/.test(normalized)) return 'analyze';
    }
    if (category === 'general') {
      if (/hola|hey|buenas|que tal|como andas|como estas/.test(normalized)) return 'greeting';
      if (/traduc|translate|como se dice/.test(normalized)) return 'translation';
      if (/cuanto es|calcul|matemat|suma|resta|multiplica|dividi/.test(normalized)) return 'math';
      if (/donde|capital|ubic|geograf/.test(normalized)) return 'geography';
      if (/quien|historia|biograf|cuando nacio|cuando murio/.test(normalized)) return 'history';
    }
    if (category === 'memory') {
      if (/recorda|recuerda|acordate/.test(normalized)) return 'recall';
      if (/guard|almacen|memoriz|anot/.test(normalized)) return 'store';
    }
    return undefined;
  }
}

export const queryClassifier = QueryClassifier.getInstance();
