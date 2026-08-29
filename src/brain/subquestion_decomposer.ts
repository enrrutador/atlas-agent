import { logger } from '../common/logger.js';
import { ClassificationResult } from '../common/types.js';
import { queryClassifier } from './query_classifier.js';

export interface SubQuestion {
  text: string;
  classification: ClassificationResult;
  index: number;
}

export interface DecompositionResult {
  original: string;
  subQuestions: SubQuestion[];
  isCompound: boolean;
  strategy: 'sequential' | 'parallel' | 'single';
}

const COMPOUND_INDICATORS: RegExp[] = [
  /[,;]\s*(?:y\s+)?(?:tambi[eé]n|adem[aá]s|luego|despu[eé]s|tampoco|pero|aunque|mientras|sin embargo)\s+/i,
  /\s+(?:y\s+(?:tambi[eé]n|adem[aá]s|luego))\s+/i,
  /(?:y\s+tambi[eé]n|y\s+adem[aá]s|y\s+luego|y\s+despu[eé]s)\s+/i,
  /\?\s*[,.]?\s*(?:y\s+)?(?:tambi[eé]n|adem[aá]s|luego|despu[eé]s)/i,
  /\?\s*[,.]?\s*(?:y\s+)?(?:qu[eé]|qui[eé]n|c[oó]mo|cu[aá]ndo|d[oó]nde|cu[aá]nto|cu[aá]l|por qu[eé]|porqu[eé])\s+/i,
  /\?\s*[,.]?\s*(?:y\s+)?(?:what|who|how|when|where|how much|which|why)\s+/i,
  /(?:y\s+(?:a\s+|al\s+|de\s+|del\s+|en\s+)?(?:qu[eé]|qui[eé]n|c[oó]mo|cu[aá]ndo|d[oó]nde|cu[aá]nto|cu[aá]l|por\s+qu[eé]))\s+/i,
];

const SPLIT_PATTERNS: RegExp[] = [
  /\s+y\s+(?=(?:a\s+|al\s+|de\s+|del\s+|en\s+)?(?:qu[eé]|qui[eé]n|c[oó]mo|cu[aá]ndo|d[oó]nde|cu[aá]nto|cu[aá]l|por\s+qu[eé])\s+)/i,
  /(?:y\s+(?:tambi[eé]n|adem[aá]s|luego|despu[eé]s))\s+/i,
  /(?:,\s*(?:y\s+)?(?:tambi[eé]n|adem[aá]s|luego|despu[eé]s))\s+/i,
  /\?\s*[,.]?\s*(?=(?:y\s+)?(?:qu[eé]|qui[eé]n|c[oó]mo|cu[aá]ndo|d[oó]nde|cu[aá]nto|cu[aá]l|por\s+qu[eé]|porqu[eé]|what|who|how|when|where|which|why)\s+)/i,
];

const SINGLE_QUESTION_PATTERNS: RegExp[] = [
  /^(?:hola|hey|buenas|que\s+tal|como\s+andas|como\s+estas|gracias|thx|ok|dale|si|no|bien|chau|adios)/i,
  /^(?:que\s+(?:sabes|puedes)|cuales\s+son\s+tus|list.*skills|que\s+herramientas)/i,
];

export class SubQuestionDecomposer {
  private static instance: SubQuestionDecomposer;
  private llmClient: any = null;
  private classifierModel: string = 'nvidia/nemotron-mini-4b-instruct';
  private timeoutMs: number = 5000;

  private constructor() {}

  static getInstance(): SubQuestionDecomposer {
    if (!SubQuestionDecomposer.instance) {
      SubQuestionDecomposer.instance = new SubQuestionDecomposer();
    }
    return SubQuestionDecomposer.instance;
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

  async decompose(input: string): Promise<DecompositionResult> {
    const trimmed = input.trim();

    for (const p of SINGLE_QUESTION_PATTERNS) {
      if (p.test(trimmed)) {
        const classification = await queryClassifier.classify(trimmed);
        return {
          original: trimmed,
          subQuestions: [{ text: trimmed, classification, index: 0 }],
          isCompound: false,
          strategy: 'single',
        };
      }
    }

    const isCompound = this.detectCompound(trimmed);

    if (!isCompound) {
      const classification = await queryClassifier.classify(trimmed);
      return {
        original: trimmed,
        subQuestions: [{ text: trimmed, classification, index: 0 }],
        isCompound: false,
        strategy: 'single',
      };
    }

    const parts = this.splitCompound(trimmed);
    const subQuestions: SubQuestion[] = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      if (!part || part.length < 3) continue;

      const classification = await queryClassifier.classify(part);
      subQuestions.push({ text: part, classification, index: i });
    }

    if (subQuestions.length <= 1) {
      const classification = await queryClassifier.classify(trimmed);
      return {
        original: trimmed,
        subQuestions: [{ text: trimmed, classification, index: 0 }],
        isCompound: false,
        strategy: 'single',
      };
    }

    const categories = [...new Set(subQuestions.map(sq => sq.classification.category))];
    const hasWebOrTool = categories.some(c => c === 'web' || c === 'tool');
    const allGeneral = categories.every(c => c === 'general');
    const strategy: DecompositionResult['strategy'] =
      allGeneral ? 'parallel' :
      hasWebOrTool ? 'sequential' :
      'parallel';

    logger.info('subquestion_decomposer', `Compound query detected: "${trimmed.slice(0, 80)}" → ${subQuestions.length} sub-questions (${strategy})`);

    return {
      original: trimmed,
      subQuestions,
      isCompound: true,
      strategy,
    };
  }

