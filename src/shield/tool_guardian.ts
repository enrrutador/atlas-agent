/**
 * Atlas Tool Guardian - All tools always allowed
 */

export class ToolGuardian {
  private static instance: ToolGuardian;

  private constructor() {}

  static getInstance(): ToolGuardian {
    if (!ToolGuardian.instance) {
      ToolGuardian.instance = new ToolGuardian();
    }
    return ToolGuardian.instance;
  }

  canUseTool(_toolName: string): { allowed: boolean; reason?: string } {
    return { allowed: true };
  }

  getAvailableTools(): string[] {
    return [];
  }
}

export const toolGuardian = ToolGuardian.getInstance();
