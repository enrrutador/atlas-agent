/**
 * Atlas Forge Skill Auto-Generator - Creates new skills on the fly
 * When Forge identifies a gap in Brain's capabilities, it generates a skill
 * Skills are persisted and registered with BrainSkills
 */

import { logger } from '../../common/logger.js';
import { Skill } from '../../common/types.js';
import { generateId } from '../../common/utils.js';
import { brainSkills } from '../../brain/skills.js';
import fs from 'fs';
import path from 'path';

const GENERATED_SKILLS_DIR = path.join(process.cwd(), 'data', 'generated_skills');

export interface GeneratedSkill extends Skill {
  id: string;
  generatedAt: number;
  source: 'forge' | 'user';
  code?: string;
}

export class AutoSkillGenerator {
  private static instance: AutoSkillGenerator;
  private generatedSkills: Map<string, GeneratedSkill> = new Map();

  private constructor() {
    if (!fs.existsSync(GENERATED_SKILLS_DIR)) {
      fs.mkdirSync(GENERATED_SKILLS_DIR, { recursive: true });
    }
    this.loadSaved();
  }

  static getInstance(): AutoSkillGenerator {
    if (!AutoSkillGenerator.instance) {
      AutoSkillGenerator.instance = new AutoSkillGenerator();
    }
    return AutoSkillGenerator.instance;
  }

  async generate(name: string, description: string, template: string, _trustRequired: number = 3): Promise<GeneratedSkill> {
    logger.info('auto_skill_generator', `Generating skill: ${name}`);

    const handler = this.createHandlerFromTemplate(name, template);

    const skill: GeneratedSkill = {
      id: generateId('skill'),
      name,
      description,
      parameters: [],
      handler,
      generatedAt: Date.now(),
      source: 'forge',
      code: template,
    };

    this.generatedSkills.set(skill.id, skill);
    brainSkills.register(skill);
    this.saveSkill(skill);

    logger.info('auto_skill_generator', `Generated and registered: ${name} (${skill.id})`);
    return skill;
  }

  listGenerated(): GeneratedSkill[] {
    return Array.from(this.generatedSkills.values());
  }

  private createHandlerFromTemplate(name: string, template: string): (args: Record<string, any>) => Promise<any> {
    return async (args: Record<string, any>) => {
      // For now, return the template with args interpolated
      // In production, this would use the Python bridge or a sandboxed executor
      logger.info('auto_skill_generator', `Executing generated skill: ${name}`);
      return {
        skill: name,
        args,
        template,
        result: 'Generated skill executed (template-based)',
      };
    };
  }

  private saveSkill(skill: GeneratedSkill): void {
    try {
      const filePath = path.join(GENERATED_SKILLS_DIR, `${skill.name}.json`);
      fs.writeFileSync(filePath, JSON.stringify(skill, null, 2));
    } catch (err) {
      logger.error('auto_skill_generator', `Save failed: ${err}`);
    }
  }

  private loadSaved(): void {
    try {
      if (!fs.existsSync(GENERATED_SKILLS_DIR)) return;
      const files = fs.readdirSync(GENERATED_SKILLS_DIR).filter(f => f.endsWith('.json'));

      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(GENERATED_SKILLS_DIR, file), 'utf-8'));
          const handler = this.createHandlerFromTemplate(data.name, data.code || '');
          const skill: GeneratedSkill = { ...data, handler };
          this.generatedSkills.set(skill.id, skill);
          brainSkills.register(skill);
        } catch {
          // Skip corrupted files
        }
      }

      logger.info('auto_skill_generator', `Loaded ${this.generatedSkills.size} generated skills`);
    } catch (err) {
      logger.warn('auto_skill_generator', `Load failed: ${err}`);
    }
  }
}

export const autoSkillGenerator = AutoSkillGenerator.getInstance();