  private detectCompound(input: string): boolean {
    const questionMarkCount = (input.match(/\?/g) || []).length;
    if (questionMarkCount > 1) return true;

    for (const p of COMPOUND_INDICATORS) {
      if (p.test(input)) return true;
    }

    return false;
  }

  private splitCompound(input: string): string[] {
    let parts: string[] = [input];

    for (const pattern of SPLIT_PATTERNS) {
      const newParts: string[] = [];
      for (const part of parts) {
        const split = part.split(pattern);
        if (split.length > 1) {
          newParts.push(...split.filter(s => s.trim().length > 0));
        } else {
          newParts.push(part);
        }
      }
      parts = newParts;
    }

    if (parts.length === 1 && (input.match(/\?/g) || []).length > 1) {
      parts = input.split(/\?/).map(p => p.trim()).filter(p => p.length > 0);
      parts = parts.map(p => p.endsWith('?') ? p : p + '?');
    }

    parts = parts.map(p => {
      p = p.trim();
      if (!p.includes('?')) p = p + '?';
      return p;
    });

    return parts;
  }

  async decomposeWithLLM(input: string): Promise<DecompositionResult> {
    if (!this.llmClient) {
      return this.decompose(input);
    }

    const isCompound = this.detectCompound(input);
    if (!isCompound) {
      return this.decompose(input);
    }

    try {
      const axios = (await import('axios')).default;
      const apiKey = process.env.OPENAI_API_KEY || '';
      const baseUrl = process.env.OPENAI_BASE_URL || 'https://integrate.api.nvidia.com/v1';

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await axios.post(
        `${baseUrl}/chat/completions`,
        {
          model: this.classifierModel,
          messages: [
            {
              role: 'system',
              content: `Dividí la consulta del usuario en sub-preguntas independientes. Respondé SOLO con un JSON array de strings, sin explicación.
Ejemplo: "¿Cómo está el clima en Mendoza y a cuánto está el dólar?" → ["¿Cómo está el clima en Mendoza?", "¿A cuánto está el dólar?"]
Si la consulta no es compuesta, respondé con un array de un solo elemento: ["consulta original"]`,
            },
            { role: 'user', content: input },
          ],
          temperature: 0.1,
          max_tokens: 200,
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

      const raw = (response.data?.choices?.[0]?.message?.content || '').trim();
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        logger.warn('subquestion_decomposer', `LLM decomposition returned invalid format: "${raw.slice(0, 100)}"`);
        return this.decompose(input);
      }

      const subTexts: string[] = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(subTexts) || subTexts.length === 0) {
        return this.decompose(input);
      }

      if (subTexts.length === 1) {
        const classification = await queryClassifier.classify(subTexts[0]);
        return {
          original: input,
          subQuestions: [{ text: subTexts[0], classification, index: 0 }],
          isCompound: false,
          strategy: 'single',
        };
      }

      const subQuestions: SubQuestion[] = [];
      for (let i = 0; i < subTexts.length; i++) {
        const text = subTexts[i].trim();
        if (!text || text.length < 3) continue;
        const classification = await queryClassifier.classify(text);
        subQuestions.push({ text, classification, index: i });
      }

      const categories = [...new Set(subQuestions.map(sq => sq.classification.category))];
      const strategy: DecompositionResult['strategy'] =
        categories.every(c => c === 'general') ? 'parallel' :
        categories.some(c => c === 'web' || c === 'tool') ? 'sequential' :
        'parallel';

      logger.info('subquestion_decomposer', `LLM decomposition: "${input.slice(0, 80)}" → ${subQuestions.length} sub-questions (${strategy})`);

      return {
        original: input,
        subQuestions,
        isCompound: true,
        strategy,
      };
    } catch (err) {
      logger.warn('subquestion_decomposer', `LLM decomposition failed, falling back to regex: ${err}`);
      return this.decompose(input);
    }
  }
}

export const subQuestionDecomposer = SubQuestionDecomposer.getInstance();
