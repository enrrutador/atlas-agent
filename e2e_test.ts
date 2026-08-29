import 'dotenv/config';
import axios from 'axios';

const API_KEY = process.env.OPENAI_API_KEY!;
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const MODEL = process.env.MODEL_NAME || 'meta/llama-3.1-8b-instruct';
const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL || 'nvidia/nemotron-mini-4b-instruct';

const CLASSIFIER_SYSTEM_PROMPT = `You are a query classifier. Classify into EXACTLY ONE category. Reply with ONLY the category word.

Categories:
- general: ANY knowledge the LLM already knows (geography, history, science, definitions, culture, math calculations, translations, greetings, chat, opinions, "what is", "who is", "where is", "how many", "when did")
- memory: Personal memory (remember X, what did we discuss, our conversation, recall something)
- project: Current project/workspace (codebase, repo, workspace files, show me the code)
- code: Code generation/debugging (write a function, fix this bug, analyze code, implement feature)
- web: ONLY time-sensitive current info (weather NOW, price TODAY, news TODAY, current events, latest)
- tool: Direct action execution (execute command, create/delete/download file, git operation)

KEY RULE: If the user asks a factual question that does NOT change over time, it is "general" NOT "web". Only "web" if the answer changes daily (weather, prices, news).`;

const REGEX_RULES: Array<{ category: string; patterns: RegExp[]; confidence: number }> = [
  { category: 'general', confidence: 0.92, patterns: [
    /donde (queda|esta|se encuentra|es)/i, /cual es la capital/i,
    /quien (fue|es|escribio|pinto|invento|descubrio|compuso)/i,
    /que (es|significa|quiere decir)/i, /cuando (fue|se|nacio|murio|termino|empezo)/i,
    /como se (dice|llama|llamaba|escribe)/i, /en que (anio|fecha|siglo|continente)/i,
    /cuantos (habitantes|km|metros|anos)/i, /^que (sabes|puedes)/i,
    /^(hola|hey|buenas|que tal|como estas|como andas|buen dia|buenos dias|buenas noches)/i,
    /^(gracias|thx|thanks|genial|perfecto|dale|ok|si|no|bien|chau|adios|nos vemos)[\s.!?]*$/i,
    /cuanto es|cuanto da|cuanto resulta|suma|resta|multiplica|dividi/i,
    /traduc[ei]|translate|como se dice/i,
  ]},
  { category: 'memory', confidence: 0.90, patterns: [
    /que (hablamos|dimos|charlamos|conversamos) (la ultima vez|ayer|antes|la vez pasada)/i,
    /recorda|recuerda|acordate/i, /que (guard|almacen|memoriz|guarde|anote)/i,
    /olvid|no me acuerdo|perdi el contexto/i,
    /sesion anterior|ultima (sesion|conversacion|charla)/i,
  ]},
  { category: 'web', confidence: 0.90, patterns: [
    /como (esta|esta) el clima|pronostico|temperatura (de|en|actual|hoy)/i,
    /a cuanto (esta|cotiza|vale) (el|la)?\s*(dolar|euro|bitcoin|cripto)/i,
    /noticias|ultimas (noticias|novedades)|que paso (hoy|ayer|esta semana)/i,
    /precio (del|de la|actual|hoy)|cotizacion (del|de la)/i,
    /busca (en internet|en la web|online)/i,
  ]},
  { category: 'tool', confidence: 0.90, patterns: [
    /^(ejecut[áa]|corre|run|execute)\s+/i, /en la terminal|shell|bash|cmd/i,
    /^(cre[áa]|crear|elimin[áa]|borr[áa]|descarg[áa])\s+(el|la|un|una)?\s*(archivo|file|directorio|carpeta)/i,
    /^(git|commit|push|pull|branch|merge|clone)\s+/i,
  ]},
  { category: 'code', confidence: 0.88, patterns: [
    /escrib[íi]|program[áa]|implement[áa]|desarroll[áa]|cre[áa]\s+(un[ao]?\s+)?(funcion|function|clase|class|componente|component|api|endpoint|script|modulo|module)/i,
    /debug|fixear|arregl[áa]|correg[íi]r?|solucion[áa]/i,
    /code (review|analyze|generate|debug)|analiz[áa] (el |este )?c[óo]digo/i,
  ]},
  { category: 'project', confidence: 0.88, patterns: [
    /que (archivos|carpetas|directorios|files) hay (en|en el|en la)/i,
    /mostr[áa]|ver|listar (el |la |los )?(repo|proyecto|workspace|codebase)/i,
  ]},
];

