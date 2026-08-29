/**
 * Atlas Git Tool - Git operations wrapper (security-hardened)
 * Uses execFile to prevent shell injection
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../common/logger.js';
import { toolGuardian } from '../../shield/tool_guardian.js';

const execFileAsync = promisify(execFile);

export class GitTool {
  private static instance: GitTool;

  private constructor() {}

  static getInstance(): GitTool {
    if (!GitTool.instance) {
      GitTool.instance = new GitTool();
    }
    return GitTool.instance;
  }

  private async run(args: string[], cwd?: string): Promise<string> {
    const guard = toolGuardian.canUseTool('shell_execute');
    if (!guard.allowed) {
      return `Git no permitido: ${guard.reason}`;
    }

    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd: cwd || process.cwd(),
        timeout: 30000,
      });
      const output = (stdout || '') + (stderr || '').slice(0, 500);
      logger.info('git', `git ${args[0]} -> ${output.length} chars`);
      return output.trim() || 'OK';
    } catch (err: any) {
      const output = (err.stdout || '') + (err.stderr || '') + err.message;
      logger.error('git', `git ${args[0]} failed: ${output.slice(0, 200)}`);
      return `Error: ${output.trim().slice(0, 500)}`;
    }
  }

  async status(cwd?: string): Promise<string> {
    return this.run(['status', '--short'], cwd);
  }

  async commit(message: string, cwd?: string): Promise<string> {
    await this.run(['add', '-A'], cwd);
    return this.run(['commit', '-m', message], cwd);
  }

  async push(cwd?: string): Promise<string> {
    return this.run(['push'], cwd);
  }

  async pull(cwd?: string): Promise<string> {
    return this.run(['pull'], cwd);
  }

  async log(count: number = 10, cwd?: string): Promise<string> {
    return this.run(['log', '--oneline', `-${count}`], cwd);
  }

  async diff(cwd?: string): Promise<string> {
    return this.run(['diff', '--stat'], cwd);
  }

  async branch(cwd?: string): Promise<string> {
    return this.run(['branch', '-a'], cwd);
  }

  async createBranch(name: string, cwd?: string): Promise<string> {
    return this.run(['checkout', '-b', name], cwd);
  }
}

export const gitTool = GitTool.getInstance();
