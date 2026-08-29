/**
 * Atlas Forge Context Builder - Assembles context for Forge reasoning
 */

import { logger } from '../../common/logger.js';
import { ForgeInput } from '../../common/types.js';
import { brainSkills } from '../../brain/skills.js';

export class ForgeContext {
  private static instance: ForgeContext;

  private constructor() {}

  static getInstance(): ForgeContext {
    if (!ForgeContext.instance) {
      ForgeContext.instance = new ForgeContext();
    }
    return ForgeContext.instance;
  }

  buildContext(input: ForgeInput): string {
    const sections: string[] = [];

    // 1. Registered skills
    const skills = brainSkills.list();
    if (skills.length > 0) {
      sections.push(`REGISTERED SKILLS: ${skills.map(s => `${s.name} (${s.description})`).join('; ')}`);
    }

    // 2. Problem context (from input)
    if (input.context) {
      sections.push(`CONVERSATION CONTEXT:\n${input.context}`);
    }

    // 3. Mode
    sections.push(`FORGE MODE: ${input.mode || 'decision'}`);

    const full = sections.join('\n\n');
    logger.debug('forge_context', `Context built: ${full.length} chars`);
    return full;
  }
}

export const forgeContext = ForgeContext.getInstance();
