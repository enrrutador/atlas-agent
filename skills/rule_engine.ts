import type { Skill } from '../src/core/skills.js';
import * as fs from 'fs';
import * as path from 'path';

interface Rule {
  id: string;
  name: string;
  description?: string;
  severity: 'error' | 'warn' | 'info';
  constraints: Constraint[];
  permissions?: Permission[];
  enabled: boolean;
}

interface Constraint {
  type: 'block' | 'limit' | 'require' | 'pattern';
  action?: string;
  path?: string | RegExp;
  command?: string | RegExp;
  extensions?: string[];
  size?: number;
  count?: number;
  message?: string;
}

interface Permission {
  type: 'allow' | 'deny';
  action?: string;
  path?: string | RegExp;
  command?: string | RegExp;
  extensions?: string[];
  reason?: string;
}

interface ValidationResult {
  allowed: boolean;
  severity: 'error' | 'warn' | 'info' | 'ok';
  message: string;
  ruleId?: string;
  requiresConfirmation?: boolean;
}

interface RuleContext {
  action: string;
  args: any;
  userLevel: number;
  trustLevel: number;
  lastConfirmation?: Date;
}

class RuleEngine {
  private rulesDir: string;
  private rules: Map<string, Rule> = new Map();
  private whitelist: Set<string> = new Set();
  private blacklist: Set<string> = new Set();
  private validationCache: Map<string, ValidationResult> = new Map();

  constructor() {
    this.rulesDir = path.join(process.cwd(), 'workspace', 'rules');
    this.ensureRulesDirectory();
    this.loadDefaultRules();
  }

  private ensureRulesDirectory() {
    if (!fs.existsSync(this.rulesDir)) {
      fs.mkdirSync(this.rulesDir, { recursive: true });
      console.log(`[RULES] Directorio creado: ${this.rulesDir}`);
    }
  }

  /**
   * Reglas por defecto
   */
  private loadDefaultRules() {
    // Regla 1: Proteger archivos críticos
    this.rules.set('critical_files', {
      id: 'critical_files',
      name: 'Protección de archivos críticos',
      description: 'Bloquea operaciones destructivas en archivos de configuración',
      severity: 'error',
      constraints: [
        {
          type: 'block',
          action: 'delete',
          path: /.*\.(env|config|json)$/i,
          message: 'No se pueden borrar archivos de configuración'
        },
        {
          type: 'block',
          path: /.*\.git(\/|$)/,
          message: 'No se puede modificar el directorio .git'
        },
        {
          type: 'block',
          path: /C:\/Windows/,
          message: 'Acceso denegado al directorio Windows'
        }
      ],
      enabled: true
    });

    // Regla 2: Comandos peligrosos
    this.rules.set('dangerous_commands', {
      id: 'dangerous_commands',
      name: 'Comandos peligrosos',
      description: 'Bloquea comandos que pueden dañar el sistema',
      severity: 'error',
      constraints: [
        {
          type: 'block',
          command: /rm\s+-rf/i,
          message: 'Comando destructivo bloqueado'
        },
        {
          type: 'block',
          command: /format|diskpart/i,
          message: 'Operación de disco bloqueada'
        },
        {
          type: 'block',
          command: /reg\s+delete.*HKLM/i,
          message: 'Modificación del registro bloqueada'
        }
      ],
      enabled: true
    });

    // Regla 3: Extensiones peligrosas
    this.rules.set('dangerous_extensions', {
      id: 'dangerous_extensions',
      name: 'Extensiones peligrosas',
      description: 'Alerta sobre archivos ejecutables',
      severity: 'warn',
      constraints: [
        {
          type: 'limit',
          extensions: ['.exe', '.bat', '.cmd', '.scr', '.pif'],
          message: 'Archivo ejecutable detectado - requiere confirmación'
        }
      ],
      permissions: [
        {
          type: 'allow',
          path: /C:\/Users\/[^/]+\/(Desktop|Downloads)/,
          reason: 'Ubicación permitida para ejecutables'
        }
      ],
      enabled: true
    });

    // Regla 4: Límites de operaciones
    this.rules.set('operation_limits', {
      id: 'operation_limits',
      name: 'Límites de operaciones',
      description: 'Limita operaciones masivas',
      severity: 'warn',
      constraints: [
        {
          type: 'limit',
          action: 'delete',
          count: 10,
          message: 'Operación en lote >10 archivos requiere confirmación'
        },
        {
          type: 'limit',
          action: 'download',
          size: 100 * 1024 * 1024, // 100MB
          message: 'Descarga >100MB requiere confirmación'
        }
      ],
      enabled: true
    });

    // Regla 5: Rutas seguras
    this.rules.set('safe_paths', {
      id: 'safe_paths',
      name: 'Rutas seguras',
      description: 'Define rutas permitidas para operaciones',
      severity: 'error',
      constraints: [
        {
          type: 'require',
          path: /C:\/Users\/[^/]+/,
          message: 'Solo se permite operar en el directorio del usuario'
        }
      ],
      permissions: [
        {
          type: 'allow',
          path: /C:\/Users\/[^/]+\/(Desktop|Downloads|Pictures|Documents)/,
          reason: 'Rutas seguras permitidas'
        }
      ],
      enabled: true
    });

    console.log(`[RULES] ${this.rules.size} reglas por defecto cargadas`);
  }

