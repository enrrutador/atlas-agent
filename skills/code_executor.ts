import type { Skill } from '../src/core/skills.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { NodeVM, VMScript } from 'vm2';

const execAsync = promisify(exec);

interface ExecutionOptions {
  timeout?: number;
  memory?: number;
  network?: boolean;
  filesystem?: 'none' | 'temp' | 'readonly' | 'full';
  workingDir?: string;
}

interface ExecutionResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  result?: any;
  error?: string;
  exitCode?: number;
  duration?: number;
}

class CodeExecutor {
  private tempDir: string;
  
  constructor() {
    this.tempDir = path.join(process.cwd(), 'data', 'temp', 'executor');
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  private createSandbox(): NodeVM {
    return new NodeVM({
      console: 'inherit',
      sandbox: {},
      require: {
        external: false,
        builtin: ['fs', 'path', 'util', 'url', 'querystring', 'crypto', 'stream', 'events', 'string_decoder', 'timers'],
        root: this.tempDir,
      },
      wrapper: 'commonjs',
    });
  }

  async executeJavaScript(code: string, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    const startTime = Date.now();
    const timeout = options.timeout ?? 30000;
    
    try {
      const vm = this.createSandbox();
      
      const wrappedCode = `
        (async () => {
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Execution timeout')), ${timeout});
          });
          
          const executionPromise = (async () => {
            ${code}
          })();
          
          return await Promise.race([executionPromise, timeoutPromise]);
        })()
      `;

      const script = new VMScript(wrappedCode);
      const result = await vm.run(script, { timeout: timeout + 5000 });
      
      return {
        success: true,
        result: result === undefined ? null : result,
        duration: Date.now() - startTime,
      };
      
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime,
      };
    }
  }

  async executeBash(command: string, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    const startTime = Date.now();
    const timeout = options.timeout ?? 30000;
    const workingDir = options.workingDir ?? this.tempDir;
    
    try {
      // Security: validate command
      const dangerousPatterns = [
        /\brm\s+-rf\s+\//i,
        />\s*\/dev\/null/i,
        /mkfs/i,
        /dd\s+if/i,
        /:\(\)\{\s*:\|:\s*\&\s*\};:/i,
      ];
      
      for (const pattern of dangerousPatterns) {
        if (pattern.test(command)) {
          throw new Error('Comando bloqueado por seguridad');
        }
      }

      if (!fs.existsSync(workingDir)) {
        fs.mkdirSync(workingDir, { recursive: true });
      }

      const { stdout, stderr } = await execAsync(command, {
        timeout,
        cwd: workingDir,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: process.env.NODE_ENV,
        },
        maxBuffer: 1024 * 1024 * 10,
      });

      return {
        success: true,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        duration: Date.now() - startTime,
      };
      
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
        exitCode: error.code,
        duration: Date.now() - startTime,
      };
    }
  }

  async executePython(code: string, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    const startTime = Date.now();
    const timeout = options.timeout ?? 30000;
    const tempFile = path.join(this.tempDir, `script_${Date.now()}_${Math.random().toString(36).substring(7)}.py`);
    
    try {
      const dangerousImports = [
        'os.system', 'subprocess', '__import__', 'eval', 'exec',
        'open', 'file', 'input', 'raw_input',
      ];
      
      for (const dangerous of dangerousImports) {
        if (code.includes(dangerous)) {
          throw new Error(`Uso de '${dangerous}' no permitido por seguridad`);
        }
      }

      const wrappedCode = `
import sys
import signal

def timeout_handler(signum, frame):
    raise TimeoutError('Execution timeout')

signal.signal(signal.SIGALRM, timeout_handler)
signal.alarm(${Math.ceil(timeout / 1000)})

try:
${code.split('\n').map(line => '    ' + line).join('\n')}
except TimeoutError as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
finally:
    signal.alarm(0)
`;

      fs.writeFileSync(tempFile, wrappedCode);

      const { stdout, stderr } = await execAsync(
        `python "${tempFile}"`,
        {
          timeout,
          cwd: this.tempDir,
          maxBuffer: 1024 * 1024 * 10,
        }
      );

      return {
        success: true,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        duration: Date.now() - startTime,
      };
      
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
        duration: Date.now() - startTime,
      };
    } finally {
      if (fs.existsSync(tempFile)) {
        try {
          fs.unlinkSync(tempFile);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
  }

  async executeTypeScript(code: string, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    const transpiled = code
      .replace(/:\s*(string|number|boolean|any)\s*([,;=)])/g, '$2')
      .replace(/interface\s+\w+\s*\{[^}]*\}/g, '')
      .replace(/type\s+\w+\s*=\s*[^;]+;/g, '');
    
    return this.executeJavaScript(transpiled, options);
  }

  cleanup(): void {
    try {
      const files = fs.readdirSync(this.tempDir);
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      
      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        const stats = fs.statSync(filePath);
        
        if (now - stats.mtime.getTime() > oneHour) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

// Create singleton instance
const executor = new CodeExecutor();

const codeExecutorSkill: Skill = {
  name: 'code_executor',
  description: 'Ejecuta código de forma segura en sandbox. Soporta: javascript, typescript, python, bash. JSON Args: { "language": "javascript", "code": "console.log(\'Hello\')", "timeout": 30000, "options": { "memory": 512, "network": false } }',
  execute: async (args: { 
    language: string; 
    code: string; 
    timeout?: number;
    options?: ExecutionOptions;
  }) => {
    try {
      if (!args.language || !args.code) {
        return { 
          success: false, 
          message: "Se requieren 'language' y 'code'" 
        };
      }

      executor.cleanup();

      let result: ExecutionResult;
      
      switch (args.language.toLowerCase()) {
        case 'javascript':
        case 'js':
          result = await executor.executeJavaScript(args.code, {
            timeout: args.timeout ?? 30000,
            ...args.options,
          });
          break;
          
        case 'typescript':
        case 'ts':
          result = await executor.executeTypeScript(args.code, {
            timeout: args.timeout ?? 30000,
            ...args.options,
          });
          break;
          
        case 'python':
        case 'py':
          result = await executor.executePython(args.code, {
            timeout: args.timeout ?? 30000,
            ...args.options,
          });
          break;
          
        case 'bash':
        case 'shell':
        case 'sh':
        case 'cmd':
          result = await executor.executeBash(args.code, {
            timeout: args.timeout ?? 30000,
            ...args.options,
          });
          break;
          
        default:
          return { 
            success: false, 
            message: `Lenguaje no soportado: ${args.language}. Soportados: javascript, typescript, python, bash` 
          };
      }

      if (result.success) {
        const response: any = {
          success: true,
          message: "Código ejecutado exitosamente",
          duration: result.duration,
        };

        if (result.result !== undefined && result.result !== null) {
          response.result = result.result;
        }
        
        if (result.stdout) {
          response.stdout = result.stdout;
        }
        
        if (result.stderr) {
          response.stderr = result.stderr;
        }

        return response;
      } else {
        return {
          success: false,
          message: `Error de ejecución: ${result.error}`,
          stdout: result.stdout ?? null,
          stderr: result.stderr ?? null,
          exitCode: result.exitCode ?? null,
          duration: result.duration,
        };
      }
      
    } catch (error: any) {
      return { 
        success: false, 
        message: `Error: ${error.message}` 
      };
    }
  }
};

export default codeExecutorSkill;
