/**
 * Atlas Terminal Tool v2 — Production-grade shell command execution
 * 
 * Patterns from: LangChain ShellTool, Codex CLI, Claude Code, OpenAI Agents SDK
 * - spawn with process group for reliable kill (SIGTERM → grace → SIGKILL)
 * - Separate stdout/stderr streaming
 * - Structured result type
 * - Encoding-aware, output-capped
 * - Cross-platform (Unix process groups, Windows direct kill)
 */

import { spawn, SpawnOptions } from 'child_process';
import { platform } from 'os';
import { logger } from '../../common/logger.js';
import { toolGuardian } from '../../shield/tool_guardian.js';

const IS_WIN = platform() === 'win32';
const SHELL = IS_WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/bash';
const SHELL_ARG = IS_WIN ? '/C' : '-c';

const DEFAULT_TIMEOUT_MS = 30_000;
const GRACE_PERIOD_MS = 2_000;
const MAX_OUTPUT_BYTES = 1_048_576; // 1MB per stream

const BLOCKED_PATTERNS = [
  /^sudo\s/i, /^su\s/i, /^doas\s/i,
  /^passwd/i, /^chpasswd/i,
  /^chmod\s.*777/i, /^chown\s/i,
  /^dd\s/i, /^mkfs/i, /^fdisk/i, /^parted/i, /^mount/i, /^umount/i,
  /^mkswap/i, /^swapon/i, /^swapoff/i,
  /^iptables/i, /^ufw\s/i,
  /:\(\)\s*\{/,
  /^systemctl/i, /^service\s/i,
];

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  command: string;
}

export class TerminalTool {
  private static instance: TerminalTool;

  private constructor() {}

  static getInstance(): TerminalTool {
    if (!TerminalTool.instance) {
      TerminalTool.instance = new TerminalTool();
    }
    return TerminalTool.instance;
  }

  async execute(
    command: string,
    options?: {
      timeout?: number;
      cwd?: string;
      env?: Record<string, string>;
      maxOutput?: number;
    }
  ): Promise<ExecResult> {
    const guard = toolGuardian.canUseTool('shell_execute');
    if (!guard.allowed) {
      return {
        stdout: '',
        stderr: '',
        exitCode: 1,
        timedOut: false,
        truncated: false,
        command,
      };
    }

    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(command.trim())) {
        logger.warn('terminal', `Blocked command: ${command.slice(0, 100)}`);
        return {
          stdout: '',
          stderr: 'Comando bloqueado por seguridad.',
          exitCode: 1,
          timedOut: false,
          truncated: false,
          command,
        };
      }
    }

    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    const maxOutput = options?.maxOutput ?? MAX_OUTPUT_BYTES;

    const spawnOpts: SpawnOptions = {
      cwd: options?.cwd,
      env: options?.env ? { ...process.env, ...options.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Create a new process group on Unix for reliable kill
      ...(IS_WIN ? {} : { detached: false }),
    };

    logger.info('terminal', `Exec: ${command.slice(0, 120)}`);

    const child = spawn(SHELL, [SHELL_ARG, command], spawnOpts);

    // On Unix, set the child's process group to its own PID so we can kill the whole tree
    let childPid: number | undefined;
    if (!IS_WIN && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 0);
        childPid = -child.pid;
      } catch {
        childPid = child.pid;
      }
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let truncated = false;

    const stdoutReader = (chunk: Buffer) => {
      const remaining = maxOutput - stdoutLen;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const slice = chunk.subarray(0, remaining);
      stdoutChunks.push(slice);
      stdoutLen += slice.length;
    };

    const stderrReader = (chunk: Buffer) => {
      const remaining = maxOutput - stderrLen;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const slice = chunk.subarray(0, remaining);
      stderrChunks.push(slice);
      stderrLen += slice.length;
    };

    if (child.stdout) child.stdout.on('data', stdoutReader);
    if (child.stderr) child.stderr.on('data', stderrReader);

    const killProcessTree = () => {
      if (child.pid === undefined) return;
      try {
        if (!IS_WIN && childPid !== undefined) {
          process.kill(childPid, 'SIGTERM');
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        // May already be dead
      }
    };

    const timeoutHandle = setTimeout(() => {
      killProcessTree();
      // Grace period then force kill
      setTimeout(() => {
        try {
          if (!IS_WIN && childPid !== undefined) {
            process.kill(childPid, 'SIGKILL');
          } else {
            child.kill('SIGKILL');
          }
        } catch {
          // Already dead
        }
      }, GRACE_PERIOD_MS);
    }, timeout);

    return new Promise<ExecResult>((resolve) => {
      let settled = false;
      const settle = (timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);

        const decode = (chunks: Buffer[]): string =>
          Buffer.concat(chunks).toString('utf-8').trimEnd();

        let stderr = decode(stderrChunks);
        if (timedOut) {
          const msg = `[Timeout] El comando no respondio en ${timeout}ms`;
          stderr = stderr ? stderr + '\n' + msg : msg;
        }

        const result: ExecResult = {
          stdout: decode(stdoutChunks),
          stderr,
          exitCode: timedOut ? -1 : (child.exitCode ?? 1),
          timedOut,
          truncated,
          command,
        };

        logger.info('terminal', `Done (exit: ${result.exitCode}, out: ${result.stdout.length}, err: ${result.stderr.length}, timeout: ${result.timedOut})`);
        resolve(result);
      };

      child.on('error', (err) => {
        logger.error('terminal', `Spawn error: ${err.message}`);
        settle(false);
      });

      child.on('exit', (_code, signal) => {
        const timedOut = signal === 'SIGTERM' || signal === 'SIGKILL';
        // On timeout the exit already triggered — just collect rest and settle
        if (timedOut) {
          settle(true);
        } else {
          // Small delay to drain remaining output buffers
          setTimeout(() => settle(false), 50);
        }
      });
    });
  }
}

export const terminalTool = TerminalTool.getInstance();
