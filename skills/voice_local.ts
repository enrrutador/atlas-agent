import type { Skill } from '../src/core/skills.js';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { spawn, execSync } from 'child_process';
// @ts-ignore
import ffmpegStatic from 'ffmpeg-static';

/**
 * VOICE LOCAL SKILL — STT + TTS completamente offline
 * ─────────────────────────────────────────────────────────────────────────────
 * STT: Whisper.cpp (nodejs-whisper) — modelo tiny, ~75MB, ~200MB RAM
 * TTS: Piper — voz española, ~60MB, ~150MB RAM
 *
 * Sin internet. Sin API keys. Sin rate limits.
 * Hardware target: 3 GB RAM, 5 GB disco, sin GPU
 *
 * Instalación automática en primer uso:
 *   - nodejs-whisper descarga el modelo tiny automáticamente
 *   - Piper requiere instalación manual (ver instrucciones abajo)
 *
 * Instrucciones para Piper (hacer UNA VEZ):
 *   1. Descargar piper desde: https://github.com/rhasspy/piper/releases
 *      → piper_windows_amd64.zip (~15MB)
 *   2. Extraer en: C:\Users\Marcelo\Desktop\Atlas-agent\tools\piper\
 *   3. Descargar voz española:
 *      https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/davefx/medium/es_ES-davefx-medium.onnx
 *      https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/davefx/medium/es_ES-davefx-medium.onnx.json
 *      → Guardar en: C:\Users\Marcelo\Desktop\Atlas-agent\tools\piper\voices\
 */

const AUDIO_DIR = path.join(process.cwd(), 'data', 'audio');
const TOOLS_DIR = path.join(process.cwd(), 'tools');
const PIPER_DIR = path.join(TOOLS_DIR, 'piper');
const PIPER_EXE = path.join(PIPER_DIR, 'piper.exe');
const PIPER_VOICE = path.join(PIPER_DIR, 'voices', 'es_ES-davefx-medium.onnx');
const MAX_AUDIO_DURATION_S = 30;