  /**
   * Parsea archivo de reglas markdown
   */
  private parseRulesMarkdown(content: string): Rule[] {
    const rules: Rule[] = [];
    const lines = content.split('\n');
    let currentRule: Partial<Rule> = {};
    let inRule = false;
    let inConstraints = false;
    let inPermissions = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Nueva regla
      if (trimmed.startsWith('# ')) {
        if (inRule && currentRule.id) {
          rules.push(currentRule as Rule);
        }
        inRule = true;
        inConstraints = false;
        inPermissions = false;
        currentRule = {
          id: trimmed.substring(2).toLowerCase().replace(/\s+/g, '_'),
          name: trimmed.substring(2).trim(),
          severity: 'warn',
          constraints: [],
          enabled: true
        };
        continue;
      }

      // Descripción
      if (trimmed.startsWith('## Description')) {
        continue;
      }
      if (inRule && trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('-') && !trimmed.startsWith('##')) {
        if (!currentRule.description) {
          currentRule.description = trimmed;
        }
        continue;
      }

      // Severidad
      if (trimmed.startsWith('## Severity')) {
        continue;
      }
      if (inRule && (trimmed === 'error' || trimmed === 'warn' || trimmed === 'info')) {
        currentRule.severity = trimmed as 'error' | 'warn' | 'info';
        continue;
      }

      // Constraints
      if (trimmed.startsWith('## Constraints')) {
        inConstraints = true;
        inPermissions = false;
        continue;
      }

      // Permissions
      if (trimmed.startsWith('## Permissions')) {
        inConstraints = false;
        inPermissions = true;
        if (!currentRule.permissions) {
          currentRule.permissions = [];
        }
        continue;
      }

      // Parsear constraint
      if (inConstraints && trimmed.startsWith('- ')) {
        const constraint = this.parseConstraint(trimmed.substring(2));
        if (constraint && currentRule.constraints) {
          currentRule.constraints.push(constraint);
        }
      }

      // Parsear permission
      if (inPermissions && trimmed.startsWith('- ')) {
        const permission = this.parsePermission(trimmed.substring(2));
        if (permission && currentRule.permissions) {
          currentRule.permissions.push(permission);
        }
      }

      // Habilitado
      if (trimmed.startsWith('enabled:')) {
        currentRule.enabled = trimmed.substring(8).trim() === 'true';
      }
    }

    if (inRule && currentRule.id) {
      rules.push(currentRule as Rule);
    }

