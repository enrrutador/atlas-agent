import type { Skill } from '../src/core/skills.js';
import * as fs from 'fs';
import * as path from 'path';
import { skillManager } from '../src/core/skills.js';

interface WorkflowDefinition {
  name: string;
  description?: string;
  trigger?: {
    on?: string;
    branch?: string;
    schedule?: string;
  };
  steps: StepDefinition[];
  variables?: Record<string, any>;
}

interface StepDefinition {
  id: string;
  name: string;
  action: string;
  args?: Record<string, any>;
  condition?: string;
  dependsOn?: string[];
  timeout?: number;
  retries?: number;
}

interface ExecutionContext {
  workflowId: string;
  stepResults: Map<string, any>;
  variables: Record<string, any>;
  startTime: Date;
  currentStep: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}

interface WorkflowExecution {
  id: string;
  workflow: WorkflowDefinition;
  context: ExecutionContext;
}

class WorkflowEngine {
  private workflowsDir: string;
  private activeExecutions: Map<string, WorkflowExecution> = new Map();
  private executionHistory: Array<{ id: string; workflow: string; status: string; duration: number; completedAt: Date }> = [];

  constructor() {
    this.workflowsDir = path.join(process.cwd(), 'workspace', 'workflows');
    this.ensureWorkflowsDirectory();
  }

  private ensureWorkflowsDirectory() {
    if (!fs.existsSync(this.workflowsDir)) {
      fs.mkdirSync(this.workflowsDir, { recursive: true });
      console.log(`[WORKFLOW] Directorio creado: ${this.workflowsDir}`);
    }
  }

  /**
   * Parsea un archivo markdown de workflow
   */
  private parseWorkflowMarkdown(content: string, filename: string): WorkflowDefinition {
    const workflow: WorkflowDefinition = {
      name: filename.replace('.md', ''),
      steps: []
    };

    const lines = content.split('\n');
    let currentStep: Partial<StepDefinition> = {};
    let inStep = false;
    let inArgs = false;
    let currentSection = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() || '';

      // Título del workflow
      if (line.startsWith('# ')) {
        workflow.name = line.substring(2).trim();
        continue;
      }

      // Descripción
      if (line.startsWith('## Description') || line.startsWith('### Description')) {
        currentSection = 'description';
        continue;
      }

      // Trigger
      if (line.startsWith('## Trigger') || line.startsWith('### Trigger')) {
        currentSection = 'trigger';
        workflow.trigger = {};
        continue;
      }

      // Steps
      if (line.startsWith('## Steps') || line.startsWith('### Steps')) {
        currentSection = 'steps';
        continue;
      }

      // Variables
      if (line.startsWith('## Variables') || line.startsWith('### Variables')) {
        currentSection = 'variables';
        workflow.variables = {};
        continue;
      }

      // Step individual (### Step X: Nombre)
      if (line.match(/^#{1,3}\s*Step\s+\d+[:\s]/i)) {
        if (inStep && currentStep.id) {
          workflow.steps.push(currentStep as StepDefinition);
        }
        
        const match = line.match(/Step\s+(\d+)[:\s]+(.+)/i);
        inStep = true;
        inArgs = false;
        currentStep = {
          id: match?.[1] ? `step_${match[1]}` : `step_${workflow.steps.length + 1}`,
          name: match?.[2] ? match[2].trim() : line.replace(/^#+\s*/, '')
        };
        continue;
      }

      // Parsear propiedades del step
      if (inStep) {
        // Action
        if (line.startsWith('action:')) {
          currentStep.action = line.substring(7).trim();
          continue;
        }

        // Condition
        if (line.startsWith('condition:')) {
          currentStep.condition = line.substring(10).trim();
          continue;
        }

        // DependsOn
        if (line.startsWith('dependsOn:')) {
          currentStep.dependsOn = line.substring(10).trim().split(',').map(s => s.trim());
          continue;
        }

        // Timeout
        if (line.startsWith('timeout:')) {
          currentStep.timeout = parseInt(line.substring(8).trim()) || 30000;
          continue;
        }

        // Retries
        if (line.startsWith('retries:')) {
          currentStep.retries = parseInt(line.substring(8).trim()) || 0;
          continue;
        }

        // Args section
        if (line.startsWith('args:')) {
          inArgs = true;
          currentStep.args = {};
          continue;
        }

        // Parsear args (formato YAML-like)
        if (inArgs && line.startsWith('-') || (inArgs && line.includes(':'))) {
          const argMatch = line.match(/^-\s*(\w+):\s*(.+)$/);
          if (argMatch && argMatch[1] && argMatch[2]) {
            const key = argMatch[1];
            const value = argMatch[2];
            if (currentStep.args) {
              currentStep.args[key] = this.parseValue(value.trim());
            }
          }
        }
      }

      // Parsear trigger properties
      if (currentSection === 'trigger') {
        if (line.startsWith('- on:')) {
          workflow.trigger!.on = line.substring(5).trim();
        } else if (line.startsWith('- branch:')) {
          workflow.trigger!.branch = line.substring(9).trim();
        } else if (line.startsWith('- schedule:')) {
          workflow.trigger!.schedule = line.substring(10).trim();
        }
      }

    // Parsear variables
    if (currentSection === 'variables') {
      const varMatch = line.match(/^(\w+):\s*(.+)$/);
      if (varMatch && varMatch[1] && varMatch[2] && workflow.variables) {
        const key = varMatch[1];
        const value = varMatch[2];
        workflow.variables[key] = this.parseValue(value.trim());
      }
    }

      // Descripción
      if (currentSection === 'description' && line && !line.startsWith('#')) {
        workflow.description = line;
        currentSection = '';
      }
    }

    // Agregar último step
    if (inStep && currentStep.id) {
      workflow.steps.push(currentStep as StepDefinition);
    }

    return workflow;
  }

  /**
   * Parsea un valor string a su tipo correcto
   */
  private parseValue(value: string): any {
    // Boolean
    if (value === 'true') return true;
    if (value === 'false') return false;
    
    // Number
    if (/^\d+$/.test(value)) return parseInt(value);
    if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
    
    // Array (comma-separated)
    if (value.includes(',')) {
      return value.split(',').map(s => this.parseValue(s.trim()));
    }
    
    // String (remove quotes)
    if (value.startsWith('"') && value.endsWith('"')) {
      return value.slice(1, -1);
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1);
    }
    
    return value;
  }

