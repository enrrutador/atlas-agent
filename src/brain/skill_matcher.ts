import { Skill } from '../common/types.js';

export interface SkillMatch {
  name: string;
  confidence: number;
  args: Record<string, any>;
}

const SKILL_KEYWORDS: Record<string, string[]> = {
  shell_execute: ['ejecutar', 'correr', 'run', 'comando', 'command', 'terminal', 'shell', 'bash', 'cmd', 'consola', 'execute', 'script'],
  web_search: ['buscar', 'busca', 'search', 'encontrar', 'find', 'google', 'duckduckgo',
    'información', 'info', 'consulta', 'query', 'investigar', 'look up', 'lookup',
    'clima', 'pronóstico', 'pronostico', 'temperatura', 'weather', 'forecast',
    'noticias', 'news', 'últimas', 'novedades', 'actualidad',
    'precio', 'price', 'cotización', 'cotizacion', 'vale', 'cuesta',
    'resultados', 'results', 'partido', 'match', 'deporte', 'sports',
    'horóscopo', 'horoscopo', 'signo', 'zodiaco',
    'último', 'ultimo', 'última', 'ultima', 'latest', 'breaking',
    'dólar', 'dolar', 'euro', 'bitcoin', 'cripto', 'crypto',
    'trámite', 'tramite', 'requisito', 'documento', 'formulario',
    'receta', 'cocina', 'recipe', 'cómo hacer', 'como hacer',
    'mapa', 'dirección', 'direccion', 'ubicación', 'ubicacion',
    'restaurante', 'hotel', 'vuelo', 'flight', 'reserva',
    'estado del tiempo', 'lluvia', 'soleado', 'nublado'],
  read_file: ['leer', 'lee', 'read', 'mostrar', 'show', 'cat', 'contenido', 'archivo', 'file', 'ver', 'view', 'open', 'abrir', 'display'],
  save_file: ['guardar', 'graba', 'save', 'escribir', 'write', 'crear archivo', 'create file', 'almacenar', 'store', 'escribí', 'write file'],
  delete_file: ['eliminar', 'borrar', 'delete', 'remove', 'rm', 'borra', 'elimina', 'destruir'],
  download_file: ['descargar', 'download', 'bajar', 'fetch', 'get file', 'descarga', 'obtener archivo'],
  list_files: ['listar', 'lista', 'list', 'ls', 'dir', 'directorio', 'directory', 'archivos en', 'files in', 'contenido de carpeta', 'qué hay en'],
  code_analyze: ['analizar código', 'code review', 'review', 'revisar código', 'análisis', 'analyze code', 'auditar', 'audit', 'code quality', 'calidad'],
  code_generate: ['generar código', 'code gen', 'create code', 'crear código', 'programar', 'program', 'desarrollar', 'develop', 'escribir código', 'write code', 'implementar', 'implement', 'función', 'function', 'clase', 'class', 'api', 'endpoint', 'componente', 'component'],
  code_debug: ['debug', 'error', 'bug', 'fix', 'arreglar', 'corregir', 'corregir error', 'solucionar', 'solucionar bug', 'stack trace', 'traceback', 'fixear'],
  nvidia_vision: ['ver imagen', 'analizar imagen', 'image', 'foto', 'photo', 'picture', 'ver', 'vision', 'visión', 'screenshot', 'captura', 'reconocer', 'recognize', 'describe imagen', 'describe image', 'what is in this image', 'qué hay en la imagen', 'ocr'],
  nvidia_audio: ['audio', 'sonido', 'transcribir', 'transcribe', 'speech', 'voz', 'voice', 'hablar', 'speak', 'escuchar', 'listen', 'tts', 'stt', 'dictar', 'dictado', 'text to speech', 'speech to text'],
  social_media: ['post', 'tweet', 'publicar', 'publish', 'red social', 'social media', 'instagram', 'twitter', 'x.com', 'facebook', 'tiktok', 'linkedin', 'zenrio', 'postear', 'compartir', 'share'],
  project_scaffold: ['proyecto', 'project', 'scaffold', 'inicializar', 'initialize', 'setup', 'crear proyecto', 'create project', 'nueva app', 'new app', 'boilerplate', 'template'],
  task_plan: ['plan', 'planificar', 'organizar', 'tareas', 'tasks', 'roadmap', 'schedule', 'cronograma', 'todo list', 'checklist', 'gestionar', 'manage tasks'],
  memory_recall: ['recordar', 'remember', 'memoria', 'memory', 'olvidé', 'forgot', 'qué dije', 'what did I say', 'historial', 'history', 'sesión anterior', 'previous session', 'contexto', 'context'],
  math_calculate: ['calcular', 'calculate', 'matemática', 'math', 'operación', 'operation', 'suma', 'resta', 'multiplicar', 'dividir', 'fórmula', 'formula', 'compute', 'número'],
  translate: ['traducir', 'translate', 'traducción', 'translation', 'inglés', 'english', 'español', 'spanish', 'portugués', 'portuguese', 'idioma', 'language'],
  git_manager: ['git', 'commit', 'push', 'pull', 'branch', 'merge', 'rebase', 'clone', 'repo', 'repositorio', 'repository', 'status git'],
};

