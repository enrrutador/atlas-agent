/**
 * Atlas Agent v4.0 — Main Entry Point
 * Initializes all modules and starts the agent
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { logger } from './common/logger.js';
import { atlasDB } from './memory/atlas_db.js';
import { pythonBridge } from './arms/bridge/python_bridge.js';
import { scheduler } from './brain/scheduler.js';
import { forgeReasoner } from './forge/core/forge_reasoner.js';
import { forgeRunner } from './forge/missions/forge_runner.js';
import { missionManager } from './forge/missions/mission_manager.js';
import { taskHandler } from './brain/task_handler.js';
import { brainSkills } from './brain/skills.js';
import { queryClassifier } from './brain/query_classifier.js';
import { confidenceRouter } from './brain/confidence_router.js';
import { synthesizer } from './brain/synthesizer.js';
import { subQuestionDecomposer } from './brain/subquestion_decomposer.js';
import { sourceAgentOrchestrator } from './brain/source_agents.js';
import { semanticCache } from './brain/semantic_cache.js';
import { feedbackLoop } from './brain/feedback_loop.js';
import { multiAgentOrchestrator } from './brain/multi_agent_orchestrator.js';
import { sessionDB } from './memory/session_db.js';
import { ragManager } from './memory/rag.js';
import { cliInterface } from './interfaces/cli.js';
import { telegramInterface } from './interfaces/telegram/bot.js';
import { dashboard } from './interfaces/dashboard.js';
import { monitor } from './shield/monitor.js';
import { AtlasConfig, Skill } from './common/types.js';
import { terminalTool } from './arms/tools/terminal.js';
import { fileManagerTool } from './arms/tools/file_manager.js';
import { downloaderTool } from './arms/tools/downloader.js';
import { visionTool } from './arms/tools/vision.js';
import { audioTool } from './arms/tools/audio.js';
import { socialMediaTool } from './arms/tools/social_media.js';
import { codeTool } from './arms/tools/code.js';
import { projectTool } from './arms/tools/project.js';
import { gitTool } from './arms/tools/git.js';
import { mathTool } from './arms/tools/math.js';
import { translateTool } from './arms/tools/translate.js';
import { memoryTool } from './arms/tools/memory_tool.js';
import { webTool } from './arms/tools/web/index.js';

function loadConfig(): AtlasConfig {
  return {
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    modelName: process.env.MODEL_NAME || 'meta/llama-3.1-8b-instruct',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    adminChatId: parseInt(process.env.ADMIN_CHAT_ID || '0', 10),
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    dataDir: process.env.DATA_DIR || './data',
  };
}

function registerDefaultSkills(): void {
  const skills: Skill[] = [
    {
      name: 'shell_execute',
      description: 'Ejecuta comandos de terminal/shell',

      parameters: [{ name: 'command', type: 'string', description: 'Comando a ejecutar', required: true }],
      handler: async (args) => {
        const result = await terminalTool.execute(args.command);
        return result.stdout || result.stderr;
      },
    },
    {
      name: 'web_search',
      description: 'Busca informacion en la web (multi-engine: SearXNG, DuckDuckGo, Brave)',

      parameters: [
        { name: 'query', type: 'string', description: 'Termino de busqueda', required: true },
        { name: 'type', type: 'string', description: 'Tipo: web, news o image', required: false },
        { name: 'count', type: 'number', description: 'Cantidad de resultados', required: false },
      ],
      handler: async (args) => webTool.search(args.query, args.type || 'web', args.count || 8),
    },
    {
      name: 'web_scrape',
      description: 'Extrae contenido completo de una URL (articulos, docs, paginas)',

      parameters: [
        { name: 'url', type: 'string', description: 'URL a extraer', required: true },
        { name: 'depth', type: 'string', description: 'basic o full (default full)', required: false },
      ],
      handler: async (args) => webTool.scrape(args.url, args.depth || 'full'),
    },
    {
      name: 'web_download',
      description: 'Descarga archivos desde una URL',

      parameters: [
        { name: 'url', type: 'string', description: 'URL del archivo', required: true },
        { name: 'dest_dir', type: 'string', description: 'Directorio destino', required: false },
        { name: 'filename', type: 'string', description: 'Nombre del archivo', required: false },
      ],
      handler: async (args) => webTool.download(args.url, args.dest_dir || './downloads', args.filename),
    },
    {
      name: 'read_file',
      description: 'Lee el contenido de un archivo',

      parameters: [{ name: 'path', type: 'string', description: 'Ruta del archivo', required: true }],
      handler: async (args) => fileManagerTool.readFile(args.path),
    },
    {
      name: 'save_file',
      description: 'Escribe contenido a un archivo',

      parameters: [
        { name: 'path', type: 'string', description: 'Ruta del archivo', required: true },
        { name: 'content', type: 'string', description: 'Contenido a escribir', required: true },
      ],
      handler: async (args) => {
        fileManagerTool.writeFile(args.path, args.content);
        return `Archivo guardado: ${args.path}`;
      },
    },
    {
      name: 'delete_file',
      description: 'Elimina un archivo',

      parameters: [{ name: 'path', type: 'string', description: 'Ruta del archivo', required: true }],
      handler: async (args) => {
        fileManagerTool.deleteFile(args.path);
        return `Archivo eliminado: ${args.path}`;
      },
    },
    {
      name: 'download_file',
      description: 'Descarga un archivo desde una URL',

      parameters: [
        { name: 'url', type: 'string', description: 'URL del archivo', required: true },
        { name: 'filename', type: 'string', description: 'Nombre del archivo destino', required: false },
      ],
      handler: async (args) => {
        const savedPath = await downloaderTool.download(args.url, args.filename);
        return `Descargado en: ${savedPath}`;
      },
    },
    {
      name: 'list_files',
      description: 'Lista archivos en un directorio',

      parameters: [{ name: 'path', type: 'string', description: 'Ruta del directorio', required: true }],
      handler: async (args) => {
        const files = fileManagerTool.listFiles(args.path);
        return files.join('\n') || 'Directorio vacio o no encontrado';
      },
    },
    {
      name: 'nvidia_vision',
      description: 'Analiza imagenes con NVIDIA VLM',

      parameters: [
        { name: 'image_url', type: 'string', description: 'URL de la imagen', required: true },
        { name: 'prompt', type: 'string', description: 'Prompt adicional', required: false },
      ],
      handler: async (args) => visionTool.analyzeImage(args.image_url, args.prompt),
    },
    {
      name: 'nvidia_audio',
      description: 'Transcripcion de audio y TTS',

      parameters: [
        { name: 'action', type: 'string', description: 'transcribe o speak', required: true },
        { name: 'audio_url', type: 'string', description: 'URL del audio', required: false },
        { name: 'text', type: 'string', description: 'Texto para TTS', required: false },
      ],
      handler: async (args) => {
        if (args.action === 'speak') return audioTool.textToSpeech(args.text || '');
        return audioTool.transcribe(args.audio_url || '');
      },
    },
    {
      name: 'social_media',
      description: 'Publica en redes sociales via Zenrio',

      parameters: [
        { name: 'action', type: 'string', description: 'post, analytics, trending o schedule', required: true },
        { name: 'platform', type: 'string', description: 'Red social', required: false },
        { name: 'content', type: 'string', description: 'Contenido', required: false },
      ],
      handler: async (args) => {
        if (args.action === 'post') return socialMediaTool.post({ platform: args.platform || 'twitter', content: args.content || '' });
        if (args.action === 'analytics') return socialMediaTool.getAnalytics({ platform: args.platform || 'twitter' });
        if (args.action === 'trending') return socialMediaTool.getTrending({ platform: args.platform || 'twitter' });
        return 'Accion no soportada';
      },
    },
    {
      name: 'code_analyze',
      description: 'Analiza codigo existente',

      parameters: [
        { name: 'code', type: 'string', description: 'Codigo a analizar', required: true },
        { name: 'file_path', type: 'string', description: 'Ruta del archivo', required: false },
      ],
      handler: async (args) => codeTool.analyzeCode(args.code, args.file_path || ''),
    },
    {
      name: 'code_generate',
      description: 'Genera codigo a partir de descripcion',

      parameters: [
        { name: 'description', type: 'string', description: 'Descripcion del codigo', required: true },
        { name: 'language', type: 'string', description: 'Lenguaje', required: false },
        { name: 'context', type: 'string', description: 'Contexto adicional', required: false },
      ],
      handler: async (args) => codeTool.generateCode(args.description, args.language || 'typescript', args.context || ''),
    },
    {
      name: 'code_debug',
      description: 'Debuggea y corrige errores en codigo',

      parameters: [
        { name: 'code', type: 'string', description: 'Codigo con error', required: true },
        { name: 'error', type: 'string', description: 'Mensaje de error', required: false },
      ],
      handler: async (args) => codeTool.debugCode(args.code, args.error || ''),
    },
    {
      name: 'project_scaffold',
      description: 'Scaffolding de proyectos',

      parameters: [
        { name: 'template', type: 'string', description: 'Template a usar', required: true },
        { name: 'project_name', type: 'string', description: 'Nombre del proyecto', required: true },
        { name: 'target_dir', type: 'string', description: 'Directorio destino', required: false },
      ],
      handler: async (args) => projectTool.scaffold(args.template, args.project_name, args.target_dir || process.cwd()),
    },
    {
      name: 'git_manager',
      description: 'Operaciones Git',

      parameters: [
        { name: 'command', type: 'string', description: 'Comando git', required: true },
        { name: 'message', type: 'string', description: 'Mensaje de commit', required: false },
        { name: 'cwd', type: 'string', description: 'Directorio de trabajo', required: false },
      ],
      handler: async (args) => {
        switch (args.command) {
          case 'status': return gitTool.status(args.cwd);
          case 'commit': return gitTool.commit(args.message || 'Atlas commit', args.cwd);
          case 'push': return gitTool.push(args.cwd);
          case 'pull': return gitTool.pull(args.cwd);
          case 'log': return gitTool.log(10, args.cwd);
          case 'branch': return gitTool.branch(args.cwd);
          case 'diff': return gitTool.diff(args.cwd);
          default: return `Comando git "${args.command}" no soportado`;
        }
      },
    },
    {
      name: 'math_calculate',
      description: 'Calcula expresiones matematicas',

      parameters: [{ name: 'expression', type: 'string', description: 'Expresion matematica', required: true }],
      handler: async (args) => mathTool.calculate(args.expression),
    },
    {
      name: 'translate',
      description: 'Traduce texto entre idiomas',

      parameters: [
        { name: 'text', type: 'string', description: 'Texto a traducir', required: true },
        { name: 'target_lang', type: 'string', description: 'Idioma destino', required: true },
      ],
      handler: async (args) => translateTool.translate(args.text, args.target_lang),
    },
    {
      name: 'memory_recall',
      description: 'Recupera informacion guardada en la memoria de Atlas',

      parameters: [
        { name: 'query', type: 'string', description: 'Que recordar', required: true },
      ],
      handler: async (args) => memoryTool.recall({ query: args.query }),
    },
  ];

  for (const skill of skills) {
    brainSkills.register(skill);
  }

  logger.info('main', `Registered ${skills.length} default skills`);
}

class LLMClient {
  private config: AtlasConfig;
  private maxRetries = 2;

  constructor(config: AtlasConfig) {
    this.config = config;
  }

  private cleanMessages(messages: any[]): any[] {
    return messages.map(m => {
      const clean: any = { role: m.role };
      if (m.role === 'tool') {
        clean.tool_call_id = m.tool_call_id;
        clean.content = m.content ?? '';
      } else if (m.tool_calls) {
        clean.content = m.content ?? null;
        clean.tool_calls = m.tool_calls;
      } else {
        clean.content = m.content ?? '';
      }
      return clean;
    });
  }

  async chatCompletion(messages: any[], maxTokens: number = 512): Promise<string> {
    const clean = this.cleanMessages(messages);
    const axios = (await import('axios')).default;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          logger.info('llm', `Retry ${attempt}/${this.maxRetries}`);
          await new Promise(r => setTimeout(r, attempt * 2000));
        }

        const response = await axios.post(
          `${this.config.openaiBaseUrl}/chat/completions`,
          {
            model: this.config.modelName,
            messages: clean,
            temperature: 0.7,
            max_tokens: maxTokens,
          },
          {
            headers: {
              'Authorization': `Bearer ${this.config.openaiApiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 30000,
          }
        );
        return response.data.choices?.[0]?.message?.content || 'No response';
      } catch (err: any) {
        lastError = err;
        const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
        const isRetryable = isTimeout || err.response?.status >= 500;

        logger.warn('llm', `Attempt ${attempt + 1} failed: ${err.message}`);

        if (!isRetryable) throw err;
      }
    }
    throw lastError || new Error('LLM request failed');
  }

  async chatCompletionWithTools(
    messages: any[],
    tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: any } }>,
    maxTokens: number = 1024
  ): Promise<{ content: string | null; toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> }> {
    const clean = this.cleanMessages(messages);
    const axios = (await import('axios')).default;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          logger.info('llm', `Tool call retry ${attempt}/${this.maxRetries}`);
          await new Promise(r => setTimeout(r, attempt * 2000));
        }

        const body: any = {
          model: this.config.modelName,
          messages: clean,
          temperature: 0.3,
          max_tokens: maxTokens,
          tools,
          tool_choice: 'auto',
        };

        const response = await axios.post(
          `${this.config.openaiBaseUrl}/chat/completions`,
          body,
          {
            headers: {
              'Authorization': `Bearer ${this.config.openaiApiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 30000,
          }
        );

        const choice = response.data.choices?.[0];
        const message = choice?.message;

        const toolCalls = (message?.tool_calls || []).map((tc: any) => ({
          id: tc.id,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));

        return {
          content: message?.content || null,
          toolCalls,
        };
      } catch (err: any) {
        lastError = err;
        const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
        const isRetryable = isTimeout || err.response?.status >= 500;
        logger.warn('llm', `Tool call attempt ${attempt + 1} failed: ${err.message}`);
        if (!isRetryable) {
          logger.warn('llm', 'Tool calling may not be supported by this model — falling back');
          break;
        }
      }
    }

    // Fallback: try without tools
    try {
      const fallback = await this.chatCompletion(messages, maxTokens);
      return { content: fallback, toolCalls: [] };
    } catch {
      throw lastError || new Error('LLM request failed');
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  logger.info('main', `Atlas Agent v4.0 starting...`);
  logger.info('main', `Model: ${config.modelName}`);

  // 1. Initialize memory DB
  await atlasDB.initialize();
  logger.info('main', 'Memory DB initialized');

  // 3. Start session prune cycle
  sessionDB.startPruneCycle();
  logger.info('main', 'Session prune cycle started');

  // 4. Register default skills
  registerDefaultSkills();

  // 5. Schedule background RAG indexing
  scheduler.schedule({
    name: 'RAG Codebase Indexing',
    action: () => ragManager.indexCodebase(),
    intervalMs: 30 * 60 * 1000,
    recurring: true,
  });
  logger.info('main', 'RAG indexing scheduled (30min interval)');

  // 5b. Schedule semantic cache pruning
  scheduler.schedule({
    name: 'Semantic Cache Prune',
    action: async () => {
      const pruned = semanticCache.prune();
      if (pruned > 0) logger.info('main', `Semantic cache pruned ${pruned} expired entries`);
      const stats = semanticCache.getStats();
      logger.info('main', `Cache stats: ${stats.hits} hits, ${stats.misses} misses, ${stats.size} entries, hitRate=${(stats.hitRate * 100).toFixed(1)}%`);
    },
  intervalMs: 10 * 60 * 1000,
  recurring: true,
  });

  // 5c. Schedule feedback loop daily decay
  scheduler.schedule({
    name: 'Feedback Loop Decay',
    action: async () => {
      feedbackLoop.applyDailyDecay();
      const stats = feedbackLoop.getStats();
      logger.info('main', `Feedback stats: ${stats.totalFeedback} total, corrections: ${stats.byType.correction}, confirmations: ${stats.byType.confirmation}`);
    },
    intervalMs: 24 * 60 * 60 * 1000,
    recurring: true,
  });

  // 6. Initialize LLM client
  const llmClient = new LLMClient(config);

  // 6a. Inject LLM clients into tools that need them
  codeTool.setLLMClient(llmClient);
  translateTool.setLLMClient(llmClient);

  // 6b. Connect LLM to task handler for skill routing
  taskHandler.setLLMClient(llmClient);

  // 6c. Initialize Confidence-Based Source Router
  const classifierModel = process.env.CLASSIFIER_MODEL || 'nvidia/nemotron-mini-4b-instruct';
  const classifierTimeout = parseInt(process.env.CLASSIFIER_TIMEOUT_MS || '3000', 10);
  const confidenceThreshold = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.6');
  queryClassifier.setLLMClient(llmClient);
  queryClassifier.setClassifierModel(classifierModel);
  queryClassifier.setTimeoutMs(classifierTimeout);
  confidenceRouter.setLLMClient(llmClient);
  confidenceRouter.setConfidenceThreshold(confidenceThreshold);
  synthesizer.setLLMClient(llmClient);
  subQuestionDecomposer.setLLMClient(llmClient);
  subQuestionDecomposer.setClassifierModel(classifierModel);
  subQuestionDecomposer.setTimeoutMs(classifierTimeout + 2000);
  sourceAgentOrchestrator.setLLMClient(llmClient);
  feedbackLoop.setLLMClient(llmClient);
  multiAgentOrchestrator.setLLMClient(llmClient);
  logger.info('main', `Confidence Router initialized (classifier: ${classifierModel}, threshold: ${confidenceThreshold})`);
  logger.info('main', `Source Agents initialized (6 specialized agents: general, memory, web, code, project, tool)`);
  logger.info('main', `Semantic Cache initialized (TTL: general=60m, web=5m, tool=2m, max=500 entries)`);
  logger.info('main', `Feedback Loop initialized (correction/confirmation/rejection/clarification detection)`);
  logger.info('main', `Multi-Agent Orchestrator initialized (parallel, sequential, pipeline strategies)`);

  // 7. Configure Forge with LLM
  forgeReasoner.setLLMClient(llmClient);
  forgeRunner.setLLMClient(config);
  missionManager.setConfig(config);
  logger.info('main', 'Forge reasoner configured');
  logger.info('main', 'Forge mission runner initialized');

  // 8. Start Python Bridge (optional)
  const bridgeReady = await pythonBridge.start();
  if (bridgeReady) {
    logger.info('main', 'Python Bridge ready');
  } else {
    logger.warn('main', 'Python Bridge not available (desktop automation disabled)');
  }

  // 9. Start scheduler
  scheduler.start();
  logger.info('main', 'Scheduler started');

  // 10. Print dashboard
  console.log(dashboard.render());

  // 11. Start interfaces
  const mode = process.argv[2] || 'cli';

  const skillsDesc = brainSkills.list().map(s => ` • "${s.name}": ${s.description}`).join('\n');
  const skillNames = brainSkills.list().map(s => s.name).join(', ');

  let knowledgeBlock = '';
  const knowledgePath = path.join(process.cwd(), 'workspace', 'memory', 'ATLAS_KNOWLEDGE.md');
  if (fs.existsSync(knowledgePath)) {
    knowledgeBlock = `\n\n=== CONOCIMIENTO PROPIO (ya sabés esto, no busques en la web) ===\n${fs.readFileSync(knowledgePath, 'utf-8')}`;
  }
  let userBlock = '';
  const userPath = path.join(process.cwd(), 'workspace', 'memory', 'ATLAS_USER.md');
  if (fs.existsSync(userPath)) {
    userBlock = `\n\n=== PERFIL DEL USUARIO ===\n${fs.readFileSync(userPath, 'utf-8')}`;
  }

  const atlasSystemPrompt = `Sos Atlas, un agente AI creado por Marcelo. Tu personalidad es AMIGABLE y COLOQUIAL. Respondé como un amigo explicando algo, NO como un manual técnico.

INFO SOBRE VOS:
- Modelo: ${config.modelName}
- Fecha actual: ${new Date().toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
- Hora actual: ${new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
- Si te preguntan qué modelo sos, qué día es hoy o qué hora es, usá esta info.

ARQUITECTURA (sabé que existe pero no lo menciones si no hace falta):
- Vos (Brain) ejecutás tareas usando skills. Si algo es muy complejo, lo escala al Forge.
- Forge: neurona maestra para razonamiento profundo y propuestas.

TUS HERRAMIENTAS (skills) — usalas cuando te pidan algo que coincida:
${skillsDesc}

CÓMO USAR HERRAMIENTAS (ReAct):

⚠️ REGLA MÁS IMPORTANTE — CUÁNDO USAR web_search vs CONOCIMIENTO PROPIO:

NUNCA uses web_search para cosas que YA SABÉS. Tu conocimiento interno incluye:
- Geografía (dónde queda una ciudad, capital de un país, continentes, etc.)
- Historia general (guerras, fechas históricas, personajes históricos)
- Definiciones (qué es X, qué significa Y)
- Matemáticas (cálculos, conversiones)
- Ciencia básica (fórmulas, conceptos, biología, física elemental)
- Cultura general (quién escribió X, quién pintó Y, etc.)
- Programación y tecnología (lenguajes, frameworks, algoritmos, sintaxis)
- Idiomas (traducciones, gramática)
Para todo esto: RESPONDÉ DIRECTAMENTE con lo que ya sabés.

SOLO usá web_search cuando necesites información ACTUAL o que cambia con el tiempo:
- Clima actual en una ciudad
- Precio del dólar, cotizaciones, mercado
- Noticias de hoy
- Eventos recientes o próximos
- Resultados deportivos de hoy
- Tendencias actuales en redes sociales
- Información que puede haber cambiado desde tu entrenamiento
- Algo que explícitamente te pidan "buscar en internet" o "averiguar en la web"

DESPUÉS de usar una herramienta:
- NUNCA devuelvas el resultado crudo (JSON, snippets, links).
- ANALIZÁ el resultado y redactá una respuesta en lenguaje natural, coloquial.
- Si buscaste el clima, decí "En Mendoza está X grados con Y" — no pegues el JSON.
- Si buscaste noticias, contá las más importantes con tus palabras.

OTRAS HERRAMIENTAS (shell_execute, save_file, math_calculate, etc.):
- Usalas cuando el usuario pida explícitamente una ACCIÓN: ejecutar, crear, guardar, calcular, etc.
- Si el usuario solo pregunta o chatea, NO llames herramientas. Respondé directo.

FLUJO GENERAL:
- ¿El usuario solo saluda, opina, agradece o chatea? → respondé directamente, sin herramientas.
- ¿Pregunta algo general que ya sabés? → respondé con tu conocimiento, sin herramientas.
- ¿Pregunta algo que cambia hoy/ahora? → usá web_search, luego sintetizá.
- ¿Pide una acción? → usá la herramienta correspondiente, luego contá qué pasó.
- Podés llamar VARIAS herramientas en SECUENCIA si un paso depende de otro.
- Cuando tengas suficiente información para responder, NO llames más herramientas. Respondé directamente.
- Si una herramienta da error, intentá con otra o decile al usuario.

REGLAS:
1. Respondé SIEMPRE en español coloquial. Nada de jerga técnica. Sé natural.
2. Si te preguntan "qué sabés hacer", listá tus skills de forma amigable.
3. No inventes información actual (precios, clima, noticias). Si no estás seguro, busca.
4. SÉ BREVE. Respuestas de 2-3 párrafos máximo.
5. NUNCA devuelvas JSON, código, o resultados crudos de herramientas al usuario. Sintetizá.

Skills disponibles por nombre: ${skillNames}${knowledgeBlock}${userBlock}`;

  taskHandler.setSystemPrompt(atlasSystemPrompt);
  confidenceRouter.setSystemPrompt(atlasSystemPrompt);
  sourceAgentOrchestrator.setSystemPrompt(atlasSystemPrompt);
  multiAgentOrchestrator.setSystemPrompt(atlasSystemPrompt);

  if (mode === 'telegram' || mode === 'both') {
    telegramInterface.setLLMClient(llmClient);
    telegramInterface.setSystemPrompt(atlasSystemPrompt);
    const tgOk = await telegramInterface.start();
    if (tgOk) logger.info('main', 'Telegram bot started');
  }

  if (mode === 'cli' || mode === 'both') {
    cliInterface.setLLMClient(llmClient);
    cliInterface.setSystemPrompt(atlasSystemPrompt);
    await cliInterface.start();
  }

  logger.info('main', 'Atlas Agent online');
}

main().catch((err) => {
  monitor.logError('main_crash', err);
  logger.critical('main', `Fatal: ${err}`);
  process.exit(1);
});
