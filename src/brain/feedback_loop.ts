import { logger } from '../common/logger.js';
import { QueryCategory, DataSource, FeedbackType, FeedbackEntry } from '../common/types.js';
import { generateId } from '../common/utils.js';

const CORRECTION_PATTERNS: RegExp[] = [
  /no(?:\s*,?\s*eso\s+no|,?\s*esta\s+mal)|incorrecto|esta\s+mal|mal|wrong|not\s+right|that'?s?\s+wrong|no\s+es\s+asi|no\s+es\s+eso/i,
  /la\s+respuesta\s+(?:correcta|verdadera|real)\s+es|actually|the\s+correct\s+answer/i,
  /en\s+realidad\s+(?!busc|quer|busq|necesit|quiero)(?=\w)/i,
  /mejor(?:\s+respuesta|asi|asi)|mas\s+preciso|mas\s+preciso|more\s+accurate/i,
  /quiero\s+(?:otra|una\s+mejor|una\s+diferente)|busca\s+de\s+nuevo|proba\s+de\s+nuevo|intenta\s+de\s+nuevo|try\s+again/i,
];

const CONFIRMATION_STARTERS = new Set([
  'si', 'exacto', 'correcto', 'bien', 'perfecto', 'genial', 'dale', 'ok',
  'yes', 'right', 'exactly', 'correct', 'perfect', 'great',
]);

const CONFIRMATION_ALLOWED_WORDS = new Set([
  'si', 'exacto', 'correcto', 'bien', 'perfecto', 'genial', 'dale', 'ok',
  'yes', 'right', 'exactly', 'correct', 'perfect', 'great', 'spot', 'on',
  'eso', 'es', 'hecho', 'gracias', 'thank', 'thx', 'muy', 'ahi',
  'sabia', 'maravilloso', 'increible', 'excelente', 'barbaro',
  'fantastico', 'magnifico', 'super', 'mucho', 'mil', 'punto',
]);

const CONFIRMATION_PHRASE_PATTERNS: RegExp[] = [
  /(?:eso\s+es|eso\s+esta|asi\s+es|esta\s+bien|esa\s+es\s+la|muy\s+bien|bien\s+ahi)/i,
];

const REJECTION_PATTERNS: RegExp[] = [
  /no\s+(?:sirve|sirvio|funciona|funciono|me\s+gusta|quiero|necesito)|(?:no\s+)?entiendo|confuso|no\s+(?:tiene\s+)?sentido/i,
  /(?:eso\s+no\s+(?:es|esta|sirve|sirvio)|respuesta\s+inutil|perdi\s+el\s+tiempo)/i,
];

const CLARIFICATION_PATTERNS: RegExp[] = [
  /(?:me\s+referia\s+a|queria\s+decir|o\s+sea|es\s+decir|me\s+explico|no\s+me\s+expliq?\s+bien)/i,
  /(?:lo\s+que\s+quiero\s+es|lo\s+que\s+busco\s+es|en\s+realidad\s+busc(?:o|aba|ar)|en\s+realidad\s+quer(?:ia|ia\s+decir))/i,
];

export class FeedbackLoop {
  private static instance: FeedbackLoop;
  private feedbackHistory: FeedbackEntry[] = [];
  private categorySourceScores: Map<string, number> = new Map();
  private maxHistory = 200;
  private adjustmentDecay = 0.95;

  private constructor() {
    this.initializeScores();
  }

  static getInstance(): FeedbackLoop {
    if (!FeedbackLoop.instance) {
      FeedbackLoop.instance = new FeedbackLoop();
    }
    return FeedbackLoop.instance;
  }

  setLLMClient(_client: any): void {
  }

  private initializeScores(): void {
    const categories: QueryCategory[] = ['general', 'memory', 'project', 'code', 'web', 'tool'];
    const sources: DataSource[] = ['llm', 'memory_store', 'file_system', 'git', 'web_search', 'web_scrape', 'skill_direct', 'llm_with_context', 'llm_synthesis', 'llm_confirm'];

    for (const cat of categories) {
      for (const src of sources) {
        this.categorySourceScores.set(`${cat}:${src}`, 0);
      }
    }
  }

  detectFeedback(userMessage: string, _context?: string[]): FeedbackType | null {
    const raw = userMessage.trim();
    const trimmed = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    for (const p of CORRECTION_PATTERNS) {
      if (p.test(trimmed)) return 'correction';
    }

    for (const p of REJECTION_PATTERNS) {
      if (p.test(trimmed)) return 'rejection';
    }

    for (const p of CLARIFICATION_PATTERNS) {
      if (p.test(trimmed)) return 'clarification';
    }

    for (const p of CONFIRMATION_PHRASE_PATTERNS) {
      if (p.test(trimmed)) return 'confirmation';
    }

    const words = trimmed.split(/[\s,!.?]+/).filter(w => w.length > 0);
    if (words.length > 0 && CONFIRMATION_STARTERS.has(words[0])) {
      const allAllowed = words.every(w => CONFIRMATION_ALLOWED_WORDS.has(w));
      if (allAllowed) return 'confirmation';
    }

    return null;
  }

