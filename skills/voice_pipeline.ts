import type { Skill } from '../src/core/skills.js';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { spawn } from 'child_process';
// @ts-ignore
import ffmpegStatic from 'ffmpeg-static';

/**
 * VOICE PIPELINE SKILL
 * ─────────────────────────────────────────────────────────────────────────────
 * Pipeline completo de voz bidireccional usando Google AI Studio (free tier).
 *
 * Flujo:
 *   Audio (URL/path) → STT (Gemini) → LLM (Gemini Flash) → TTS (Gemini TTS) → Audio MP3
 *
 * Hardware target: 3 GB RAM, sin GPU
 * Costo: $0 — todo en Google AI Studio free tier
 *
 * Límites free tier (Google AI Studio, mayo 2025):
 *   - gemini-2.0-flash: 1500 req/día, 1M tokens/min
 *   - gemini-2.5-flash-preview-tts: 100 req/día
 *   - Audio input: máx 9.5 horas/archivo, máx 20 MB inline
 *
 * Optimizaciones de memoria:
 *   - Audio normalizado a 16kHz mono antes de enviar (reduce tamaño ~75%)
 *   - Respuestas limitadas a 200 chars / 50 tokens
 *   - Archivos temporales eliminados inmediatamente
 *   - Sin buffers en memoria — todo pasa por disco
 *
 * Args:
 *   action: 'pipeline' | 'stt' | 'tts' | 'chat'
 *   audioUrl?: string       — URL de Telegram o ruta local
 *   audioPath?: string      — ruta local directa
 *   text?: string           — texto para TTS o chat
 *   voice?: string          — voz TTS (default: 'Aoede')
 *   maxChars?: number       — límite de respuesta (default: 200)
 */

// ── Configuración ─────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY || '';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const AUDIO_DIR = path.join(process.cwd(), 'data', 'audio');

// Límites de costo/calidad
const MAX_CHARS = 200;          // máx caracteres en respuesta TTS
const MAX_TOKENS = 50;          // máx tokens LLM
const MAX_AUDIO_DURATION_S = 30; // máx duración audio entrada (segundos)
const MAX_AUDIO_SIZE_MB = 10;   // máx tamaño audio entrada (MB)

// Voces disponibles en Gemini TTS (free tier)
const AVAILABLE_VOICES = ['Aoede', 'Charon', 'Fenrir', 'Kore', 'Puck', 'Schedar'];

// System prompt optimizado para respuestas cortas de voz
const VOICE_SYSTEM_PROMPT = `Sos Atlas, asistente de voz de Marcelo.
REGLAS CRÍTICAS:
- Máximo 2 oraciones. Máximo 25 palabras.
- Respuestas directas, sin saludos ni despedidas.
- Sin emojis, sin markdown, solo texto plano.
- Si no sabés algo, decilo en una oración.`;

// ── Utilidades ────────────────────────────────────────────────────────────────

function ensureAudioDir(): void {
  if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
  }
}

function checkApiKey(): void {
  if (!GEMINI_API_KEY) {
    throw new Error(
      'GOOGLE_AI_STUDIO_KEY no configurada en .env. ' +
      'Obtené tu key gratis en: https://aistudio.google.com/apikey'
    );
  }
}

/**
 * Normaliza audio a 16kHz mono WAV usando ffmpeg.
 * Reduce tamaño ~75% y mejora compatibilidad con Gemini.
 * Retorna path del archivo normalizado.
 */
async function normalizeAudio(inputPath: string): Promise<string> {
  const outputPath = path.join(AUDIO_DIR, `norm_${Date.now()}.wav`);
  const ffmpegPath = ffmpegStatic as string;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout en normalización de audio (30s)'));
    }, 30_000);

    const proc = spawn(ffmpegPath, [
      '-i', inputPath,
      '-ar', '16000',      // 16kHz — suficiente para voz, reduce tamaño
      '-ac', '1',          // mono — reduce tamaño 50%
      '-c:a', 'pcm_s16le', // PCM 16-bit — compatible con Gemini
      '-t', String(MAX_AUDIO_DURATION_S), // limitar duración
      '-y',                // sobreescribir sin preguntar
      outputPath,
    ], { windowsHide: true });

    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(outputPath);
      } else {
        reject(new Error(`ffmpeg falló (code ${code}): ${stderr.slice(-200)}`));
      }
    });

    proc.on('error', (e) => {
      clearTimeout(timeout);
      reject(new Error(`ffmpeg error: ${e.message}`));
    });
  });
}

