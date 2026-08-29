import type { Skill } from '../src/core/skills.js';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface DevContainerConfig {
  name?: string;
  dockerFile?: string;
  image?: string;
  features?: Record<string, any>;
  forwardPorts?: number[];
  postCreateCommand?: string;
  postStartCommand?: string;
  remoteUser?: string;
  mounts?: Array<{ source: string; target: string; type?: string }>;
}

interface ContainerSession {
  id: string;
  name: string;
  projectPath: string;
  status: 'building' | 'running' | 'stopped' | 'error';
  ports: Map<number, number>;
  createdAt: Date;
}

class DevContainerManager {
  private containersDir: string;
  private activeSessions: Map<string, ContainerSession> = new Map();

  constructor() {
    this.containersDir = path.join(process.cwd(), 'workspace', 'devcontainers');
    this.ensureDirectory();
  }

  private ensureDirectory() {
    if (!fs.existsSync(this.containersDir)) {
      fs.mkdirSync(this.containersDir, { recursive: true });
    }
  }

  /**
   * Detecta configuración de devcontainer
   */
  async detectConfig(projectPath: string): Promise<{ success: boolean; config?: DevContainerConfig; message: string }> {
    try {
      const configPath = path.join(projectPath, '.devcontainer', 'devcontainer.json');
      const dockerfilePath = path.join(projectPath, '.devcontainer', 'Dockerfile');
      const composePath = path.join(projectPath, '.devcontainer', 'docker-compose.yml');

      if (!fs.existsSync(configPath)) {
        return { success: false, message: 'No se encontró .devcontainer/devcontainer.json' };
      }

      const configContent = fs.readFileSync(configPath, 'utf-8');
      const config: DevContainerConfig = JSON.parse(configContent);

      const hasDockerfile = fs.existsSync(dockerfilePath);
      const hasCompose = fs.existsSync(composePath);

      return {
        success: true,
        config,
        message: `Configuración detectada: ${config.name || 'unnamed'}${hasDockerfile ? ' (Dockerfile)' : ''}${hasCompose ? ' (docker-compose)' : ''}`
      };
    } catch (error: any) {
      return { success: false, message: `Error: ${error.message}` };
    }
  }

  /**
   * Abre proyecto en devcontainer
   */
  async open(projectPath: string, rebuild: boolean = false): Promise<{ success: boolean; sessionId?: string; message: string }> {
    try {
      const configResult = await this.detectConfig(projectPath);
      if (!configResult.success || !configResult.config) {
        // Crear configuración por defecto
        await this.createDefaultConfig(projectPath);
        return await this.open(projectPath, rebuild);
      }

      const config = configResult.config;
      const sessionId = `dev_${Date.now()}_${path.basename(projectPath)}`;

      const session: ContainerSession = {
        id: sessionId,
        name: config.name || path.basename(projectPath),
        projectPath,
        status: 'building',
        ports: new Map(),
        createdAt: new Date()
      };

      this.activeSessions.set(sessionId, session);

      // Construir y ejecutar container
      const result = await this.buildAndRun(session, config, rebuild);
      
      if (result.success) {
        session.status = 'running';
        return {
          success: true,
          sessionId,
          message: `✅ DevContainer "${session.name}" iniciado (${sessionId})`
        };
      } else {
        session.status = 'error';
        return { success: false, message: result.message };
      }
    } catch (error: any) {
      return { success: false, message: `Error: ${error.message}` };
    }
  }