  recordFeedback(
    query: string,
    category: QueryCategory,
    source: DataSource,
    originalResponse: string,
    feedbackType: FeedbackType,
    userMessage: string,
  ): FeedbackEntry {
    const confidenceAdjustment = this.calculateAdjustment(feedbackType, category, source);

    const entry: FeedbackEntry = {
      id: generateId(),
      query,
      category,
      source,
      originalResponse,
      feedbackType,
      userCorrection: feedbackType === 'correction' || feedbackType === 'clarification' ? userMessage : undefined,
      timestamp: Date.now(),
      confidenceAdjustment,
    };

    this.feedbackHistory.push(entry);
    if (this.feedbackHistory.length > this.maxHistory) {
      this.feedbackHistory.shift();
    }

    this.applyAdjustment(category, source, confidenceAdjustment);

    logger.info('feedback_loop', `Feedback: ${feedbackType} for ${category}:${source} (adjustment: ${confidenceAdjustment > 0 ? '+' : ''}${confidenceAdjustment.toFixed(3)})`);

    return entry;
  }

  getAdjustedConfidence(category: QueryCategory, source: DataSource, baseConfidence: number): number {
    const key = `${category}:${source}`;
    const adjustment = this.categorySourceScores.get(key) || 0;
    const adjusted = Math.max(0, Math.min(1, baseConfidence + adjustment));

    if (Math.abs(adjustment) > 0.05) {
      logger.debug('feedback_loop', `Adjusted confidence ${category}:${source}: ${baseConfidence.toFixed(2)} → ${adjusted.toFixed(2)} (adj: ${adjustment.toFixed(3)})`);
    }

    return adjusted;
  }

  getStats(): { totalFeedback: number; byType: Record<FeedbackType, number>; recentAdjustments: Array<{ category: QueryCategory; source: DataSource; score: number }> } {
    const byType: Record<FeedbackType, number> = { correction: 0, confirmation: 0, rejection: 0, clarification: 0 };
    for (const entry of this.feedbackHistory) {
      byType[entry.feedbackType]++;
    }

    const recentAdjustments: Array<{ category: QueryCategory; source: DataSource; score: number }> = [];
    for (const [key, score] of this.categorySourceScores) {
      if (Math.abs(score) > 0.01) {
        const [category, source] = key.split(':') as [QueryCategory, DataSource];
        recentAdjustments.push({ category, source, score });
      }
    }

    return {
      totalFeedback: this.feedbackHistory.length,
      byType,
      recentAdjustments: recentAdjustments.sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 20),
    };
  }

  applyDailyDecay(): void {
    for (const [key, score] of this.categorySourceScores) {
      const decayed = score * this.adjustmentDecay;
      if (Math.abs(decayed) < 0.005) {
        this.categorySourceScores.set(key, 0);
      } else {
        this.categorySourceScores.set(key, decayed);
      }
    }
    logger.info('feedback_loop', 'Applied daily confidence decay');
  }

  getCorrectionForQuery(query: string, category: QueryCategory): string | null {
    const normalized = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

    for (let i = this.feedbackHistory.length - 1; i >= 0; i--) {
      const entry = this.feedbackHistory[i];
      if (entry.category !== category) continue;
      if (entry.feedbackType !== 'correction' && entry.feedbackType !== 'clarification') continue;

      const entryNormalized = entry.query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
      const similarity = this.computeSimilarity(normalized, entryNormalized);

      if (similarity >= 0.7 && entry.userCorrection) {
        return entry.userCorrection;
      }
    }

    return null;
  }

  private calculateAdjustment(feedbackType: FeedbackType, _category: QueryCategory, _source: DataSource): number {
    switch (feedbackType) {
      case 'confirmation':
        return 0.05;
      case 'correction':
        return -0.10;
      case 'rejection':
        return -0.15;
      case 'clarification':
        return -0.03;
      default:
        return 0;
    }
  }

  private applyAdjustment(category: QueryCategory, source: DataSource, delta: number): void {
    const key = `${category}:${source}`;
    const current = this.categorySourceScores.get(key) || 0;
    const clamped = Math.max(-0.5, Math.min(0.5, current + delta));
    this.categorySourceScores.set(key, clamped);
  }

  private computeSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (!a || !b) return 0;

    const wordsA = new Set(a.split(' '));
    const wordsB = new Set(b.split(' '));
    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }
}

export const feedbackLoop = FeedbackLoop.getInstance();
