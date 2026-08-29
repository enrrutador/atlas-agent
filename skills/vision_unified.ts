import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

type VisionProvider = 'nvidia' | 'gemini' | 'auto';

interface VisionUnifiedArgs {
  source: string;
  prompt?: string;
  provider?: VisionProvider;
  saveOutput?: string;
}

function getMimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  };
  return map[ext] || 'image/png';
}

function isUrl(source: string): boolean {
  return source.startsWith('http://') || source.startsWith('https://');
}

function isBase64(source: string): boolean {
  return source.startsWith('data:image/');
}

async function imageToBase64(source: string): Promise<{ data: string; mimeType: string }> {
  if (isBase64(source)) {
    const match = source.match(/^data:(image\/\w+);base64,(.+)$/);
    if (match) {
      return { mimeType: match[1]!, data: match[2]! };
    }
  }

  if (isUrl(source)) {
    try {
      const res = await axios.get(source, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: {
          'User-Agent': 'AtlasAgent/1.0',
        },
      });
      const contentType: string = res.headers['content-type'] || 'image/jpeg';
      const b64 = Buffer.from(res.data as ArrayBuffer).toString('base64');
      return { mimeType: contentType, data: b64 };
    } catch (e: any) {
      throw new Error(`No se pudo descargar la imagen de la URL: ${e.message}`);
    }
  }

  if (fs.existsSync(source)) {
    const stats = fs.statSync(source);
    if (stats.size > 20 * 1024 * 1024) {
      throw new Error(`Imagen muy grande: ${(stats.size / 1024 / 1024).toFixed(1)}MB. Max 20MB.`);
    }
    const buffer = fs.readFileSync(source);
    const mimeType = getMimeFromPath(source);
    return { mimeType, data: buffer.toString('base64') };
  }

  throw new Error(`No se encontró el archivo: ${source}`);
}

async function analyzeWithNvidia(
  base64Data: string,
  mimeType: string,
  prompt: string
): Promise<{ text: string; model: string }> {
  const apiKey = process.env.VISION_NVIDIA_KEY || process.env.VLM_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('VISION_NVIDIA_KEY, VLM_API_KEY u OPENAI_API_KEY no configurada en .env');

  const isNvidiaKey = !!(process.env.VISION_NVIDIA_KEY || process.env.VLM_API_KEY) || apiKey.startsWith('nvapi-');
  const model = isNvidiaKey
  ? (process.env.VLM_MODEL || 'meta/llama-3.2-11b-vision-instruct')
  : 'gpt-4o-mini';
  const endpoint = isNvidiaKey
  ? (process.env.VLM_ENDPOINT || 'https://integrate.api.nvidia.com/v1')
  : 'https://api.openai.com/v1';

  const response = await axios.post(
    `${endpoint}/chat/completions`,
    {
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } },
            { type: 'text', text: prompt },
          ],
        },
      ],
      max_tokens: 1024,
      temperature: 0.2,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 90000,
    }
  );

  const text = response.data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error(`VLM (${isNvidiaKey ? 'NVIDIA' : 'OpenAI'}) devolvió respuesta vacía`);
  return { text, model };
}

async function analyzeWithGemini(
  base64Data: string,
  mimeType: string,
  prompt: string
): Promise<{ text: string; model: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY no configurada en .env');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const response = await axios.post(
    url,
    {
      contents: [
        {
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: base64Data } },
          ],
        },
      ],
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
    }
  );

  const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('Gemini devolvió respuesta vacía');
  return { text, model: 'gemini-2.0-flash' };
}

const skill = {
  name: 'vision_unified',
  description:
    'Analiza imágenes con IA vision. Acepta rutas locales, URLs o base64. Usa NVIDIA VLM (Llama 3.2 Vision) o Gemini 2.0 Flash. Args: {"source":"ruta/url/base64","prompt":"qué analizar","provider":"nvidia|gemini|auto"}',

  parameters: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Ruta local, URL, o data:image/...;base64,... de la imagen',
      },
      prompt: {
        type: 'string',
        default:
          'Analiza esta imagen en detalle. Describí todo lo que ves: elementos UI, texto, colores, layout, contenido. Si hay texto, transcribilo exactamente.',
        description: 'Prompt para guiar el análisis',
      },
      provider: {
        type: 'string',
        default: 'auto',
        description: 'nvidia, gemini, o auto (prueba nvidia primero, luego gemini)',
      },
      saveOutput: {
        type: 'string',
        description: 'Ruta donde guardar el resultado (opcional)',
      },
    },
    required: ['source'],
  },

  execute: async ({
    source,
    prompt,
    provider = 'auto',
    saveOutput,
  }: VisionUnifiedArgs) => {
    const finalPrompt =
      prompt ||
      'Analiza esta imagen en detalle. Describí todo lo que ves: elementos UI, texto, colores, layout, contenido. Si hay texto, transcribilo exactamente.';

    try {
      console.log(`[VISION_UNIFIED] Procesando: ${source.substring(0, 100)}...`);
      const { data: b64Data, mimeType } = await imageToBase64(source);
      console.log(`[VISION_UNIFIED] Imagen lista: ${mimeType}, ${b64Data.length} chars base64`);

      let result: { text: string; model: string } | null = null;
      let usedProvider = provider;

      if (provider === 'nvidia' || provider === 'auto') {
        try {
          console.log('[VISION_UNIFIED] Intentando NVIDIA VLM...');
          result = await analyzeWithNvidia(b64Data, mimeType, finalPrompt);
          usedProvider = 'nvidia';
          console.log(`[VISION_UNIFIED] NVIDIA OK (${result.model})`);
        } catch (e: any) {
          console.log(`[VISION_UNIFIED] NVIDIA falló: ${e.message}`);
          if (provider === 'nvidia') {
            return { success: false, error: `NVIDIA VLM error: ${e.message}`, provider: 'nvidia' };
          }
        }
      }

      if (!result && (provider === 'gemini' || provider === 'auto')) {
        try {
          console.log('[VISION_UNIFIED] Intentando Gemini...');
          result = await analyzeWithGemini(b64Data, mimeType, finalPrompt);
          usedProvider = 'gemini';
          console.log(`[VISION_UNIFIED] Gemini OK (${result.model})`);
        } catch (e: any) {
          console.log(`[VISION_UNIFIED] Gemini falló: ${e.message}`);
          if (provider === 'gemini' || !result) {
            return { success: false, error: `Gemini error: ${e.message}`, provider: 'gemini' };
          }
        }
      }

      if (!result) {
        return { success: false, error: 'Todos los providers fallaron' };
      }

      if (saveOutput) {
        const dir = path.dirname(saveOutput);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(saveOutput, result.text, 'utf8');
        console.log(`[VISION_UNIFIED] Resultado guardado: ${saveOutput}`);
      }

      return {
        success: true,
        analysis: result.text,
        provider: usedProvider,
        model: result.model,
        source: source.substring(0, 200),
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },
};

export default skill;