function ensureDirs(): void {
  [AUDIO_DIR, TOOLS_DIR, PIPER_DIR, path.join(PIPER_DIR, 'voices')].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

// ── Audio normalization ───────────────────────────────────────────────────────

async function normalizeToWav16k(inputPath: string): Promise<string> {
  const outputPath = path.join(AUDIO_DIR, `norm_${Date.now()}.wav`);
  const ffmpegPath = ffmpegStatic as string;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ffmpeg timeout')), 30_000);

    const proc = spawn(ffmpegPath, [
      '-i', inputPath,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      '-t', String(MAX_AUDIO_DURATION_S),
      '-y',
      outputPath,
    ], { windowsHide: true });

    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg error (${code}): ${stderr.slice(-200)}`));
    });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function downloadAudio(url: string): Promise<string> {
  const outputPath = path.join(AUDIO_DIR, `dl_${Date.now()}.ogg`);
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30_000 });
  fs.writeFileSync(outputPath, Buffer.from(res.data));
  return outputPath;
}

// ── STT: Whisper.cpp via nodejs-whisper ──────────────────────────────────────

async function sttWhisper(audioPath: string): Promise<string> {
  // Lazy import — only load when needed
  let nodewhisper: any;
  try {
    const mod = await import('nodejs-whisper');
    nodewhisper = mod.nodewhisper || mod.default;
  } catch {
    throw new Error(
      'nodejs-whisper no instalado. Ejecutá: npm install nodejs-whisper --save'
    );
  }

  // Normalize to 16kHz WAV (Whisper requirement)
  const wavPath = await normalizeToWav16k(audioPath);

  try {
    console.log('[VOICE STT] Transcribiendo con Whisper tiny...');
    const result = await nodewhisper(wavPath, {
      modelName: 'tiny',
      autoDownloadModelName: 'tiny', // auto-descarga si no existe
      removeWavFileAfterTranscription: false,
      withCuda: false, // sin GPU
      whisperOptions: {
        outputInText: true,
        outputInVtt: false,
        outputInSrt: false,
        outputInCsv: false,
        translateToEnglish: false,
        language: 'es',
        wordTimestamps: false,
        timestamps_length: 60,
        splitOnWord: true,
      },
    });

    // nodejs-whisper returns text directly or as object
    const text = typeof result === 'string'
      ? result
      : result?.text || result?.[0]?.text || JSON.stringify(result);

    return text.trim().replace(/\[.*?\]/g, '').trim(); // remove [BLANK_AUDIO] etc
  } finally {
    try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch {}
  }
}

// ── TTS: Piper ────────────────────────────────────────────────────────────────

function isPiperInstalled(): boolean {
  return fs.existsSync(PIPER_EXE) && fs.existsSync(PIPER_VOICE);
}

function getPiperInstallInstructions(): string {
  return `Piper no está instalado. Para instalarlo:

1. Descargar piper_windows_amd64.zip desde:
   https://github.com/rhasspy/piper/releases/latest

2. Extraer en: ${PIPER_DIR}
   (debe quedar: ${PIPER_EXE})

3. Descargar voz española (2 archivos):
   https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/davefx/medium/es_ES-davefx-medium.onnx
   https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/davefx/medium/es_ES-davefx-medium.onnx.json

4. Guardar ambos en: ${path.join(PIPER_DIR, 'voices')}`;
}

async function ttsPiper(text: string): Promise<string> {
  if (!isPiperInstalled()) {
    throw new Error(getPiperInstallInstructions());
  }

  const outputPath = path.join(AUDIO_DIR, `tts_${Date.now()}.wav`);
  const safeText = text.slice(0, 300).replace(/["\n]/g, ' ');

  console.log(`[VOICE TTS] Piper: "${safeText.slice(0, 60)}..."`);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Piper timeout (15s)'));
    }, 15_000);

    // Piper reads from stdin, writes to file
    const proc = spawn(PIPER_EXE, [
      '--model', PIPER_VOICE,
      '--output_file', outputPath,
    ], { windowsHide: true });

    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outputPath)) {
        console.log(`[VOICE TTS] ✅ Piper generó audio: ${outputPath}`);
        resolve(outputPath);
      } else {
        reject(new Error(`Piper error (${code}): ${stderr.slice(-200)}`));
      }
    });

    proc.on('error', (e) => { clearTimeout(timer); reject(e); });

    // Send text to stdin
    proc.stdin?.write(safeText);
    proc.stdin?.end();
  });
}

// ── Skill export ──────────────────────────────────────────────────────────────

const voiceLocalSkill: Skill = {
  name: 'voice_local',
  description: `STT y TTS completamente LOCAL y OFFLINE. Sin internet, sin API keys, sin rate limits.
STT: Whisper tiny (nodejs-whisper) — transcribe audio en español.
TTS: Piper — genera audio en voz española natural.
Acciones:
- 'stt': audio → texto. Args: { audioUrl o audioPath }
- 'tts': texto → audio WAV. Args: { text }
- 'pipeline': audio → STT → texto (sin LLM). Args: { audioUrl o audioPath }
- 'check': verifica si Whisper y Piper están instalados
Hardware: ~350MB RAM, ~150MB disco. Sin GPU.`,

  execute: async (args: {
    action: 'stt' | 'tts' | 'pipeline' | 'check';
    audioUrl?: string;
    audioPath?: string;
    text?: string;
  }) => {
    ensureDirs();
    const { action, audioUrl, audioPath, text } = args;

    try {
      switch (action) {

        case 'check': {
          const piperOk = isPiperInstalled();
          let whisperOk = false;
          try {
            await import('nodejs-whisper');
            whisperOk = true;
          } catch {}

          const modelPath = path.join(
            process.cwd(), 'node_modules', 'nodejs-whisper', 'models', 'ggml-tiny.bin'
          );
          const modelExists = fs.existsSync(modelPath);

          return {
            success: true,
            whisper: {
              installed: whisperOk,
              modelDownloaded: modelExists,
              modelPath,
            },
            piper: {
              installed: piperOk,
              exePath: PIPER_EXE,
              voicePath: PIPER_VOICE,
            },
            message: `Whisper: ${whisperOk ? '✅' : '❌'} | Modelo: ${modelExists ? '✅' : '⬇️ se descarga en primer uso'} | Piper: ${piperOk ? '✅' : '❌ requiere instalación manual'}`,
            piperInstructions: piperOk ? null : getPiperInstallInstructions(),
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

            const transcription = await sttWhisper(localPath);
            return {
              success: true,
              transcription,
              message: `📝 "${transcription}"`,
            };
          } finally {
            if (dlPath && fs.existsSync(dlPath)) try { fs.unlinkSync(dlPath); } catch {}
          }
        }

        case 'tts': {
          if (!text) return { success: false, error: 'Se requiere text' };
          const audioOutputPath = await ttsPiper(text);
          return {
            success: true,
            audioPath: audioOutputPath,
            message: `🔊 Audio generado: ${audioOutputPath}`,
          };
        }

        case 'pipeline': {
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

            const transcription = await sttWhisper(localPath);
            return {
              success: true,
              transcription,
              message: `📝 Transcripción: "${transcription}"`,
            };
          } finally {
            if (dlPath && fs.existsSync(dlPath)) try { fs.unlinkSync(dlPath); } catch {}
          }
        }

        default:
          return { success: false, error: `Acción desconocida: ${action}` };
      }

    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },
};

export default voiceLocalSkill;