  /**
   * Construye y ejecuta el container
   */
  private async buildAndRun(session: ContainerSession, config: DevContainerConfig, rebuild: boolean): Promise<{ success: boolean; message: string }> {
    try {
      const projectPath = session.projectPath;
      const containerName = `atlas_dev_${session.id}`;

      // Verificar Docker
      try {
        await execAsync('docker --version');
      } catch {
        return { success: false, message: 'Docker no está instalado o no está en PATH' };
      }

      // Construir imagen
      console.log(`[DEVCONTAINER] Construyendo imagen para ${session.name}...`);
      
      let buildCmd: string;
      
      if (config.dockerFile) {
        buildCmd = `docker build -f "${path.join(projectPath, '.devcontainer', config.dockerFile)}" -t ${containerName} "${projectPath}"`;
      } else if (config.image) {
        buildCmd = `docker pull ${config.image}`;
      } else {
        // Dockerfile por defecto
        buildCmd = `docker build -f "${path.join(projectPath, '.devcontainer', 'Dockerfile')}" -t ${containerName} "${projectPath}"`;
      }

      if (rebuild) {
        buildCmd += ' --no-cache';
      }

      const { stdout, stderr } = await execAsync(buildCmd, { timeout: 300000 }); // 5 min timeout
      
      if (stderr && !stderr.includes('Successfully')) {
        console.warn(`[DEVCONTAINER] Build warnings: ${stderr}`);
      }

      // Configurar puertos
      const portMappings: string[] = [];
      if (config.forwardPorts) {
        for (const port of config.forwardPorts) {
          const hostPort = await this.findFreePort();
          session.ports.set(port, hostPort);
          portMappings.push(`-p ${hostPort}:${port}`);
        }
      }

      // Configurar mounts
      const mountMappings: string[] = [
        `-v "${projectPath}:/workspace:cached"`,
        '-v /var/run/docker.sock:/var/run/docker.sock'
      ];

      if (config.mounts) {
        for (const mount of config.mounts) {
          mountMappings.push(`-v "${mount.source}:${mount.target}${mount.type ? ':' + mount.type : ''}"`);
        }
      }

      // Ejecutar container
      console.log(`[DEVCONTAINER] Iniciando container ${containerName}...`);
      
      const runCmd = [
        'docker', 'run', '-d', '--name', containerName,
        ...portMappings,
        ...mountMappings,
        '--workdir', '/workspace',
        config.remoteUser ? `--user ${config.remoteUser}` : '',
        containerName
      ].filter(Boolean).join(' ');

      await execAsync(runCmd);

      // Post-create command
      if (config.postCreateCommand) {
        console.log(`[DEVCONTAINER] Ejecutando post-create command...`);
        await execAsync(`docker exec ${containerName} ${config.postCreateCommand}`);
      }

      // Post-start command
      if (config.postStartCommand) {
        console.log(`[DEVCONTAINER] Ejecutando post-start command...`);
        await execAsync(`docker exec ${containerName} ${config.postStartCommand}`);
      }

      const portInfo = Array.from(session.ports.entries())
        .map(([container, host]) => `${container}→${host}`)
        .join(', ');

      return {
        success: true,
        message: `Container ejecutándose. Puertos: ${portInfo || 'ninguno'}`
      };

    } catch (error: any) {
      return { success: false, message: `Error en build/run: ${error.message}` };
    }
  }

  /**
   * Encuentra puerto libre
   */
  private async findFreePort(): Promise<number> {
    // Usar rango 10000-20000
    return Math.floor(Math.random() * 10000) + 10000;
  }