export function matchSkillFromInput(input: string, skills: Skill[]): SkillMatch | null {
  const lower = input.toLowerCase();
  let bestMatch: SkillMatch | null = null;
  let bestScore = 0;

  for (const skill of skills) {
    const keywords = SKILL_KEYWORDS[skill.name];
    if (!keywords) continue;

    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        score += kw.length;
      }
    }

    if (score > bestScore && score >= 5) {
      bestScore = score;
      bestMatch = {
        name: skill.name,
        confidence: Math.min(score / 20, 0.95),
        args: extractArgs(input, skill),
      };
    }
  }

  return bestMatch;
}

function extractArgs(input: string, skill: Skill): Record<string, any> {
  const args: Record<string, any> = {};

  switch (skill.name) {
    case 'shell_execute': {
      const patterns = [
        /(?:ejecutá|ejecuta|corré|corre|run|execute|corr[eé]r?)\s+(?:el\s+)?comando\s+["']?([^"']+?)["']?\s*$/i,
        /(?:ejecutá|ejecuta|corré|corre|run|execute)\s+["'](.+?)["']/i,
        /(?:en\s+la\s+terminal|terminal):\s*(.+)/i,
        /(?:shell|bash|cmd)\s+["'](.+?)["']/i,
        /`([^`]+)`/,
      ];
      for (const p of patterns) {
        const m = input.match(p);
        if (m) { args.command = m[1].trim(); break; }
      }
      if (!args.command) {
        const cmdWords = input.split(/\s+/);
        const cmdIdx = cmdWords.findIndex(w => /^(comando|command|run|ejecutar|ejecutá|ejecuta|correr|corré|corre|execute|shell|bash)$/i.test(w));
        if (cmdIdx >= 0 && cmdIdx + 1 < cmdWords.length) {
          args.command = cmdWords.slice(cmdIdx + 1).join(' ').replace(/^["']|["']$/g, '');
        }
      }
      break;
    }
    case 'web_search': {
      const patterns = [
        /(?:buscá|busca|buscar|search|find|investig[áa]|look\s*up)\s+(?:información\s+(?:sobre|de|about)\s+)?(.+?)(?:\s*(?:en\s+la\s+web|online|por\s+favor|porfa|pls|please))?$/i,
        /(?:qué|que|what)\s+(?:es|are|is|son|era|fue)\s+(.+?)[\?？]?\s*$/i,
        /(?:dónde|donde|where)\s+(?:est[áa]|qued[ae]|find|is|are)\s+(.+?)[\?？]?\s*$/i,
        /(?:cu[áa]ndo|when)\s+(?:es|se\s+celebra|naci[óo]|empez[óo]|termina)\s+(.+?)[\?？]?\s*$/i,
        /(?:qui[ée]n|who)\s+(?:es|fue|era|est[áa])\s+(.+?)[\?？]?\s*$/i,
        /(?:c[óo]mo|how)\s+(?:se\s+)?(?:hacer|hace|funciona|instalar|instala|configurar|configura|usar|usa|utilizar|utiliza|preparar|prepara|cocinar|cocina)\s+(.+?)[\?？]?\s*$/i,
        /(?:precio\s+(?:de|del)\s+|cu[áa]nto\s+(?:cuesta|vale|sale|est[áa])\s+)(.+?)[\?？]?\s*$/i,
        /(?:noticias|news|últimas|ultimas)\s+(?:de|sobre|acerca\s+de)\s+(.+?)[\?？]?\s*$/i,
        /(?:resultados|results|partido)\s+(?:de|del)\s+(.+?)[\?？]?\s*$/i,
      ];
      for (const p of patterns) {
        const m = input.match(p);
        if (m) { args.query = m[1].trim().replace(/[\?？]$/, ''); break; }
      }
      if (!args.query) {
        const searchWords = input.split(/\s+/);
        const sIdx = searchWords.findIndex(w => /^(buscar|busca|buscá|search|find|investigar|investigá|decime|dime|contame|cual|cuál)$/i.test(w));
        if (sIdx >= 0 && sIdx + 1 < searchWords.length) {
          args.query = searchWords.slice(sIdx + 1).join(' ').replace(/[\?？]$/, '');
        }
      }
      // Ultimate fallback: use entire input as query
      if (!args.query) {
        args.query = input.replace(/[\?？¡!]+/g, '').trim();
      }
      break;
    }
    case 'read_file': {
      const m = input.match(/(?:leer|lee|read|mostrar|show|ver|view|abrir|open|cat)\s+(?:el\s+)?(?:archivo\s+)?["']?([^\s"']+)["']?/i)
        || input.match(/(?:contenido\s+(?:de|del)\s+)["']?([^\s"']+)["']?/i);
      if (m) args.path = m[1];
      break;
    }
    case 'save_file': {
      const pathMatch = input.match(/(?:guardar|save|escribir|write|crear|create)\s+(?:en\s+)?["']?([^\s"']+)["']?/i);
      if (pathMatch) args.path = pathMatch[1];
      break;
    }
    case 'delete_file': {
      const m = input.match(/(?:eliminar|borrar|delete|remove|rm)\s+(?:el\s+)?(?:archivo\s+)?["']?([^\s"']+)["']?/i);
      if (m) args.path = m[1];
      break;
    }
    case 'download_file': {
      const m = input.match(/(?:descargar|download|bajar|fetch)\s+(?:(?:el\s+)?(?:archivo\s+)?(?:de\s+|from\s+)?)?["']?(https?:\/\/[^\s"']+)["']?/i);
      if (m) args.url = m[1];
      break;
    }
    case 'list_files': {
      const m = input.match(/(?:listar|lista|list|ls|dir|mostrar)\s+(?:los\s+)?(?:archivos\s+)?(?:de|en|in|of)\s+["']?([^\s"']+)["']?/i);
      if (m) args.path = m[1];
      else args.path = '.';
      break;
    }
    case 'code_analyze': {
      const m = input.match(/(?:analiz|revis|audit|review)\s+(?:(?:el\s+)?(?:código|code|archivo|file)\s+)?["']?([^\s"']+)["']?/i);
      if (m) args.path = m[1];
      break;
    }
    case 'code_generate': {
      args.description = input;
      break;
    }
    case 'code_debug': {
      args.description = input;
      break;
    }
    case 'nvidia_vision': {
      const m = input.match(/(?:https?:\/\/[^\s"']+\.(?:jpg|jpeg|png|gif|webp|bmp))/i);
      if (m) args.image_url = m[1];
      else if (input.includes('screenshot') || input.includes('captura')) args.action = 'screenshot';
      else args.description = input;
      break;
    }
    case 'nvidia_audio': {
      const m = input.match(/(?:https?:\/\/[^\s"']+\.(?:mp3|wav|ogg|flac|m4a))/i);
      if (m) args.audio_url = m[1];
      else args.description = input;
      break;
    }
    case 'social_media': {
      const platformMatch = input.match(/(instagram|twitter|x\.com|facebook|tiktok|linkedin|threads|youtube|pinterest)/i);
      if (platformMatch) args.platform = platformMatch[1].toLowerCase();
      args.description = input;
      break;
    }
    case 'project_scaffold': {
      args.description = input;
      break;
    }
    case 'task_plan': {
      args.description = input;
      break;
    }
    case 'memory_recall': {
      args.query = input.replace(/(?:recordá|recuerda|remember|qué\s+dije|what\s+did|historial|history|memoria|memory)[\s:]+/i, '').trim();
      break;
    }
    case 'math_calculate': {
      const m = input.match(/(?:calcular|calculate|comput[ae]r?)\s+(.+)/i)
        || input.match(/(?:cu[áa]nto\s+(?:es|da|suman|resulta)|what\s+is)\s+(.+?)[\?？]?\s*$/i);
      if (m) args.expression = m[1].trim().replace(/[\?？]$/, '');
      else args.expression = input;
      break;
    }
    case 'translate': {
      const langMatch = input.match(/(?:a|to|al|en)\s+(inglés|english|español|spanish|portugués|portuguese|francés|french|alemán|german|italiano|italian|chino|chinese|japonés|japanese|ruso|russian|árabe|arabic)/i);
      if (langMatch) args.target_lang = langMatch[1].toLowerCase();
      else args.target_lang = 'english';
      const textMatch = input.match(/(?:traduc[íi]r?|translate)\s+(?:(?:a|to|al)\s+\w+\s+)?:?\s*["']?(.+?)["']?\s*$/i);
      if (textMatch) args.text = textMatch[1];
      else args.text = input;
      break;
    }
    case 'git_manager': {
      args.description = input;
      break;
    }
    default: {
      args.input = input;
    }
  }

  return args;
}
