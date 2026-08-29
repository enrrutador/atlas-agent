import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import axios from 'axios';

interface VisionScreenshotArgs {
  prompt?: string;
  provider?: 'nvidia' | 'gemini' | 'auto';
  saveScreenshot?: boolean;
}

let robot: any = null;

async function getRobot(): Promise<any> {
  if (robot) return robot;
  try {
    const mod = await import('@jitsi/robotjs');
    robot = mod.default || mod;
    return robot;
  } catch {
    throw new Error('@jitsi/robotjs no disponible. npm install @jitsi/robotjs');
  }
}

function captureScreenToPng(r: any, outputPath: string, scale = 0.5): void {
  const img = r.captureScreen();
  const fullW: number = img.width;
  const fullH: number = img.height;
  const raw = Buffer.from(img.image);

  const w = Math.round(fullW * scale);
  const h = Math.round(fullH * scale);

  const rawRows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(w * 3 + 1);
    row[0] = 0;
    const srcY = Math.min(Math.round(y / scale), fullH - 1);
    for (let x = 0; x < w; x++) {
      const srcX = Math.min(Math.round(x / scale), fullW - 1);
      const i = (srcY * fullW + srcX) * 4;
      row[x * 3 + 1] = raw[i + 2];
      row[x * 3 + 2] = raw[i + 1];
      row[x * 3 + 3] = raw[i];
    }
    rawRows.push(row);
  }

  const rawData = Buffer.concat(rawRows);
  const deflated = zlib.deflateSync(rawData, { level: 9 });

  function crc32(buf: Buffer): number {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    let crc = -1;
    for (let i = 0; i < buf.length; i++) crc = t[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  }

  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const tb = Buffer.from(type);
    const c = crc32(Buffer.concat([tb, data]));
    const cb = Buffer.alloc(4);
    cb.writeUInt32BE(c);
    return Buffer.concat([len, tb, data, cb]);
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const out = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflated), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(outputPath, out);
}

async function analyzeWithNvidia(
  base64Data: string,
  mimeType: string,
  prompt: string
): Promise<{ text: string; model: string }> {
  const apiKey = process.env.VISION_NVIDIA_KEY || process.env.VLM_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('VISION_NVIDIA_KEY, VLM_API_KEY u OPENAI_API_KEY no configurada');

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
  if (!text) throw new Error(`VLM (${isNvidiaKey ? 'NVIDIA' : 'OpenAI'}) respuesta vacía`);
  return { text, model };
}

async function analyzeWithGemini(
  base64Data: string,
  mimeType: string,
  prompt: string
): Promise<{ text: string; model: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY no configurada');

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
  if (!text) throw new Error('Gemini respuesta vacía');
  return { text, model: 'gemini-2.0-flash' };
}

const skill = {
  name: 'vision_screenshot',
  description:
    'Captura la pantalla del PC y la analiza con IA vision. Atlas puede VER qué hay en pantalla. Args: {"prompt":"qué buscar/analizar","provider":"nvidia|gemini|auto"}',

  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        default:
          'Analiza esta captura de pantalla en detalle. Listá todas las ventanas abiertas, elementos UI visibles, texto en pantalla, iconos, y el estado general del escritorio.',
        description: 'Qué analizar en la pantalla',
      },
      provider: {
        type: 'string',
        default: 'auto',
        description: 'nvidia, gemini, o auto',
      },
      saveScreenshot: {
        type: 'boolean',
        default: false,
        description: 'Guardar el screenshot en data/screenshots/',
      },
    },
    required: [],
  },

  execute: async ({
    prompt,
    provider = 'auto',
    saveScreenshot = false,
  }: VisionScreenshotArgs) => {
    const finalPrompt =
      prompt ||
      'Analiza esta captura de pantalla en detalle. Listá todas las ventanas abiertas, elementos UI visibles, texto en pantalla, iconos, y el estado general del escritorio.';

    try {
      const r = await getRobot();
      const screenshotDir = path.join(process.cwd(), 'data', 'screenshots');
      if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

      const screenshotPath = path.join(screenshotDir, `atlas_vision_${Date.now()}.png`);

      console.log('[VISION_SCREENSHOT] Capturando pantalla con robotjs...');
      captureScreenToPng(r, screenshotPath);

      if (!fs.existsSync(screenshotPath)) {
        return { success: false, error: 'No se pudo capturar la pantalla' };
      }

      const sizeKB = (fs.statSync(screenshotPath).size / 1024).toFixed(1);
      console.log(`[VISION_SCREENSHOT] Screenshot OK (${sizeKB} KB), analizando...`);

      const buffer = fs.readFileSync(screenshotPath);
      const b64Data = buffer.toString('base64');
      const mimeType = 'image/png';

      let result: { text: string; model: string } | null = null;
      let usedProvider = provider;

      if (provider === 'nvidia' || provider === 'auto') {
        try {
          console.log('[VISION_SCREENSHOT] Analizando con NVIDIA VLM...');
          result = await analyzeWithNvidia(b64Data, mimeType, finalPrompt);
          usedProvider = 'nvidia';
        } catch (e: any) {
          console.log(`[VISION_SCREENSHOT] NVIDIA falló: ${e.message}`);
          if (provider === 'nvidia') {
            if (!saveScreenshot && fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
            return { success: false, error: `NVIDIA: ${e.message}` };
          }
        }
      }

      if (!result && (provider === 'gemini' || provider === 'auto')) {
        try {
          console.log('[VISION_SCREENSHOT] Analizando con Gemini...');
          result = await analyzeWithGemini(b64Data, mimeType, finalPrompt);
          usedProvider = 'gemini';
        } catch (e: any) {
          console.log(`[VISION_SCREENSHOT] Gemini falló: ${e.message}`);
          if (!saveScreenshot && fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
          return { success: false, error: `Gemini: ${e.message}` };
        }
      }

      if (!saveScreenshot && fs.existsSync(screenshotPath)) {
        fs.unlinkSync(screenshotPath);
      }

      if (!result) {
        return { success: false, error: 'Todos los providers fallaron' };
      }

      console.log(`[VISION_SCREENSHOT] Análisis completado (${usedProvider})`);

      return {
        success: true,
        analysis: result.text,
        provider: usedProvider,
        model: result.model,
        screenshotPath: saveScreenshot ? screenshotPath : undefined,
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },
};

export default skill;
