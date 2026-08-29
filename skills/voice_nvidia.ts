import type { Skill } from '../src/core/skills.js';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { spawn } from 'child_process';
// @ts-ignore
import ffmpegStatic from 'ffmpeg-static';

const API_KEY = process.env.VLM_API_KEY || process.env.VISION_NVIDIA_KEY || process.env.OPENAI_API_KEY || '';
const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1';
const AUDIO_DIR = path.join(process.cwd(), 'data', 'audio');
const MAX_AUDIO_DURATION_S = 30;
const MAX_AUDIO_SIZE_MB = 10;

const ASR_MODELS = [
  'nvidia/parakeet-ctc-1.1b-asr',
  'nvidia/stt_en_citrinet_512',
];

function ensureAudioDir(): void {
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

function checkApiKey(): void {
  if (!API_KEY) throw new Error('No hay NVIDIA API key configurada. Seteá VLM_API_KEY o VISION_NVIDIA_KEY en .env');
}

async function normalizeAudio(inputPath: string): Promise<string> {
  const outputPath = path.join(AUDIO_DIR, `nvidia_norm_${Date.now()}.wav`);
  const ffmpegPath = ffmpegStatic as string;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('ffmpeg timeout (30s)')), 30_000);
    const proc = spawn(ffmpegPath, [
      '-i', inputPath,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      '-t', String(MAX_AUDIO_DURATION_S),
      '-y', outputPath,
    ], { windowsHide: true });

    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg error (${code}): ${stderr.slice(-200)}`));
    });
    proc.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function downloadAudio(url: string): Promise<string> {
  const ext = url.includes('.ogg') ? 'ogg' : url.includes('.mp3') ? 'mp3' : 'ogg';
  const outputPath = path.join(AUDIO_DIR, `nvidia_dl_${Date.now()}.${ext}`);
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30_000,
    maxContentLength: MAX_AUDIO_SIZE_MB * 1024 * 1024,
  });
  fs.writeFileSync(outputPath, Buffer.from(response.data));
  return outputPath;
}

async function speechToTextParakeet(audioPath: string): Promise<string> {
  checkApiKey();

  let normalizedPath: string | null = null;
  try {
    normalizedPath = await normalizeAudio(audioPath);
    const audioData = fs.readFileSync(normalizedPath);
    const base64Audio = audioData.toString('base64');

    for (const model of ASR_MODELS) {
      try {
        const response = await axios.post(
          `${NVIDIA_BASE}/chat/completions`,
          {
            model,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'input_audio',
                    input_audio: {
                      data: base64Audio,
                      format: 'wav',
                    },
                  },
                  {
                    type: 'text',
                    text: 'Transcribí exactamente lo que dice este audio en español. Solo el texto transcrito.',
                  },
                ],
              },
            ],
            max_tokens: 300,
            temperature: 0.1,
          },
          {
            headers: {
              Authorization: `Bearer ${API_KEY}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            timeout: 60_000,
          }
        );

        const text = response.data?.choices?.[0]?.message?.content || '';
        if (text) {
          const cleaned = text.replace(/\[.*?\]/g, '').trim();
          return cleaned || text.trim();
        }
      } catch (e: any) {
        const status = e.response?.status;
        if (status === 404) {
          console.warn(`[VOICE NVIDIA] ${model} not available, trying next...`);
          continue;
        }
        throw e;
      }
    }

    throw new Error('Ningún modelo ASR de NVIDIA disponible');
  } catch (e: any) {
    if (e.response?.status === 401 || e.response?.status === 403) {
      throw new Error('API key NVIDIA inválida o sin permisos');
    }
    if (e.response?.data?.error?.message) {
      throw new Error(`NVIDIA ASR: ${e.response.data.error.message}`);
    }
    throw e;
  } finally {
    if (normalizedPath && fs.existsSync(normalizedPath)) {
      try { fs.unlinkSync(normalizedPath); } catch {}
    }
  }
}

const voiceNvidiaSkill: Skill = {
  name: 'voice_nvidia',
  description: `STT usando NVIDIA API. No requiere Google AI Studio.
Acciones:
- 'stt': audio → texto. Args: { audioUrl o audioPath }
- 'check': verifica si hay API key configurada
Requiere: VLM_API_KEY o VISION_NVIDIA_KEY en .env
Nota: Depende de disponibilidad de modelos ASR en NVIDIA API.`,

  execute: async (args: {
    action: 'stt' | 'check';
    audioUrl?: string;
    audioPath?: string;
  }) => {
    ensureAudioDir();
    const { action, audioUrl, audioPath } = args;

    try {
      switch (action) {
        case 'check': {
          return {
            success: true,
            apiKeyConfigured: !!API_KEY,
            keyPrefix: API_KEY ? API_KEY.substring(0, 8) + '...' : 'none',
            message: API_KEY
              ? 'NVIDIA STT disponible (sujeto a modelos ASR)'
              : 'No hay API key NVIDIA configurada',
          };
        }

        case 'stt': {
          const source = audioUrl || audioPath;
          if (!source) return { success: false, error: 'Se requiere audioUrl o audioPath' };

          let dlPath: string | null = null;
          try {
            let localPath: string;
            if (audioUrl) {
              dlPath = await downloadAudio(audioUrl);
              localPath = dlPath;
            } else {
              localPath = audioPath!;
            }

            const transcription = await speechToTextParakeet(localPath);
            return {
              success: true,
              transcription,
              message: `📝 "${transcription}"`,
            };
          } finally {
            if (dlPath && fs.existsSync(dlPath)) {
              try { fs.unlinkSync(dlPath); } catch {}
            }
          }
        }

        default:
          return { success: false, error: `Acción desconocida: ${action}. Usar: stt | check` };
      }
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },
};

export default voiceNvidiaSkill;