/**
 * Descarga audio desde URL (Telegram, HTTP) a archivo temporal.
 */
async function downloadAudio(url: string): Promise<string> {
  const ext = url.includes('.ogg') ? 'ogg' : url.includes('.mp3') ? 'mp3' : 'ogg';
  const outputPath = path.join(AUDIO_DIR, `dl_${Date.now()}.${ext}`);

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30_000,
    maxContentLength: MAX_AUDIO_SIZE_MB * 1024 * 1024,
  });

  fs.writeFileSync(outputPath, Buffer.from(response.data));
  return outputPath;
}

/**
 * Trunca texto para no superar límites de TTS y costo.
 * Corta en el último punto/coma antes del límite.
 */
function truncateForVoice(text: string, maxChars = MAX_CHARS): string {
  if (text.length <= maxChars) return text;

  // Intentar cortar en oración completa
  const truncated = text.slice(0, maxChars);
  const lastPeriod = Math.max(
    truncated.lastIndexOf('.'),
    truncated.lastIndexOf('!'),
    truncated.lastIndexOf('?'),
  );

  if (lastPeriod > maxChars * 0.5) {
    return truncated.slice(0, lastPeriod + 1);
  }

  // Cortar en última coma o espacio
  const lastComma = truncated.lastIndexOf(',');
  if (lastComma > maxChars * 0.6) return truncated.slice(0, lastComma);

  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
}

/**
 * Estima duración de audio en segundos (aprox 150 palabras/minuto).
 */
function estimateAudioDuration(text: string): number {
  const words = text.split(/\s+/).length;
  return Math.ceil((words / 150) * 60);
}

// ── STT: Audio → Texto ────────────────────────────────────────────────────────

async function speechToText(audioPath: string): Promise<string> {
  checkApiKey();

  // Verificar tamaño
  const stats = fs.statSync(audioPath);
  if (stats.size > MAX_AUDIO_SIZE_MB * 1024 * 1024) {
    throw new Error(`Audio demasiado grande: ${(stats.size / 1024 / 1024).toFixed(1)}MB (máx ${MAX_AUDIO_SIZE_MB}MB)`);
  }

  // Normalizar audio
  let normalizedPath: string | null = null;
  try {
    normalizedPath = await normalizeAudio(audioPath);
    const audioData = fs.readFileSync(normalizedPath);
    const base64Audio = audioData.toString('base64');

    const response = await axios.post(
      `${GEMINI_BASE}/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [
            {
              inline_data: {
                mime_type: 'audio/wav',
                data: base64Audio,
              },
            },
            {
              text: 'Transcribí exactamente lo que dice este audio en español. Solo el texto, sin explicaciones.',
            },
          ],
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 200,
        },
      },
      { timeout: 30_000 }
    );

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) throw new Error('Gemini no devolvió transcripción');
    return text.trim();

  } finally {
    // Limpiar archivos temporales inmediatamente
    if (normalizedPath && fs.existsSync(normalizedPath)) {
      try { fs.unlinkSync(normalizedPath); } catch {}
    }
  }
}

// ── LLM: Texto → Texto ────────────────────────────────────────────────────────

async function chatWithLLM(userText: string): Promise<string> {
  checkApiKey();

  const response = await axios.post(
    `${GEMINI_BASE}/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      system_instruction: {
        parts: [{ text: VOICE_SYSTEM_PROMPT }],
      },
      contents: [{
        role: 'user',
        parts: [{ text: userText }],
      }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: MAX_TOKENS,
        stopSequences: ['\n\n'],
      },
    },
    { timeout: 20_000 }
  );

  const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('Gemini no devolvió respuesta de chat');

  return truncateForVoice(text.trim());
}

// ── TTS: Texto → Audio ────────────────────────────────────────────────────────