  /**
   * Crea configuración por defecto
   */
  private async createDefaultConfig(projectPath: string): Promise<void> {
    const devcontainerDir = path.join(projectPath, '.devcontainer');
    
    if (!fs.existsSync(devcontainerDir)) {
      fs.mkdirSync(devcontainerDir, { recursive: true });
    }

    const config: DevContainerConfig = {
      name: path.basename(projectPath),
      image: 'mcr.microsoft.com/devcontainers/javascript-node:18',
      features: {},
      forwardPorts: [3000, 8080],
      postCreateCommand: 'npm install',
      remoteUser: 'node'
    };

    const configPath = path.join(devcontainerDir, 'devcontainer.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Crear Dockerfile básico
    const dockerfilePath = path.join(devcontainerDir, 'Dockerfile');
    if (!fs.existsSync(dockerfilePath)) {
      const dockerfile = `FROM mcr.microsoft.com/devcontainers/javascript-node:18

# Instalar herramientas adicionales
RUN apt-get update && apt-get install -y \\
    git \\
    curl \\
    vim \\
    && rm -rf /var/lib/apt/lists/*

# Configurar workspace
WORKDIR /workspace

# Instalar dependencias globales si es necesario
# RUN npm install -g some-package

USER node`;
      fs.writeFileSync(dockerfilePath, dockerfile);
    }
  }

  /**
   * Lista sesiones activas
   */
  async listSessions(): Promise<{ success: boolean; sessions: any[]; message: string }> {
    try {
      // Verificar containers Docker reales
      const { stdout } = await execAsync('docker ps --format "{{.Names}}|{{.Status}}|{{.Ports}}"');
      const containers = stdout.split('\n').filter(Boolean);
      
      const sessions = Array.from(this.activeSessions.values()).map(session => {
        const dockerContainer = containers.find(c => c.includes(session.id));
        return {
          id: session.id,
          name: session.name,
          status: dockerContainer ? 'running' : session.status,
          ports: Array.from(session.ports.entries()).map(([c, h]) => `${c}:${h}`),
          createdAt: session.createdAt
        };
      });

      return { success: true, sessions, message: `${sessions.length} containers activos` };
    } catch (error: any) {
      return { success: false, sessions: [], message: `Error: ${error.message}` };
    }
  }

  /**
   * Ejecuta comando en container
   */
  async execCommand(sessionId: string, command: string): Promise<{ success: boolean; stdout?: string; stderr?: string; message: string }> {
    try {
      const session = this.activeSessions.get(sessionId);
      if (!session) {
        return { success: false, message: `Sesión ${sessionId} no encontrada` };
      }

      const containerName = `atlas_dev_${sessionId}`;
      const { stdout, stderr } = await execAsync(`docker exec ${containerName} ${command}`, { timeout: 60000 });

      return {
        success: true,
        stdout,
        stderr,
        message: `Comando ejecutado en ${session.name}`
      };
    } catch (error: any) {
      return {
        success: false,
        stderr: error.stderr,
        message: `Error: ${error.message}`
      };
    }
  }

  /**
   * Detiene container
   */
  async stop(sessionId: string, remove: boolean = false): Promise<{ success: boolean; message: string }> {
    try {
      const session = this.activeSessions.get(sessionId);
      if (!session) {
        return { success: false, message: `Sesión ${sessionId} no encontrada` };
      }

      const containerName = `atlas_dev_${sessionId}`;

      // Detener
      await execAsync(`docker stop ${containerName}`, { timeout: 30000 });

      if (remove) {
        await execAsync(`docker rm ${containerName}`, { timeout: 30000 });
        this.activeSessions.delete(sessionId);
        return { success: true, message: `Container ${session.name} detenido y eliminado` };
      }

      session.status = 'stopped';
      return { success: true, message: `Container ${session.name} detenido` };
    } catch (error: any) {
      return { success: false, message: `Error: ${error.message}` };
    }
  }

  /**
   * Reabre proyecto localmente
   */
  async reopenLocally(sessionId: string): Promise<{ success: boolean; projectPath?: string; message: string }> {
    try {
      const session = this.activeSessions.get(sessionId);
      if (!session) {
        return { success: false, message: `Sesión ${sessionId} no encontrada` };
      }

      // Detener container
      await this.stop(sessionId, false);

      return {
        success: true,
        projectPath: session.projectPath,
        message: `Proyecto reabierto localmente: ${session.projectPath}`
      };
    } catch (error: any) {
      return { success: false, message: `Error: ${error.message}` };
    }
  }
}

const devContainerManager = new DevContainerManager();

const devContainerSkill: Skill = {
  name: 'dev_container',
  description: 'Gestión de DevContainers para desarrollo aislado. JSON Args: { "action": "open|detect|list|exec|stop|reopen", "projectPath": "ruta", "sessionId": "id", "command": "cmd", "rebuild": false, "remove": false }',
  execute: async (args: any) => {
    try {
      const { action } = args;

      if (!action) {
        return { success: false, message: 'Se requiere action' };
      }

      switch (action) {
        case 'open': {
          const { projectPath, rebuild } = args;
          if (!projectPath) {
            return { success: false, message: 'Se requiere projectPath' };
          }
          return await devContainerManager.open(projectPath, rebuild);
        }

        case 'detect': {
          const { projectPath } = args;
          if (!projectPath) {
            return { success: false, message: 'Se requiere projectPath' };
          }
          return await devContainerManager.detectConfig(projectPath);
        }

        case 'list':
          return await devContainerManager.listSessions();

        case 'exec': {
          const { sessionId, command } = args;
          if (!sessionId || !command) {
            return { success: false, message: 'Se requieren sessionId y command' };
          }
          return await devContainerManager.execCommand(sessionId, command);
        }

        case 'stop': {
          const { sessionId, remove } = args;
          if (!sessionId) {
            return { success: false, message: 'Se requiere sessionId' };
          }
          return await devContainerManager.stop(sessionId, remove);
        }

        case 'reopen':
        case 'reopen-locally': {
          const { sessionId } = args;
          if (!sessionId) {
            return { success: false, message: 'Se requiere sessionId' };
          }
          return await devContainerManager.reopenLocally(sessionId);
        }

        default:
          return { success: false, message: `Acción desconocida: ${action}` };
      }

    } catch (error: any) {
      return { success: false, message: `Error: ${error.message}` };
    }
  }
};

export default devContainerSkill;