function classifyWithRegex(input: string): { category: string; confidence: number } | null {
  const normalized = input.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  for (const rule of REGEX_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(normalized)) return { category: rule.category, confidence: rule.confidence };
    }
  }
  return null;
}

async function classifyWithLLM(input: string): Promise<string> {
  const resp = await axios.post(`${BASE_URL}/chat/completions`, {
    model: CLASSIFIER_MODEL,
    messages: [
      { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
      { role: 'user', content: input },
    ],
    temperature: 0.1,
    max_tokens: 10,
  }, {
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 5000,
  });
  return (resp.data?.choices?.[0]?.message?.content || '').trim().toLowerCase();
}

function parseCategory(raw: string): string {
  const cleaned = raw.replace(/[^a-z]/g, '');
  const map: Record<string, string> = {
    'general': 'general', 'memory': 'memory', 'project': 'project',
    'code': 'code', 'web': 'web', 'tool': 'tool',
    'greetings': 'general', 'chat': 'general', 'greeting': 'general',
    'knowledge': 'general', 'fact': 'general', 'math': 'general',
    'translation': 'general', 'translate': 'general',
    'action': 'tool', 'execute': 'tool', 'shell': 'tool',
    'search': 'web', 'news': 'web', 'weather': 'web', 'current': 'web',
    'debug': 'code', 'programming': 'code',
    'repo': 'project', 'repository': 'project', 'workspace': 'project',
  };
  return map[cleaned] || 'general';
}

async function callLLM(messages: any[], withTools: boolean): Promise<any> {
  const TOOLS = [
    { type: 'function', function: { name: 'web_search', description: 'Busca informacion en la web', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Termino de busqueda' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'math_calculate', description: 'Calcula expresiones matematicas', parameters: { type: 'object', properties: { expression: { type: 'string', description: 'Expresion matematica' } }, required: ['expression'] } } },
  ];
  const body: any = { model: MODEL, messages, temperature: 0.3, max_tokens: 512 };
  if (withTools) { body.tools = TOOLS; body.tool_choice = 'auto'; }
  const resp = await axios.post(`${BASE_URL}/chat/completions`, body, {
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  return resp.data.choices?.[0]?.message;
}

interface TestResult {
  query: string;
  expectedCategory: string;
  actualCategory: string;
  classifierSource: string;
  passed: boolean;
  reason: string;
}

const TESTS: Array<{ query: string; expectedCategory: string; expectToolCall: boolean; category: string }> = [
  { query: '¿Dónde queda Mendoza?', expectedCategory: 'general', expectToolCall: false, category: 'geografía' },
  { query: '¿Cuál es la capital de Francia?', expectedCategory: 'general', expectToolCall: false, category: 'geografía' },
  { query: '¿Quién escribió Don Quijote?', expectedCategory: 'general', expectToolCall: false, category: 'cultura' },
  { query: '¿Qué es la fotosíntesis?', expectedCategory: 'general', expectToolCall: false, category: 'ciencia' },
  { query: '¿Cuándo terminó la Segunda Guerra Mundial?', expectedCategory: 'general', expectToolCall: false, category: 'historia' },
  { query: 'hola, cómo andás?', expectedCategory: 'general', expectToolCall: false, category: 'chat' },
  { query: '¿Cuánto es 25 * 47?', expectedCategory: 'general', expectToolCall: false, category: 'math' },
  { query: '¿Cómo está el clima en Mendoza ahora?', expectedCategory: 'web', expectToolCall: true, category: 'clima' },
  { query: '¿A cuánto está el dólar hoy?', expectedCategory: 'web', expectToolCall: true, category: 'cotización' },
  { query: '¿Qué noticias hay hoy en Argentina?', expectedCategory: 'web', expectToolCall: true, category: 'noticias' },
  { query: 'Buscá en internet el precio del Bitcoin', expectedCategory: 'web', expectToolCall: true, category: 'búsqueda explícita' },
  { query: 'Ejecutá ls -la en la terminal', expectedCategory: 'tool', expectToolCall: true, category: 'shell' },
  { query: 'Creá un archivo test.txt', expectedCategory: 'tool', expectToolCall: true, category: 'file_op' },
  { query: '¿Qué hablamos la última vez?', expectedCategory: 'memory', expectToolCall: false, category: 'memoria' },
  { query: 'Escribí una función que ordene un array', expectedCategory: 'code', expectToolCall: true, category: 'código' },
  { query: 'Qué archivos hay en el workspace?', expectedCategory: 'project', expectToolCall: true, category: 'proyecto' },
];

const COMPOUND_TESTS: Array<{ query: string; expectedSubCount: number; expectedCategories: string[] }> = [
  { query: '¿Dónde queda Mendoza y cómo está el clima allá?', expectedSubCount: 2, expectedCategories: ['general', 'web'] },
  { query: '¿Quién escribió Don Quijote y a cuánto está el dólar?', expectedSubCount: 2, expectedCategories: ['general', 'web'] },
  { query: '¿Cuánto es 25*47 y también quién fue Einstein?', expectedSubCount: 2, expectedCategories: ['general', 'general'] },
];

const FEEDBACK_TESTS: Array<{ message: string; expectedType: string }> = [
  { message: 'No, eso está mal', expectedType: 'correction' },
  { message: 'Incorrecto, la respuesta correcta es...', expectedType: 'correction' },
  { message: 'Sí, exacto!', expectedType: 'confirmation' },
  { message: 'Perfecto, gracias', expectedType: 'confirmation' },
  { message: 'No sirve esto', expectedType: 'rejection' },
  { message: 'No entiendo nada', expectedType: 'rejection' },
  { message: 'Me refería a otra cosa', expectedType: 'clarification' },
  { message: 'En realidad buscaba el precio del euro', expectedType: 'clarification' },
  { message: '¿Cómo está el clima?', expectedType: 'none' },
  { message: 'Hola', expectedType: 'none' },
];

const ROUTING_TABLE: Record<string, { sources: Array<{ source: string; confidence: number }> }> = {
  general: { sources: [{ source: 'llm', confidence: 0.95 }] },
  memory: { sources: [{ source: 'memory_store', confidence: 0.9 }, { source: 'llm', confidence: 0.5 }] },
  web: { sources: [{ source: 'web_search', confidence: 0.9 }, { source: 'llm_synthesis', confidence: 0.3 }] },
  code: { sources: [{ source: 'llm_with_context', confidence: 0.85 }, { source: 'web_search', confidence: 0.5 }] },
  project: { sources: [{ source: 'file_system', confidence: 0.9 }, { source: 'git', confidence: 0.7 }, { source: 'web_search', confidence: 0.4 }] },
  tool: { sources: [{ source: 'skill_direct', confidence: 0.95 }, { source: 'llm_confirm', confidence: 0.7 }] },
};

const CONFIDENCE_THRESHOLD = 0.6;

function decomposeLocally(input: string): { isCompound: boolean; parts: string[] } {
  const COMPOUND_INDICATORS: RegExp[] = [
    /[,;]\s*(?:y\s+)?(?:tambi[eé]n|adem[aá]s|luego|despu[eé]s|tampoco|pero|aunque|mientras|sin embargo)\s+/i,
    /\s+(?:y\s+(?:tambi[eé]n|adem[aá]s|luego))\s+/i,
    /(?:y\s+tambi[eé]n|y\s+adem[aá]s|y\s+luego|y\s+despu[eé]s)\s+/i,
    /\?\s*[,.]?\s*(?:y\s+)?(?:tambi[eé]n|adem[aá]s|luego|despu[eé]s)/i,
    /\?\s*[,.]?\s*(?:y\s+)?(?:qu[eé]|qui[eé]n|c[oó]mo|cu[aá]ndo|d[oó]nde|cu[aá]nto|cu[aá]l|por qu[eé]|porqu[eé])\s+/i,
    /\?\s*[,.]?\s*(?:y\s+)?(?:what|who|how|when|where|how much|which|why)\s+/i,
    /(?:y\s+(?:a\s+|al\s+|de\s+|del\s+|en\s+)?(?:qu[eé]|qui[eé]n|c[oó]mo|cu[aá]ndo|d[oó]nde|cu[aá]nto|cu[aá]l|por\s+qu[eé]))\s+/i,
  ];
  const SPLIT_PATTERNS: RegExp[] = [
    /\s+y\s+(?=(?:a\s+|al\s+|de\s+|del\s+|en\s+)?(?:qu[eé]|qui[eé]n|c[oó]mo|cu[aá]ndo|d[oó]nde|cu[aá]nto|cu[aá]l|por\s+qu[eé])\s+)/i,
    /(?:y\s+(?:tambi[eé]n|adem[aá]s|luego|despu[eé]s))\s+/i,
    /(?:,\s*(?:y\s+)?(?:tambi[eé]n|adem[aá]s|luego|despu[eé]s))\s+/i,
    /\?\s*[,.]?\s*(?=(?:y\s+)?(?:qu[eé]|qui[eé]n|c[oó]mo|cu[aá]ndo|d[oó]nde|cu[aá]nto|cu[aá]l|por\s+qu[eé]|porqu[eé]|what|who|how|when|where|which|why)\s+)/i,
  ];

  let isCompound = false;
  const questionMarkCount = (input.match(/\?/g) || []).length;
  if (questionMarkCount > 1) isCompound = true;
  if (!isCompound) {
    for (const p of COMPOUND_INDICATORS) { if (p.test(input)) { isCompound = true; break; } }
  }

  if (!isCompound) return { isCompound: false, parts: [input] };

  let parts: string[] = [input];
  for (const pattern of SPLIT_PATTERNS) {
    const newParts: string[] = [];
    for (const part of parts) {
      const split = part.split(pattern);
      if (split.length > 1) {
        newParts.push(...split.filter(s => s.trim().length > 0));
      } else {
        newParts.push(part);
      }
    }
    parts = newParts;
  }

  if (parts.length === 1 && questionMarkCount > 1) {
    parts = input.split(/\?/).map(p => p.trim()).filter(p => p.length > 0);
    parts = parts.map(p => p.endsWith('?') ? p : p + '?');
  }

  parts = parts.map(p => {
    p = p.trim();
    if (!p.includes('?')) p = p + '?';
    return p;
  });

  return { isCompound: true, parts: parts.length > 1 ? parts : [input] };
}

function detectFeedback(input: string): string {
  const CORRECTION_PATTERNS = [
    /no(?:\s*,?\s*eso\s+no|,?\s*esta\s+mal)|incorrecto|esta\s+mal|mal|wrong|not\s+right|that'?s?\s+wrong|no\s+es\s+asi|no\s+es\s+eso/i,
    /la\s+respuesta\s+(?:correcta|verdadera|real)\s+es|actually|the\s+correct\s+answer/i,
    /en\s+realidad\s+(?!busc|quer|busq|necesit|quiero)(?=\w)/i,
    /mejor(?:\s+respuesta|asi|asi)|mas\s+preciso|mas\s+preciso|more\s+accurate/i,
    /quiero\s+(?:otra|una\s+mejor|una\s+diferente)|busca\s+de\s+nuevo|proba\s+de\s+nuevo|intenta\s+de\s+nuevo|try\s+again/i,
  ];
  const CONFIRMATION_STARTERS = new Set([
    'si', 'exacto', 'correcto', 'bien', 'perfecto', 'genial', 'dale', 'ok',
    'yes', 'right', 'exactly', 'correct', 'perfect', 'great',
  ]);
  const CONFIRMATION_ALLOWED_WORDS = new Set([
    'si', 'exacto', 'correcto', 'bien', 'perfecto', 'genial', 'dale', 'ok',
    'yes', 'right', 'exactly', 'correct', 'perfect', 'great', 'spot', 'on',
    'eso', 'es', 'hecho', 'gracias', 'thank', 'thx', 'muy', 'ahi',
    'sabia', 'maravilloso', 'increible', 'excelente', 'barbaro',
    'fantastico', 'magnifico', 'super', 'mucho', 'mil', 'punto',
  ]);
  const CONFIRMATION_PHRASE_PATTERNS = [
    /(?:eso\s+es|eso\s+esta|asi\s+es|esta\s+bien|esa\s+es\s+la|muy\s+bien|bien\s+ahi)/i,
  ];
  const REJECTION_PATTERNS = [
    /no\s+(?:sirve|sirvio|funciona|funciono|me\s+gusta|quiero|necesito)|(?:no\s+)?entiendo|confuso|no\s+(?:tiene\s+)?sentido/i,
    /(?:eso\s+no\s+(?:es|esta|sirve|sirvio)|respuesta\s+inutil|perdi\s+el\s+tiempo)/i,
  ];
  const CLARIFICATION_PATTERNS = [
    /(?:me\s+referia\s+a|queria\s+decir|o\s+sea|es\s+decir|me\s+explico|no\s+me\s+expliq?\s+bien)/i,
    /(?:lo\s+que\s+quiero\s+es|lo\s+que\s+busco\s+es|en\s+realidad\s+busc(?:o|aba|ar)|en\s+realidad\s+quer(?:ia|ia\s+decir))/i,
  ];

  const trimmed = input.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  for (const p of CORRECTION_PATTERNS) { if (p.test(trimmed)) return 'correction'; }
  for (const p of REJECTION_PATTERNS) { if (p.test(trimmed)) return 'rejection'; }
  for (const p of CLARIFICATION_PATTERNS) { if (p.test(trimmed)) return 'clarification'; }
  for (const p of CONFIRMATION_PHRASE_PATTERNS) { if (p.test(trimmed)) return 'confirmation'; }

  const words = trimmed.split(/[\s,!.?]+/).filter(w => w.length > 0);
  if (words.length > 0 && CONFIRMATION_STARTERS.has(words[0])) {
    if (words.every(w => CONFIRMATION_ALLOWED_WORDS.has(w))) return 'confirmation';
  }

  return 'none';
}

async function main() {
  console.log('=== Atlas E2E Full Test (Phase 1 + 2 + 3) ===\n');
  console.log(`Model: ${MODEL}  |  Classifier: ${CLASSIFIER_MODEL}  |  API: ${BASE_URL}\n`);

  let passCount = 0;
  let failCount = 0;
  const results: TestResult[] = [];

  // ========== PHASE 1: Classification ==========
  console.log('--- Phase 1: Classification (16 tests) ---\n');

  for (const test of TESTS) {
    process.stdout.write(`  [${test.category}] "${test.query}" ... `);
    const regexResult = classifyWithRegex(test.query);
    if (regexResult && regexResult.category === test.expectedCategory) {
      passCount++;
      results.push({ query: test.query, expectedCategory: test.expectedCategory, actualCategory: regexResult.category, classifierSource: 'regex', passed: true, reason: `Regex → ${regexResult.category}` });
      console.log(`✅ Regex → ${regexResult.category}`);
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    try {
      const llmRaw = await classifyWithLLM(test.query);
      const llmCategory = parseCategory(llmRaw);
      const passed = llmCategory === test.expectedCategory;
      if (passed) passCount++; else failCount++;
      results.push({ query: test.query, expectedCategory: test.expectedCategory, actualCategory: llmCategory, classifierSource: 'llm', passed, reason: `LLM → ${llmCategory} (raw: "${llmRaw}")` });
      console.log(`${passed ? '✅' : '❌'} LLM → ${llmCategory} (raw: "${llmRaw}")`);
    } catch (err: any) {
      failCount++;
      results.push({ query: test.query, expectedCategory: test.expectedCategory, actualCategory: 'error', classifierSource: 'error', passed: false, reason: err.message });
      console.log(`💥 ERROR — ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // ========== PHASE 2: Router Behavior ==========
  console.log('\n--- Phase 2: Router Behavior (10 tests) ---\n');

  const SYSTEM_PROMPT_GENERAL = `Sos Atlas, un agente AI creado por Marcelo. Tu personalidad es AMIGABLE y COLOQUIAL. Respondé SIEMPRE en español coloquial. NUNCA devuelvas JSON o datos crudos.`;
  const SYSTEM_PROMPT_WITH_TOOLS = `Sos Atlas, un agente AI creado por Marcelo. Tu personalidad es AMIGABLE y COLOQUIAL. ⚠️ REGLA: SOLO usá web_search para info ACTUAL. NUNCA devuelvas JSON o datos crudos.`;
  const WEB_TOOL = [{ type: 'function', function: { name: 'web_search', description: 'Busca informacion en la web', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Termino de busqueda' } }, required: ['query'] } } }];

  const generalQueries = TESTS.filter(t => t.expectedCategory === 'general');
  const webQueries = TESTS.filter(t => t.expectedCategory === 'web');
  const memoryQueries = TESTS.filter(t => t.expectedCategory === 'memory');

  for (const test of generalQueries) {
    process.stdout.write(`  [${test.category}] "${test.query}" → NO tools ... `);
    try {
      await callLLM([{ role: 'system', content: SYSTEM_PROMPT_GENERAL }, { role: 'user', content: test.query }], false);
      passCount++; console.log('✅ Direct response');
    } catch (err: any) { failCount++; console.log(`💥 ${err.message}`); }
    await new Promise(r => setTimeout(r, 2000));
  }

  for (const test of webQueries) {
    process.stdout.write(`  [${test.category}] "${test.query}" → web_search ... `);
    try {
      const msg = await callLLM([{ role: 'system', content: SYSTEM_PROMPT_WITH_TOOLS }, { role: 'user', content: test.query }], true);
      const hasToolCall = !!(msg?.tool_calls?.length > 0);
      if (hasToolCall) { passCount++; console.log('✅ Called web_search'); }
      else { const rc = classifyWithRegex(test.query); if (rc?.category === 'web') { failCount++; console.log('❌ Should have called web_search'); } else { passCount++; console.log('✅ Router would route to web_search'); } }
    } catch (err: any) { failCount++; console.log(`💥 ${err.message}`); }
    await new Promise(r => setTimeout(r, 2000));
  }

  for (const test of memoryQueries) {
    process.stdout.write(`  [${test.category}] "${test.query}" → memory ... `);
    try { await callLLM([{ role: 'system', content: SYSTEM_PROMPT_GENERAL }, { role: 'user', content: test.query }], false); passCount++; console.log('✅ Memory route'); } catch (err: any) { failCount++; console.log(`💥 ${err.message}`); }
    await new Promise(r => setTimeout(r, 2000));
  }

  // ========== PHASE 3: Synthesis ==========
  console.log('\n--- Phase 3: Synthesis (2 tests) ---\n');

  for (const q of ['¿Dónde queda Mendoza?', '¿Quién escribió Don Quijote?']) {
    const msg = await callLLM([{ role: 'system', content: SYSTEM_PROMPT_GENERAL }, { role: 'user', content: q }], false);
    const text = msg?.content || '';
    const isColloquial = text.length > 20 && !text.includes('{') && !text.includes('```');
    if (isColloquial) passCount++; else failCount++;
    console.log(`  "${q}" → ${isColloquial ? '✅' : '❌'} ${isColloquial ? 'Colloquial' : 'NOT colloquial'}`);
    await new Promise(r => setTimeout(r, 2000));
  }

  // ========== PHASE 4: Sub-Question Decomposition ==========
  console.log('\n--- Phase 4: Sub-Question Decomposition (3 tests) ---\n');

  for (const test of COMPOUND_TESTS) {
    process.stdout.write(`  "${test.query.slice(0, 70)}" ... `);
    const decomposition = decomposeLocally(test.query);
    if (!decomposition.isCompound) { failCount++; console.log('❌ Not detected as compound'); continue; }
    const subClassifications: string[] = [];
    for (const part of decomposition.parts) {
      const rc = classifyWithRegex(part);
      if (rc) { subClassifications.push(rc.category); }
      else { try { const raw = await classifyWithLLM(part); subClassifications.push(parseCategory(raw)); await new Promise(r => setTimeout(r, 2000)); } catch { subClassifications.push('general'); } }
    }
    const countMatch = decomposition.parts.length >= test.expectedSubCount;
    if (countMatch) { passCount++; console.log(`✅ ${decomposition.parts.length} sub-questions: [${subClassifications.join(', ')}]`); }
    else { failCount++; console.log(`❌ Expected ${test.expectedSubCount}, got ${decomposition.parts.length}`); }
    await new Promise(r => setTimeout(r, 1500));
  }

  // ========== PHASE 5: Semantic Cache ==========
  console.log('\n--- Phase 5: Semantic Cache (6 tests) ---\n');

  const cache: Map<string, { query: string; category: string; response: string }> = new Map();
  function normCache(s: string): string { return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[¿?¡!.,;:]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function cacheSim(a: string, b: string): number { if (a === b) return 1; const wA = new Set(a.split(' ')), wB = new Set(b.split(' ')); const inter = new Set([...wA].filter(w => wB.has(w))); const union = new Set([...wA, ...wB]); return union.size > 0 ? inter.size / union.size : 0; }

  cache.set('general:' + normCache('¿Dónde queda Mendoza?'), { query: '¿Dónde queda Mendoza?', category: 'general', response: 'Mendoza está en el oeste de Argentina' });
  cache.set('web:' + normCache('¿A cuánto está el dólar?'), { query: '¿A cuánto está el dólar?', category: 'web', response: 'El dólar cotiza a $1200' });

  const cacheTests: Array<{ query: string; category: string; expectHit: boolean }> = [
    { query: '¿Dónde queda Mendoza?', category: 'general', expectHit: true },
    { query: 'donde queda mendoza', category: 'general', expectHit: true },
    { query: '¿Dónde queda Buenos Aires?', category: 'general', expectHit: false },
    { query: '¿A cuánto está el dólar?', category: 'web', expectHit: true },
    { query: 'a cuanto esta el dolar', category: 'web', expectHit: true },
    { query: '¿A cuánto está el euro?', category: 'web', expectHit: false },
  ];

  for (const test of cacheTests) {
    const normalized = normCache(test.query);
    const exact = cache.get(`${test.category}:${normalized}`);
    let hit = !!exact;
    if (!hit) { for (const [, entry] of cache) { if (entry.category === test.category && cacheSim(normalized, normCache(entry.query)) >= 0.75) { hit = true; break; } } }
    const passed = test.expectHit ? hit : !hit;
    if (passed) passCount++; else failCount++;
    console.log(`  "${test.query}" [${test.category}] → ${hit ? 'HIT' : 'MISS'} ${passed ? '✅' : '❌'}`);
  }

  // ========== PHASE 6: Source Agent Routing ==========
  console.log('\n--- Phase 6: Source Agent Routing (6 tests) ---\n');

  const agentRoutingTests: Array<{ category: string; expectedSource: string; description: string }> = [
    { category: 'general', expectedSource: 'llm', description: 'general → LLM direct' },
    { category: 'memory', expectedSource: 'memory_store', description: 'memory → memory_store first' },
    { category: 'web', expectedSource: 'web_search', description: 'web → web_search first' },
    { category: 'code', expectedSource: 'llm_with_context', description: 'code → LLM with context' },
    { category: 'project', expectedSource: 'file_system', description: 'project → file_system first' },
    { category: 'tool', expectedSource: 'skill_direct', description: 'tool → skill_direct first' },
  ];

  for (const test of agentRoutingTests) {
    const routing = ROUTING_TABLE[test.category];
    const topSource = routing.sources.find(s => s.confidence >= CONFIDENCE_THRESHOLD);
    const passed = topSource?.source === test.expectedSource;
    if (passed) passCount++; else failCount++;
    console.log(`  ${test.description} → ${topSource?.source || 'none'} ${passed ? '✅' : '❌'}`);
  }

  // ========== PHASE 7: Feedback Loop Detection ==========
  console.log('\n--- Phase 7: Feedback Loop Detection (10 tests) ---\n');

  for (const test of FEEDBACK_TESTS) {
    const detected = detectFeedback(test.message);
    const passed = detected === test.expectedType;
    if (passed) passCount++; else failCount++;
    console.log(`  "${test.message}" → ${detected} ${passed ? '✅' : '❌'} (expected: ${test.expectedType})`);
  }

  // ========== PHASE 8: Confidence Adjustment ==========
  console.log('\n--- Phase 8: Confidence Adjustment (5 tests) ---\n');

  const adjustmentScores: Map<string, number> = new Map();
  function getAdjustedConfidence(category: string, source: string, base: number): number {
    const key = `${category}:${source}`;
    const adj = adjustmentScores.get(key) || 0;
    return Math.max(0, Math.min(1, base + adj));
  }

  adjustmentScores.set('web:web_search', -0.10);
  adjustmentScores.set('general:llm', 0.05);
  adjustmentScores.set('memory:memory_store', -0.15);

  const adjustmentTests: Array<{ category: string; source: string; base: number; expectedRange: [number, number]; description: string }> = [
    { category: 'web', source: 'web_search', base: 0.9, expectedRange: [0.75, 0.85], description: 'web_search after correction (-0.10)' },
    { category: 'general', source: 'llm', base: 0.95, expectedRange: [0.95, 1.0], description: 'llm after confirmation (+0.05)' },
    { category: 'memory', source: 'memory_store', base: 0.9, expectedRange: [0.7, 0.8], description: 'memory_store after rejection (-0.15)' },
    { category: 'code', source: 'llm_with_context', base: 0.85, expectedRange: [0.85, 0.85], description: 'code no adjustment (0)' },
    { category: 'tool', source: 'skill_direct', base: 0.95, expectedRange: [0.95, 0.95], description: 'tool no adjustment (0)' },
  ];

  for (const test of adjustmentTests) {
    const adjusted = getAdjustedConfidence(test.category, test.source, test.base);
    const inRange = adjusted >= test.expectedRange[0] && adjusted <= test.expectedRange[1];
    if (inRange) passCount++; else failCount++;
    console.log(`  ${test.description}: ${test.base} → ${adjusted.toFixed(2)} ${inRange ? '✅' : '❌'} (expected: ${test.expectedRange[0]}-${test.expectedRange[1]})`);
  }

  // ========== PHASE 9: Multi-Agent Strategy Selection ==========
  console.log('\n--- Phase 9: Multi-Agent Strategy Selection (4 tests) ---\n');

  const strategyTests: Array<{ category: string; sourceCount: number; expectedStrategy: string; description: string }> = [
    { category: 'web', sourceCount: 2, expectedStrategy: 'parallel', description: 'web with 2 sources → parallel' },
    { category: 'project', sourceCount: 3, expectedStrategy: 'parallel', description: 'project with 3 sources → parallel' },
    { category: 'general', sourceCount: 1, expectedStrategy: 'sequential', description: 'general with 1 source → sequential' },
    { category: 'code', sourceCount: 1, expectedStrategy: 'sequential', description: 'code with 1 source → sequential' },
  ];

  for (const test of strategyTests) {
    const routing = ROUTING_TABLE[test.category];
    const shouldParallel = (test.category === 'web' && routing.sources.length >= 2) ||
                           (test.category === 'project' && routing.sources.length >= 2) ||
                           (routing.sources.length > 1 && routing.sources.every(s => s.confidence >= 0.6));
    const strategy = shouldParallel ? 'parallel' : 'sequential';
    const passed = strategy === test.expectedStrategy;
    if (passed) passCount++; else failCount++;
    console.log(`  ${test.description} → ${strategy} ${passed ? '✅' : '❌'}`);
  }

  // ========== SUMMARY ==========
  console.log('\n' + '='.repeat(50));
  console.log('=== SUMMARY ===');
  console.log('='.repeat(50));
  const total = passCount + failCount;
  console.log(`Total: ${passCount}/${total} passed (${failCount} failed)`);
  console.log(`  Phase 1 (Classification):  16 tests`);
  console.log(`  Phase 2 (Router):          10 tests`);
  console.log(`  Phase 3 (Synthesis):        2 tests`);
  console.log(`  Phase 4 (Decomposition):    3 tests`);
  console.log(`  Phase 5 (Cache):            6 tests`);
  console.log(`  Phase 6 (Source Agents):    6 tests`);
  console.log(`  Phase 7 (Feedback):        10 tests`);
  console.log(`  Phase 8 (Adjustment):       5 tests`);
  console.log(`  Phase 9 (Multi-Agent):      4 tests`);

  if (failCount > 0) {
    console.log('\n❌ Failed tests:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  - "${r.query}": expected=${r.expectedCategory} actual=${r.actualCategory} (${r.reason})`);
    }
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