  /**
   * Carga un workflow desde archivo
   */
  async loadWorkflow(filename: string): Promise<{ success: boolean; workflow?: WorkflowDefinition; message: string }> {
    try {
      const filepath = path.join(this.workflowsDir, filename);
      
      if (!fs.existsSync(filepath)) {
        // Intentar con extensión .md
        if (!filename.endsWith('.md')) {
          return this.loadWorkflow(`${filename}.md`);
        }
        return { success: false, message: `Workflow no encontrado: ${filename}` };
      }

      const content = fs.readFileSync(filepath, 'utf-8');
      const workflow = this.parseWorkflowMarkdown(content, path.basename(filename, '.md'));

      return { success: true, workflow, message: `Workflow "${workflow.name}" cargado (${workflow.steps.length} steps)` };
    } catch (error: any) {
      return { success: false, message: `Error cargando workflow: ${error.message}` };
    }
  }

  /**
   * Lista workflows disponibles
   */
  async listWorkflows(): Promise<{ success: boolean; workflows: string[]; message: string }> {
    try {
      const files = fs.readdirSync(this.workflowsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''));

      return { success: true, workflows: files, message: `${files.length} workflows disponibles` };
    } catch (error: any) {
      return { success: false, workflows: [], message: `Error: ${error.message}` };
    }
  }

  /**
   * Ejecuta un workflow completo
   */
  async executeWorkflow(workflowName: string, variables?: Record<string, any>): Promise<{ success: boolean; executionId?: string; message: string; results?: any[] }> {
    try {
      const loadResult = await this.loadWorkflow(workflowName);
      if (!loadResult.success || !loadResult.workflow) {
        return { success: false, message: loadResult.message };
      }

      const workflow = loadResult.workflow;
      const executionId = `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const context: ExecutionContext = {
        workflowId: executionId,
        stepResults: new Map(),
        variables: { ...workflow.variables, ...variables },
        startTime: new Date(),
        currentStep: 0,
        status: 'running'
      };

      const execution: WorkflowExecution = {
        id: executionId,
        workflow,
        context
      };

      this.activeExecutions.set(executionId, execution);

      console.log(`[WORKFLOW] Iniciando: ${workflow.name} (${executionId})`);

      // Ejecutar steps
      const results: any[] = [];
      
      for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      if (!step) {
        console.log(`[WORKFLOW] Step ${i + 1} no encontrado, saltando`);
        continue;
      }
      context.currentStep = i + 1;

        // Verificar condición
        if (step.condition && !this.evaluateCondition(step.condition, context)) {
          console.log(`[WORKFLOW] Step ${step.id} saltado (condición)`);
          results.push({ step: step.id, status: 'skipped', reason: 'condition_not_met' });
          continue;
        }

        // Verificar dependencias
        if (step.dependsOn) {
          const depsMet = step.dependsOn.every(depId => {
            const depResult = context.stepResults.get(depId);
            return depResult && depResult.success;
          });
          
          if (!depsMet) {
            console.log(`[WORKFLOW] Step ${step.id} falló (dependencias no cumplidas)`);
            results.push({ step: step.id, status: 'failed', reason: 'dependencies_not_met' });
            context.status = 'failed';
            break;
          }
        }

        // Ejecutar step
        console.log(`[WORKFLOW] Ejecutando: ${step.name} (${step.action})`);
        const stepResult = await this.executeStep(step, context);
        context.stepResults.set(step.id, stepResult);
        results.push({ step: step.id, status: stepResult.success ? 'success' : 'failed', result: stepResult });

        if (!stepResult.success) {
          console.log(`[WORKFLOW] Step ${step.id} falló`);
          
          // Reintentar si aplica
          if (step.retries && step.retries > 0) {
            let retryCount = 0;
            while (retryCount < step.retries && !stepResult.success) {
              retryCount++;
              console.log(`[WORKFLOW] Reintentando ${step.id} (${retryCount}/${step.retries})`);
              const retryResult = await this.executeStep(step, context);
              if (retryResult.success) {
                context.stepResults.set(step.id, retryResult);
                results[results.length - 1] = { step: step.id, status: 'success', result: retryResult, retries: retryCount };
                break;
              }
            }
          }

          if (!stepResult.success) {
            context.status = 'failed';
            break;
          }
        }
      }

      // Finalizar
      const duration = Date.now() - context.startTime.getTime();
      context.status = context.status === 'running' ? 'completed' : context.status;

      this.executionHistory.push({
        id: executionId,
        workflow: workflow.name,
        status: context.status,
        duration,
        completedAt: new Date()
      });

      // Mantener solo últimos 100
      if (this.executionHistory.length > 100) {
        this.executionHistory = this.executionHistory.slice(-100);
      }

      const finalMessage = context.status === 'completed' 
        ? `✅ Workflow "${workflow.name}" completado (${duration}ms)`
        : `❌ Workflow "${workflow.name}" falló en step ${context.currentStep}`;

      console.log(`[WORKFLOW] ${finalMessage}`);

      return {
        success: context.status === 'completed',
        executionId,
        message: finalMessage,
        results
      };

    } catch (error: any) {
      return { success: false, message: `Error ejecutando workflow: ${error.message}` };
    }
  }

  /**
   * Ejecuta un step individual
   */
  private async executeStep(step: StepDefinition, context: ExecutionContext): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      // Preparar args con variables interpoladas
      const args = this.interpolateVariables(step.args || {}, context.variables);

      // Ejecutar usando skill manager
      const result = await skillManager.executeSkill(step.action, args);

      return {
        success: result.success !== false,
        message: result.message || `Step ${step.id} ejecutado`,
        data: result
      };

    } catch (error: any) {
      return {
        success: false,
        message: `Error en step ${step.id}: ${error.message}`
      };
    }
  }

  /**
   * Interpola variables en los argumentos
   */
  private interpolateVariables(args: Record<string, any>, variables: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string') {
        // Reemplazar {{variable}} con valor
        result[key] = value.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
          return variables[varName] !== undefined ? String(variables[varName]) : match;
        });
      } else {
        result[key] = value;
      }
    }
    
    return result;
  }

  /**
   * Evalúa una condición
   */
  private evaluateCondition(condition: string, context: ExecutionContext): boolean {
    try {
      // Evaluación simple de condiciones
      // Ej: "step_1.success" o "variables.env === 'production'"
      
      if (condition.includes('.')) {
        const parts = condition.split('.');
        if (parts[0]?.startsWith('step_')) {
          const stepResult = context.stepResults.get(parts[0]);
          if (stepResult && parts[1]) {
            return stepResult[parts[1]] === true || parts[1] === 'success' && stepResult.success;
          }
        }
      }

      // Variables
      if (condition.includes('===') || condition.includes('==')) {
        const match = condition.match(/(\w+)\s*===?\s*(.+)/);
        if (match && match[1] && match[2]) {
          const varName = match[1];
          const expectedValue = match[2];
          if (context.variables[varName] !== undefined) {
            return String(context.variables[varName]) === expectedValue.replace(/['"]/g, '');
          }
        }
      }

      return true;
    } catch {
      return true;
    }
  }

  /**
   * Obtiene estado de ejecución
   */
  async getExecutionStatus(executionId: string): Promise<{ success: boolean; status?: string; progress?: number; message: string }> {
    const execution = this.activeExecutions.get(executionId);
    
    if (!execution) {
      // Buscar en historial
      const history = this.executionHistory.find(h => h.id === executionId);
      if (history) {
        return {
          success: true,
          status: history.status,
          message: `Ejecución ${executionId} completada (${history.status})`
        };
      }
      return { success: false, message: `Ejecución ${executionId} no encontrada` };
    }

    const progress = Math.round((execution.context.currentStep / execution.workflow.steps.length) * 100);
    
    return {
      success: true,
      status: execution.context.status,
      progress,
      message: `${execution.workflow.name}: ${execution.context.currentStep}/${execution.workflow.steps.length} steps (${progress}%)`
    };
  }

  /**
   * Cancela una ejecución
   */
  async cancelExecution(executionId: string): Promise<{ success: boolean; message: string }> {
    const execution = this.activeExecutions.get(executionId);
    
    if (!execution) {
      return { success: false, message: `Ejecución ${executionId} no encontrada` };
    }

    execution.context.status = 'cancelled';
    
    return { success: true, message: `Ejecución ${executionId} cancelada` };
  }

  /**
   * Obtiene historial de ejecuciones
   */
  async getExecutionHistory(limit: number = 10): Promise<{ success: boolean; history: any[]; message: string }> {
    const history = this.executionHistory
      .slice(-limit)
      .reverse()
      .map(h => ({
        id: h.id,
        workflow: h.workflow,
        status: h.status,
        duration: h.duration,
        completedAt: h.completedAt
      }));

    return {
      success: true,
      history,
      message: `${history.length} ejecuciones recientes`
    };
  }

  /**
   * Crea un workflow de ejemplo
   */
  async createExampleWorkflow(): Promise<{ success: boolean; message: string; filename?: string }> {
    try {
      const example = `# Descarga de Imágenes

## Description
Workflow para descargar imágenes de múltiples fuentes

## Trigger
- on: manual

## Variables
outputDir: ./downloads
quality: high

## Steps

### Step 1: Buscar en Google
action: human_image_downloader
args:
  - query: "paisajes montaña"
  - limit: 5
  - outputDir: "{{outputDir}}"

### Step 2: Procesar imágenes
action: code_executor
args:
  - language: javascript
  - code: "console.log('Procesando...')"
condition: step_1.success

### Step 3: Notificar
action: telegram_notify
args:
  - message: "Descarga completada"
dependsOn:
  - step_2`;

      const filename = `example_workflow_${Date.now()}.md`;
      const filepath = path.join(this.workflowsDir, filename);
      fs.writeFileSync(filepath, example);

      return { success: true, filename, message: `Workflow de ejemplo creado: ${filename}` };
    } catch (error: any) {
      return { success: false, message: `Error: ${error.message}` };
    }
  }
}

const workflowEngine = new WorkflowEngine();

const workflowEngineSkill: Skill = {
  name: 'workflow_engine',
  description: 'Motor de workflows para ejecutar pipelines de tareas. JSON Args: { "action": "run|list|status|cancel|history|create-example", "workflow": "nombre", "variables": {}, "executionId": "id" }',
  execute: async (args: any) => {
    try {
      const { action } = args;

      if (!action) {
        return { success: false, message: 'Se requiere action' };
      }

      switch (action) {
        case 'run':
        case 'execute': {
          const { workflow, variables } = args;
          if (!workflow) {
            return { success: false, message: 'Se requiere nombre del workflow' };
          }
          return await workflowEngine.executeWorkflow(workflow, variables);
        }

        case 'list':
          return await workflowEngine.listWorkflows();

        case 'status': {
          const { executionId } = args;
          if (!executionId) {
            return { success: false, message: 'Se requiere executionId' };
          }
          return await workflowEngine.getExecutionStatus(executionId);
        }

        case 'cancel': {
          const { executionId } = args;
          if (!executionId) {
            return { success: false, message: 'Se requiere executionId' };
          }
          return await workflowEngine.cancelExecution(executionId);
        }

        case 'history': {
          const { limit } = args;
          return await workflowEngine.getExecutionHistory(limit || 10);
        }

        case 'create-example':
          return await workflowEngine.createExampleWorkflow();

        default:
          return { success: false, message: `Acción desconocida: ${action}` };
      }

    } catch (error: any) {
      return { success: false, message: `Error: ${error.message}` };
    }
  }
};

export default workflowEngineSkill;