/**
 * Retry helper for rate-limited API calls.
 * Gemini free tier can return 429 even on first request if quota resets mid-minute.
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const is429 = e.response?.status === 429 || e.message?.includes('429');
      const isLast = attempt === maxRetries;
      if (is429 && !isLast) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.warn(`[VOICE] Rate limit (429), reintentando en ${delay}ms... (intento ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw new Error('Max retries exceeded');
}

async function textToSpeech(text: string, voice = 'Aoede'): Promise<string> {
  checkApiKey();
  ensureAudioDir();

  const selectedVoice = AVAILABLE_VOICES.includes(voice) ? voice : 'Aoede';
  const safeText = truncateForVoice(text);
  const estimatedDuration = estimateAudioDuration(safeText);

  console.log(`[VOICE TTS] "${safeText.slice(0, 50)}..." | ~${estimatedDuration}s | voz: ${selectedVoice}`);

  // Try gemini-2.5-flash-preview-tts first (best quality), fall back to gemini-2.0-flash
  const TTS_MODELS = [
    'gemini-2.5-flash-preview-tts',
    'gemini-2.0-flash-exp',
    'gemini-2.0-flash',
  ];

  let lastError: Error | null = null;

  for (const model of TTS_MODELS) {
    try {
      const response = await withRetry(() => axios.post(
        `${GEMINI_BASE}/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          contents: [{
            parts: [{ text: safeText }],
          }],
          generationConfig: {
            response_modalities: ['AUDIO'],
            speech_config: {
              voice_config: {
                prebuilt_voice_config: {
                  voice_name: selectedVoice,
                },
              },
            },
          },
        },
        { timeout: 30_000 }
      ));

      const audioPart = response.data?.candidates?.[0]?.content?.parts?.[0];
      if (!audioPart?.inline_data?.data) {
        throw new Error(`${model}: no devolvió audio`);
      }

      const audioBuffer = Buffer.from(audioPart.inline_data.data, 'base64');
      const mimeType: string = audioPart.inline_data.mime_type || 'audio/wav';
      const ext = mimeType.includes('mp3') ? 'mp3' : 'wav';
      const outputPath = path.join(AUDIO_DIR, `tts_${Date.now()}.${ext}`);
      fs.writeFileSync(outputPath, audioBuffer);

      console.log(`[VOICE TTS] ✅ Generado con ${model}`);
      return outputPath;

    } catch (e: any) {
      const status = e.response?.status;
      // 404 = model not available, 429 = rate limit exhausted after retries
      // Try next model for both
      if (status === 404 || status === 429 || e.message?.includes('not found')) {
        console.warn(`[VOICE TTS] ${model} no disponible (${status}), probando siguiente...`);
        lastError = e;
        continue;
      }
      throw e; // Other errors: propagate immediately
    }
  }

  throw lastError || new Error('Todos los modelos TTS fallaron');
}

// ── Pipeline completo ─────────────────────────────────────────────────────────

async function runFullPipeline(
  audioSource: string,
  isUrl: boolean,
  voice = 'Aoede'
): Promise<{ text: string; response: string; audioPath: string; durationEstimate: number }> {

  let downloadedPath: string | null = null;

  try {
    // 1. Obtener archivo de audio
    let audioPath: string;
    if (isUrl) {
      console.log('[VOICE] Descargando audio...');
      downloadedPath = await downloadAudio(audioSource);
      audioPath = downloadedPath;
    } else {
      audioPath = audioSource;
    }

    // 2. STT
    console.log('[VOICE] Transcribiendo...');
    const transcription = await speechToText(audioPath);
    console.log(`[VOICE] Transcripción: "${transcription.slice(0, 80)}"`);

    // 3. LLM
    console.log('[VOICE] Generando respuesta...');
    const llmResponse = await chatWithLLM(transcription);
    console.log(`[VOICE] Respuesta: "${llmResponse}"`);

    // 4. TTS
    console.log('[VOICE] Sintetizando voz...');
    const audioOutputPath = await textToSpeech(llmResponse, voice);

    return {
      text: transcription,
      response: llmResponse,
      audioPath: audioOutputPath,
      durationEstimate: estimateAudioDuration(llmResponse),
    };

  } finally {
    // Limpiar descarga temporal
    if (downloadedPath && fs.existsSync(downloadedPath)) {
      try { fs.unlinkSync(downloadedPath); } catch {}
    }
  }
}

// ── Skill export ──────────────────────────────────────────────────────────────

const voicePipelineSkill: Skill = {
  name: 'voice_pipeline',
  description: `Pipeline de voz bidireccional usando Google AI Studio (gratis).
Acciones:
- 'pipeline': audio → STT → LLM → TTS → audio. Args: { audioUrl o audioPath, voice? }
- 'stt': audio → texto. Args: { audioUrl o audioPath }
- 'tts': texto → audio. Args: { text, voice? }
- 'chat': texto → texto (respuesta corta para voz). Args: { text }
Voces disponibles: Aoede, Charon, Fenrir, Kore, Puck, Schedar
Requiere: GOOGLE_AI_STUDIO_KEY en .env (gratis en aistudio.google.com)`,

  execute: async (args: {
    action: 'pipeline' | 'stt' | 'tts' | 'chat';
    audioUrl?: string;
    audioPath?: string;
    text?: string;
    voice?: string;
    maxChars?: number;
  }) => {
    const { action, audioUrl, audioPath, text, voice = 'Aoede' } = args;

    try {
      switch (action) {

        case 'pipeline': {
          const source = audioUrl || audioPath;
          if (!source) {
            return { success: false, error: 'Se requiere audioUrl o audioPath' };
          }
          const result = await runFullPipeline(source, !!audioUrl, voice);
          return {
            success: true,
            transcription: result.text,
            response: result.response,
            audioPath: result.audioPath,
            estimatedDurationSeconds: result.durationEstimate,
            message: `✅ Pipeline completo\n📝 Escuché: "${result.text.slice(0, 100)}"\n🗣️ Respondí: "${result.response}"\n🔊 Audio: ${result.audioPath}`,
          };
        }

        case 'stt': {
          const source = audioUrl || audioPath;
          if (!source) {
            return { success: false, error: 'Se requiere audioUrl o audioPath' };
          }

          let downloadedPath: string | null = null;
          try {
            let localPath: string;
            if (audioUrl) {
              downloadedPath = await downloadAudio(audioUrl);
              localPath = downloadedPath;
            } else {
              localPath = audioPath!;
            }
            const transcription = await speechToText(localPath);
            return { success: true, transcription, message: `📝 "${transcription}"` };
          } finally {
            if (downloadedPath && fs.existsSync(downloadedPath)) {
              try { fs.unlinkSync(downloadedPath); } catch {}
            }
          }
        }

        case 'tts': {
          if (!text) return { success: false, error: 'Se requiere text' };
          const safeText = truncateForVoice(text, args.maxChars || MAX_CHARS);
          const audioOutputPath = await textToSpeech(safeText, voice);
          return {
            success: true,
            audioPath: audioOutputPath,
            textUsed: safeText,
            estimatedDurationSeconds: estimateAudioDuration(safeText),
            message: `🔊 Audio generado: ${audioOutputPath}`,
          };
        }

        case 'chat': {
          if (!text) return { success: false, error: 'Se requiere text' };
          const response = await chatWithLLM(text);
          return {
            success: true,
            response,
            charCount: response.length,
            estimatedDurationSeconds: estimateAudioDuration(response),
            message: `💬 "${response}"`,
          };
        }

        default:
          return {
            success: false,
            error: `Acción desconocida: ${action}. Usar: pipeline | stt | tts | chat`,
          };
      }

    } catch (e: any) {
      // Errores específicos con mensajes útiles
      if (e.response?.status === 400) {
        return { success: false, error: `Error de API Gemini: ${e.response.data?.error?.message || 'Bad Request'}` };
      }
      if (e.response?.status === 429) {
        return { success: false, error: 'Límite de rate de Google AI Studio alcanzado. Esperá 1 minuto.' };
      }
      if (e.response?.status === 403) {
        return { success: false, error: 'API key inválida o sin permisos. Verificá GOOGLE_AI_STUDIO_KEY en .env' };
      }
      if (e.message?.includes('GOOGLE_AI_STUDIO_KEY')) {
        return { success: false, error: e.message };
      }
      return { success: false, error: `Error en voice_pipeline: ${e.message}` };
    }
  },
};

export default voicePipelineSkill;
