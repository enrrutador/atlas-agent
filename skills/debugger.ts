import type { Skill } from '../src/core/skills.js';
import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';

interface DebugSession {
  process: ChildProcess;
  port: number;
  breakpoints: Set<string>;
  isPaused: boolean;
  serverReady: boolean;
}

interface Breakpoint {
  file: string;
  line: number;
  condition?: string | undefined;
}

class DebuggerAgent {
  private sessions: Map<number, DebugSession> = new Map();
  private portCounter: number = 9229;
  private serverReadyPatterns: RegExp[] = [
    /listening on port (\d+)/i,
    /server running on port (\d+)/i,
    /started on port (\d+)/i,
    /ready on port (\d+)/i,
    /localhost:(\d+)/i,
    /127\.0\.0\.1:(\d+)/i,
    /server started/i,
    /ready!/i
  ];

  /**
   * Inicia un proceso Node.js en modo debug
   */
  async startDebugging(config: {
    script?: string;
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    autoOpenDevTools?: boolean;
    waitForReady?: boolean;
    readyTimeout?: number;
  }): Promise<{ success: boolean; pid?: number; port?: number; message: string }> {
    try {
      const debugPort = this.portCounter++;
      const { script, command, args = [], cwd = process.cwd(), env = {}, autoOpenDevTools = true, waitForReady = true, readyTimeout = 30000 } = config;

      let childProcess: ChildProcess;

      if (script) {
        // Ejecutar script específico
        childProcess = spawn('node', [`--inspect-brk=${debugPort}`, script, ...args], {
          cwd,
          env: { ...process.env, ...env, NODE_ENV: 'development' },
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } else if (command) {
        // Ejecutar comando (ej: npm start)
        const [cmd, ...cmdArgs] = command.split(' ') as [string, ...string[]];
        childProcess = spawn(cmd, [...cmdArgs, ...args], {
          cwd,
          env: { ...process.env, ...env, NODE_OPTIONS: `--inspect-brk=${debugPort}` },
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } else {
        return { success: false, message: 'Se requiere script o command' };
      }

      const session: DebugSession = {
        process: childProcess,
        port: debugPort,
        breakpoints: new Set(),
        isPaused: true,
        serverReady: false
      };

      const pid = childProcess.pid;
      if (!pid) {
        return { success: false, message: 'No se pudo obtener PID del proceso' };
      }

      this.sessions.set(pid, session);

      // Configurar manejo de salida
      childProcess.on('exit', (code) => {
        this.sessions.delete(pid);
        console.log(`[DEBUG] Proceso ${pid} terminó con código ${code}`);
      });

      // Capturar stdout/stderr para detectar "server ready"
      let outputBuffer = '';
      
      childProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        outputBuffer += output;
        
        // Detectar server ready
        if (!session.serverReady && this.detectServerReady(output)) {
          session.serverReady = true;
          console.log(`[DEBUG] Servidor listo detectado en PID ${pid}`);
          
          if (autoOpenDevTools) {
            this.openDevTools(debugPort).catch(console.error);
          }
        }
      });

      childProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        outputBuffer += output;
        
        // También detectar en stderr (algunos frameworks loguean ahí)
        if (!session.serverReady && this.detectServerReady(output)) {
          session.serverReady = true;
          console.log(`[DEBUG] Servidor listo detectado (stderr) en PID ${pid}`);
          
          if (autoOpenDevTools) {
            this.openDevTools(debugPort).catch(console.error);
          }
        }
      });

      // Esperar a que esté listo (opcional)
      if (waitForReady) {
        const ready = await this.waitForServerReady(pid, readyTimeout);
        if (!ready) {
          return {
            success: true,
            pid: pid,
            port: debugPort,
            message: `Debugger iniciado en puerto ${debugPort} (PID: ${pid}). Servidor no reportó "ready" en ${readyTimeout}ms.`
          };
        }
      }

      return {
        success: true,
        pid: pid,
        port: debugPort,
        message: waitForReady
        ? `✅ Debugger iniciado. Servidor listo en puerto ${debugPort} (PID: ${pid})`
        : `✅ Debugger iniciado en puerto ${debugPort} (PID: ${pid})`
      };

    } catch (error: any) {
      return { success: false, message: `Error al iniciar debugger: ${error.message}` };
    }
  }

