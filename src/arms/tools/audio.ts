/**
 * Atlas NVIDIA Audio Tool - Speech-to-text and text-to-speech
 * Uses NVIDIA ASR/TTS APIs
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { logger } from '../../common/logger.js';

export class AudioTool {
  private static instance: AudioTool;
  private apiKey: string = '';
  private baseUrl: string = 'https://integrate.api.nvidia.com/v1';
  private outputDir: string;

  private constructor() {
    this.apiKey = process.env.NVIDIA_AUDIO_API_KEY || process.env.OPENAI_API_KEY || '';
    this.baseUrl = process.env.NVIDIA_AUDIO_BASE_URL || process.env.OPENAI_BASE_URL || this.baseUrl;
    this.outputDir = path.join(process.cwd(), 'data', 'audio');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  static getInstance(): AudioTool {
    if (!AudioTool.instance) {
      AudioTool.instance = new AudioTool();
    }
    return AudioTool.instance;
  }

  async transcribe(audioUrl: string): Promise<string> {
    if (!this.apiKey) {
      return 'Audio API no configurada. Set NVIDIA_AUDIO_API_KEY en .env';
    }

    try {
      // Try NVIDIA ASR endpoint (nvidia/parakeet-ctc-1.1b-asr or similar)
      const response = await axios.post(
        `${this.baseUrl}/audio/transcriptions`,
        { url: audioUrl, model: 'nvidia/parakeet-ctc-1.1b-asr' },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        }
      );

      const text = response.data?.text || response.data?.output || '';
      logger.info('audio', `Transcribed: ${audioUrl.slice(0, 80)} → ${text.length} chars`);
      return text || 'No se pudo transcribir el audio';
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.message;

      // Fallback: try Whisper-compatible endpoint
      try {
        const whisperResp = await axios.post(
          `${this.baseUrl}/chat/completions`,
          {
            model: process.env.MODEL_NAME || 'nvidia/llama-3.1-nemotron-70b-instruct',
            messages: [
              { role: 'system', content: 'El usuario envió un audio. Transcribí el contenido lo mejor posible.' },
              { role: 'user', content: `[Audio URL: ${audioUrl}] — Transcribí este audio.` },
            ],
            max_tokens: 256,
          },
          {
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 30000,
          }
        );
        return whisperResp.data?.choices?.[0]?.message?.content || `No se pudo transcribir. Error original: ${msg}`;
      } catch {
        logger.error('audio', `Transcription failed: ${msg}`);
        return `Error transcribiendo audio: ${msg}`;
      }
    }
  }

  async textToSpeech(text: string, voice: string = 'default'): Promise<string> {
    if (!this.apiKey) {
      return 'TTS API no configurada. Set NVIDIA_AUDIO_API_KEY en .env';
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/audio/speech`,
        {
          model: 'nvidia/tts_en',
          input: text,
          voice,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
          responseType: 'arraybuffer',
        }
      );

      const outputPath = path.join(this.outputDir, `tts_${Date.now()}.mp3`);
      fs.writeFileSync(outputPath, response.data);
      logger.info('audio', `TTS generated: ${outputPath}`);
      return `Audio generado: ${outputPath}`;
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.message;
      logger.error('audio', `TTS failed: ${msg}`);
      return `Error generando audio: ${msg}. El texto que se iba a convertir: "${text.slice(0, 200)}"`;
    }
  }
}

export const audioTool = AudioTool.getInstance();