    return rules;
  }

  /**
   * Parsea una línea de constraint
   */
  private parseConstraint(line: string): Constraint | null {
    const parts = line.split(':').map(s => s.trim());
    if (parts.length < 2) return null;

    const type = parts[0] as 'block' | 'limit' | 'require' | 'pattern';
    const constraint: Constraint = { type };

    for (let i = 1; i < parts.length; i += 2) {
      const key = parts[i];
      const value = parts[i + 1];

      if (!key || !value) continue;

      switch (key) {
        case 'action':
          constraint.action = value;
          break;
        case 'path':
          constraint.path = new RegExp(value, 'i');
          break;
        case 'command':
          constraint.command = new RegExp(value, 'i');
          break;
        case 'extensions':
          constraint.extensions = value.split(',').map(s => s.trim());
          break;
        case 'size':
          constraint.size = parseInt(value);
          break;
        case 'count':
          constraint.count = parseInt(value);
          break;
        case 'message':
          constraint.message = value.replace(/^["']|["']$/g, '');
          break;
      }
    }

    return constraint;
  }

  /**
   * Parsea una línea de permission
   */
  private parsePermission(line: string): Permission | null {
    const parts = line.split(':').map(s => s.trim());
    if (parts.length < 2) return null;

    const type = parts[0] as 'allow' | 'deny';
    const permission: Permission = { type };

    for (let i = 1; i < parts.length; i += 2) {
      const key = parts[i];
      const value = parts[i + 1];

      if (!key || !value) continue;

      switch (key) {
        case 'action':
          permission.action = value;
          break;
        case 'path':
          permission.path = new RegExp(value, 'i');
          break;
        case 'command':
          permission.command = new RegExp(value, 'i');
          break;
        case 'extensions':
          permission.extensions = value.split(',').map(s => s.trim());
          break;
        case 'reason':
          permission.reason = value.replace(/^["']|["']$/g, '');
          break;
      }
    }

    return permission;
  }

  /**
   * Carga reglas desde archivo
   */
  async loadRules(filename: string): Promise<{ success: boolean; message: string; count?: number }> {
    try {
      const filepath = path.join(this.rulesDir, filename);
      
      if (!fs.existsSync(filepath)) {
        return { success: false, message: `Archivo no encontrado: ${filename}` };
      }

      const content = fs.readFileSync(filepath, 'utf-8');
      const rules = this.parseRulesMarkdown(content);

      for (const rule of rules) {
        this.rules.set(rule.id, rule);
      }

      return { success: true, message: `${rules.length} reglas cargadas`, count: rules.length };
    } catch (error: any) {
      return { success: false, message: `Error: ${error.message}` };
    }
  }

  /**
   * Lista todas las reglas
   */
  async listRules(): Promise<{ success: boolean; rules: any[]; message: string }> {
    const rules = Array.from(this.rules.values()).map(r => ({
      id: r.id,
      name: r.name,
      severity: r.severity,
      enabled: r.enabled,
      constraints: r.constraints.length
    }));

    return { success: true, rules, message: `${rules.length} reglas activas` };
  }

  /**
   * Valida una acción contra las reglas
   */
  async validateAction(context: RuleContext): Promise<ValidationResult> {
    const cacheKey = `${context.action}_${JSON.stringify(context.args)}`;
    
    // Verificar cache
    const cached = this.validationCache.get(cacheKey);
    if (cached && Date.now() - (context.lastConfirmation?.getTime() || 0) < 60000) {
      return cached;
    }

    // Verificar whitelist primero
    if (this.isWhitelisted(context)) {
      return { allowed: true, severity: 'ok', message: 'Acción en whitelist' };
    }

    // Verificar blacklist
    if (this.isBlacklisted(context)) {
      return { allowed: false, severity: 'error', message: 'Acción en blacklist', requiresConfirmation: true };
    }

    // Evaluar cada regla
    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;

      const result = this.evaluateRule(rule, context);
      if (!result.allowed) {
        // Guardar en cache
        this.validationCache.set(cacheKey, result);
        return result;
      }
      }

    const result: ValidationResult = {
      allowed: true,
      severity: 'ok',
      message: 'Acción permitida'
    };

    this.validationCache.set(cacheKey, result);
    return result;
  }

  /**
   * Evalúa una regla específica
   */
  private evaluateRule(rule: Rule, context: RuleContext): ValidationResult {
    for (const constraint of rule.constraints) {
      const violated = this.checkConstraint(constraint, context);
      if (violated) {
        return {
          allowed: false,
          severity: rule.severity,
          message: constraint.message || `Violación de regla: ${rule.name}`,
          ruleId: rule.id,
          requiresConfirmation: rule.severity === 'warn'
        };
      }
    }

    // Verificar permisos explícitos
    if (rule.permissions) {
      const hasPermission = rule.permissions.some(p => this.checkPermission(p, context));
      if (!hasPermission && rule.constraints.length > 0) {
        return {
          allowed: false,
          severity: rule.severity,
          message: `Sin permiso para: ${rule.name}`,
          ruleId: rule.id,
          requiresConfirmation: true
        };
      }
    }

    return { allowed: true, severity: 'ok', message: 'OK' };
  }

  /**
   * Verifica si un constraint es violado
   */
  private checkConstraint(constraint: Constraint, context: RuleContext): boolean {
    // Verificar action
    if (constraint.action && constraint.action !== context.action) {
      return false;
    }

    const args = context.args;

    // Verificar path
    if (constraint.path && args.path) {
      const matches = this.matchesPattern(constraint.path, args.path);
      if (constraint.type === 'block' && matches) return true;
      if (constraint.type === 'require' && !matches) return true;
    }

    // Verificar command
    if (constraint.command && args.command) {
      const matches = this.matchesPattern(constraint.command, args.command);
      if (constraint.type === 'block' && matches) return true;
      if (constraint.type === 'require' && !matches) return true;
    }

    // Verificar extensions
    if (constraint.extensions && args.path) {
      const ext = path.extname(args.path).toLowerCase();
      const matches = constraint.extensions.includes(ext);
      if (constraint.type === 'block' && matches) return true;
      if (constraint.type === 'limit' && matches) return true;
    }

    // Verificar count
    if (constraint.count && args.count) {
      if (args.count > constraint.count) return true;
    }

    // Verificar size
    if (constraint.size && args.size) {
      if (args.size > constraint.size) return true;
    }

    return false;
  }

  /**
   * Helper para verificar si un string coincide con un patrón
   */
  private matchesPattern(pattern: string | RegExp, value: string): boolean {
    if (pattern instanceof RegExp) {
      return pattern.test(value);
    }
    return value.includes(pattern);
  }

  /**
   * Verifica si un permiso aplica
   */
  private checkPermission(permission: Permission, context: RuleContext): boolean {
    // Verificar action
    if (permission.action && permission.action !== context.action) {
      return false;
    }

    const args = context.args;

    // Verificar path
    if (permission.path && args.path) {
      if (!this.matchesPattern(permission.path, args.path)) return false;
    }

    // Verificar extensions
    if (permission.extensions && args.path) {
      const ext = path.extname(args.path).toLowerCase();
      if (!permission.extensions.includes(ext)) return false;
    }

    return permission.type === 'allow';
  }

  /**
   * Verifica whitelist
   */
  private isWhitelisted(context: RuleContext): boolean {
    const key = `${context.action}_${JSON.stringify(context.args)}`;
    return this.whitelist.has(key);
  }

  /**
   * Verifica blacklist
   */
  private isBlacklisted(context: RuleContext): boolean {
    const key = `${context.action}_${JSON.stringify(context.args)}`;
    return this.blacklist.has(key);
  }

  /**
   * Agrega a whitelist
   */
  async addToWhitelist(pattern: string): Promise<{ success: boolean; message: string }> {
    this.whitelist.add(pattern);
    return { success: true, message: 'Agregado a whitelist' };
  }

  /**
   * Agrega a blacklist
   */
  async addToBlacklist(pattern: string): Promise<{ success: boolean; message: string }> {
    this.blacklist.add(pattern);
    return { success: true, message: 'Agregado a blacklist' };
  }

  /**
   * Habilita/deshabilita regla
   */
  async toggleRule(ruleId: string, enabled: boolean): Promise<{ success: boolean; message: string }> {
    const rule = this.rules.get(ruleId);
    if (!rule) {
      return { success: false, message: `Regla no encontrada: ${ruleId}` };
    }

    rule.enabled = enabled;
    return { success: true, message: `Regla ${ruleId} ${enabled ? 'habilitada' : 'deshabilitada'}` };
  }

  /**
   * Limpia cache de validaciones
   */
  async clearCache(): Promise<{ success: boolean; message: string }> {
    this.validationCache.clear();
    return { success: true, message: 'Cache limpiado' };
  }

  /**
   * Crea reglas de ejemplo
   */
  async createExampleRules(): Promise<{ success: boolean; message: string; filename?: string }> {
    try {
      const example = `# Reglas de Seguridad Personalizadas

## Proteger Proyecto

### Description
Evitar modificaciones accidentales en código fuente

### Severity
error

### Constraints
- block action: delete path: src/
- block action: write path: src/ message: "Usar code_surgeon para modificar código"
- require action: delete path: C:/Users/

### Permissions
- allow action: read path: src/
- allow action: write path: temp/

enabled: true

---

# Descargas Seguras

### Description
Controlar descargas de archivos

### Severity
warn

### Constraints
- limit size: 104857600 message: "Descarga >100MB requiere confirmación"
- block extensions: .exe,.bat,.scr message: "Ejecutables requieren confirmación"

### Permissions
- allow path: C:/Users/[^/]+/Downloads
- allow path: C:/Users/[^/]+/Desktop

enabled: true`;

      const filename = `custom_rules_${Date.now()}.md`;
      const filepath = path.join(this.rulesDir, filename);
      fs.writeFileSync(filepath, example);

      return { success: true, filename, message: `Reglas de ejemplo creadas: ${filename}` };
    } catch (error: any) {
      return { success: false, message: `Error: ${error.message}` };
    }
  }
}

const ruleEngine = new RuleEngine();

const ruleEngineSkill: Skill = {
  name: 'rule_engine',
  description: 'Motor de reglas para validar acciones del agente. JSON Args: { "action": "validate|list|load|toggle|whitelist|blacklist|cache-clear|create-example", "actionName": "nombre", "args": {}, "trustLevel": 3, "ruleId": "id", "pattern": "", "enabled": true }',
  execute: async (args: any) => {
    try {
      const { action } = args;

      if (!action) {
        return { success: false, message: 'Se requiere action' };
      }

      switch (action) {
        case 'validate': {
          const { actionName, args: actionArgs, trustLevel, userLevel } = args;
          if (!actionName) {
            return { success: false, message: 'Se requiere actionName' };
          }
          
          const context: RuleContext = {
            action: actionName,
            args: actionArgs || {},
            trustLevel: trustLevel || 3,
            userLevel: userLevel || 3
          };
          
          return await ruleEngine.validateAction(context);
        }

        case 'list':
          return await ruleEngine.listRules();

        case 'load': {
          const { filename } = args;
          if (!filename) {
            return { success: false, message: 'Se requiere filename' };
          }
          return await ruleEngine.loadRules(filename);
        }

        case 'toggle': {
          const { ruleId, enabled } = args;
          if (!ruleId) {
            return { success: false, message: 'Se requiere ruleId' };
          }
          return await ruleEngine.toggleRule(ruleId, enabled !== false);
        }

        case 'whitelist': {
          const { pattern } = args;
          if (!pattern) {
            return { success: false, message: 'Se requiere pattern' };
          }
          return await ruleEngine.addToWhitelist(pattern);
        }

        case 'blacklist': {
          const { pattern } = args;
          if (!pattern) {
            return { success: false, message: 'Se requiere pattern' };
          }
          return await ruleEngine.addToBlacklist(pattern);
        }

        case 'cache-clear':
          return await ruleEngine.clearCache();

        case 'create-example':
          return await ruleEngine.createExampleRules();

        default:
          return { success: false, message: `Acción desconocida: ${action}` };
      }

    } catch (error: any) {
      return { success: false, message: `Error: ${error.message}` };
    }
  }
};

export default ruleEngineSkill;