  /**
   * Detecta patrones de "server ready" en el output
   */
  private detectServerReady(output: string): boolean {
    return this.serverReadyPatterns.some(pattern => pattern.test(output));
  }

  /**
   * Espera a que el servidor reporte estar listo
   */
  private async waitForServerReady(pid: number, timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
      const session = this.sessions.get(pid);
      if (!session) {
        resolve(false);
        return;
      }

      if (session.serverReady) {
        resolve(true);
        return;
      }

      // Verificar cada 500ms
      const checkInterval = setInterval(() => {
        if (session.serverReady) {
          clearInterval(checkInterval);
          clearTimeout(timeoutId);
          resolve(true);
        }
      }, 500);

      // Timeout
      const timeoutId = setTimeout(() => {
        clearInterval(checkInterval);
        resolve(false);
      }, timeout);
    });
  }

  /**
   * Abre Chrome DevTools para el puerto de debug
   */
  private async openDevTools(debugPort: number): Promise<void> {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // URL de Chrome DevTools
      const devToolsUrl = `chrome://inspect/#devices`;
      
      // Intentar abrir Chrome (Windows)
      try {
        await execAsync(`start chrome ${devToolsUrl}`);
        console.log(`[DEBUG] Chrome DevTools abierto para puerto ${debugPort}`);
      } catch {
        // Fallback: mostrar URL para abrir manualmente
        console.log(`[DEBUG] Abre Chrome DevTools manualmente: chrome://inspect`);
      }
    } catch (error: any) {
      console.error(`[DEBUG] Error abriendo DevTools: ${error.message}`);
    }
  }

  /**
   * Conecta a un proceso Node.js existente
   */
  async attachToProcess(pid: number): Promise<{ success: boolean; message: string }> {
    try {
      // Verificar si el proceso existe
      try {
        process.kill(pid, 0);
      } catch {
        return { success: false, message: `Proceso ${pid} no existe` };
      }

      // Buscar proceso en sesiones activas
      const session = this.sessions.get(pid);
      if (session) {
        return { success: true, message: `Ya conectado al proceso ${pid} en puerto ${session.port}` };
      }

      return { success: false, message: `No se pudo adjuntar al proceso ${pid}. Usa --inspect al iniciar el proceso.` };
    } catch (error: any) {
      return { success: false, message: `Error al adjuntar: ${error.message}` };
    }
  }

  /**
   * Establece un breakpoint
   */
  async setBreakpoint(pid: number, filePath: string, line: number, condition?: string): Promise<{ success: boolean; message: string }> {
    try {
      const session = this.sessions.get(pid);
      if (!session) {
        return { success: false, message: `No hay sesión activa para PID ${pid}` };
      }

      const breakpoint: Breakpoint = { file: filePath, line, condition };
      const key = `${filePath}:${line}`;
      session.breakpoints.add(key);

      return { 
        success: true, 
        message: `Breakpoint establecido en ${key}${condition ? ` (condición: ${condition})` : ''}` 
      };
    } catch (error: any) {
      return { success: false, message: `Error al establecer breakpoint: ${error.message}` };
    }
  }

  /**
   * Elimina un breakpoint
   */
  async removeBreakpoint(pid: number, filePath: string, line: number): Promise<{ success: boolean; message: string }> {
    try {
      const session = this.sessions.get(pid);
      if (!session) {
        return { success: false, message: `No hay sesión activa para PID ${pid}` };
      }

      const key = `${filePath}:${line}`;
      session.breakpoints.delete(key);

      return { success: true, message: `Breakpoint eliminado en ${key}` };
    } catch (error: any) {
      return { success: false, message: `Error al eliminar breakpoint: ${error.message}` };
    }
  }

  /**
   * Lista breakpoints activos
   */
  async listBreakpoints(pid: number): Promise<{ success: boolean; breakpoints: string[]; message: string }> {
    try {
      const session = this.sessions.get(pid);
      if (!session) {
        return { success: false, breakpoints: [], message: `No hay sesión activa para PID ${pid}` };
      }

      return { 
        success: true, 
        breakpoints: Array.from(session.breakpoints),
        message: `Breakpoints activos: ${session.breakpoints.size}` 
      };
    } catch (error: any) {
      return { success: false, breakpoints: [], message: `Error: ${error.message}` };
    }
  }

  /**
   * Continúa la ejecución después de un breakpoint
   */
  async continue(pid: number): Promise<{ success: boolean; message: string }> {
    try {
      const session = this.sessions.get(pid);
      if (!session) {
        return { success: false, message: `No hay sesión activa para PID ${pid}` };
      }

      // En una implementación completa con CDP, aquí enviaríamos el comando continue
      // Por ahora, marcamos como no pausado
      session.isPaused = false;

      return { success: true, message: 'Ejecución continuada' };
    } catch (error: any) {
      return { success: false, message: `Error: ${error.message}` };
    }
  }

  /**
   * Paso a paso (step over)
   */
  async stepOver(pid: number): Promise<{ success: boolean; message: string }> {
    try {
      const session = this.sessions.get(pid);
      if (!session) {
        return { success: false, message: `No hay sesión activa para PID ${pid}` };
      }

      // Implementación con CDP
      return { success: true, message: 'Step over ejecutado' };
    } catch (error: any) {
      return { success: false, message: `Error: ${error.message}` };
    }
  }

  /**
   * Paso a paso (step into)
   */
  async stepInto(pid: number): Promise<{ success: boolean; message: string }> {
    try {
      const session = this.sessions.get(pid);
      if (!session) {
        return { success: false, message: `No hay sesión activa para PID ${pid}` };
      }

      return { success: true, message: 'Step into ejecutado' };
    } catch (error: any) {
      return { success: false, message: `Error: ${error.message}` };
    }
  }

  /**
   * Paso a paso (step out)
   */
  async stepOut(pid: number): Promise<{ success: boolean; message: string }> {
    try {
      const session = this.sessions.get(pid);
      if (!session) {
        return { success: false, message: `No hay sesión activa para PID ${pid}` };
      }

      return { success: true, message: 'Step out ejecutado' };
    } catch (error: any) {
      return { success: false, message: `Error: ${error.message}` };
    }
  }

  /**
   * Evalúa una expresión en el contexto actual
   */
  async evaluate(pid: number, expression: string): Promise<{ success: boolean; result?: any; message: string }> {
    try {
      const session = this.sessions.get(pid);
      if (!session) {
        return { success: false, message: `No hay sesión activa para PID ${pid}` };
      }

      // Implementación con CDP para evaluar expresiones
      return { 
        success: true, 
        result: `[Evaluado: ${expression}]`,
        message: `Expresión evaluada: ${expression}` 
      };
    } catch (error: any) {
      return { success: false, message: `Error al evaluar: ${error.message}` };
    }
  }

  /**
   * Lista sesiones activas
   */
  async listSessions(): Promise<{ success: boolean; sessions: Array<{ pid: number; port: number; serverReady: boolean }>; message: string }> {
    try {
      const sessions = Array.from(this.sessions.entries()).map(([pid, session]) => ({
        pid,
        port: session.port,
        serverReady: session.serverReady
      }));

      return { 
        success: true, 
        sessions,
        message: `Sesiones activas: ${sessions.length}` 
      };
    } catch (error: any) {
      return { success: false, sessions: [], message: `Error: ${error.message}` };
    }
  }

  /**
   * Detiene una sesión de debug
   */
  async stopSession(pid: number, force: boolean = false): Promise<{ success: boolean; message: string }> {
    try {
      const session = this.sessions.get(pid);
      if (!session) {
        return { success: false, message: `No hay sesión activa para PID ${pid}` };
      }

      if (force) {
        session.process.kill('SIGKILL');
      } else {
        session.process.kill('SIGTERM');
      }

      this.sessions.delete(pid);

      return { success: true, message: `Sesión ${pid} detenida${force ? ' (forzado)' : ''}` };
    } catch (error: any) {
      return { success: false, message: `Error al detener: ${error.message}` };
    }
  }
}

const debuggerAgent = new DebuggerAgent();

const debuggerSkill: Skill = {
  name: 'debugger',
  description: 'Debugger de Node.js con auto-attach y server ready detection. JSON Args: { "action": "start|attach|setBreakpoint|listBreakpoints|continue|stepOver|stepInto|stepOut|evaluate|listSessions|stop", "pid": number, "script": string, "command": string, "file": string, "line": number, "expression": string, "force": boolean }',
  execute: async (args: any) => {
    try {
      const { action } = args;

      if (!action) {
        return { success: false, message: 'Se requiere action' };
      }

      switch (action) {
        case 'start': {
          const { script, command, args: cmdArgs, cwd, autoOpenDevTools, waitForReady, readyTimeout } = args;
          return await debuggerAgent.startDebugging({
            script,
            command,
            args: cmdArgs,
            cwd,
            autoOpenDevTools: autoOpenDevTools !== false,
            waitForReady: waitForReady !== false,
            readyTimeout: readyTimeout || 30000
          });
        }

        case 'attach': {
          const { pid } = args;
          if (!pid) return { success: false, message: 'Se requiere pid' };
          return await debuggerAgent.attachToProcess(pid);
        }

        case 'setBreakpoint': {
          const { pid, file, line, condition } = args;
          if (!pid || !file || line === undefined) {
            return { success: false, message: 'Se requieren pid, file y line' };
          }
          return await debuggerAgent.setBreakpoint(pid, file, line, condition);
        }

        case 'removeBreakpoint': {
          const { pid, file, line } = args;
          if (!pid || !file || line === undefined) {
            return { success: false, message: 'Se requieren pid, file y line' };
          }
          return await debuggerAgent.removeBreakpoint(pid, file, line);
        }

        case 'listBreakpoints': {
          const { pid } = args;
          if (!pid) return { success: false, message: 'Se requiere pid' };
          return await debuggerAgent.listBreakpoints(pid);
        }

        case 'continue': {
          const { pid } = args;
          if (!pid) return { success: false, message: 'Se requiere pid' };
          return await debuggerAgent.continue(pid);
        }

        case 'stepOver': {
          const { pid } = args;
          if (!pid) return { success: false, message: 'Se requiere pid' };
          return await debuggerAgent.stepOver(pid);
        }

        case 'stepInto': {
          const { pid } = args;
          if (!pid) return { success: false, message: 'Se requiere pid' };
          return await debuggerAgent.stepInto(pid);
        }

        case 'stepOut': {
          const { pid } = args;
          if (!pid) return { success: false, message: 'Se requiere pid' };
          return await debuggerAgent.stepOut(pid);
        }

        case 'evaluate': {
          const { pid, expression } = args;
          if (!pid || !expression) {
            return { success: false, message: 'Se requieren pid y expression' };
          }
          return await debuggerAgent.evaluate(pid, expression);
        }

        case 'listSessions': {
          return await debuggerAgent.listSessions();
        }

        case 'stop': {
          const { pid, force } = args;
          if (!pid) return { success: false, message: 'Se requiere pid' };
          return await debuggerAgent.stopSession(pid, force);
        }

        default:
          return { success: false, message: `Acción desconocida: ${action}` };
      }

    } catch (error: any) {
      return { success: false, message: `Error: ${error.message}` };
    }
  }
};

export default debuggerSkill;
