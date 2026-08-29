/**
 * Atlas NVIDIA Vision Tool - Image analysis via NVIDIA VLM API
 * Uses meta/llama-3.2-90b-vision-instruct or similar
 */

import axios from 'axios';
import { logger } from '../../common/logger.js';

export class VisionTool {
  private static instance: VisionTool;
  private apiKey: string = '';
  private baseUrl: string = 'https://integrate.api.nvidia.com/v1';
  private model: string = 'meta/llama-3.2-90b-vision-instruct';

  private constructor() {
    this.apiKey = process.env.NVIDIA_VISION_API_KEY || process.env.OPENAI_API_KEY || '';
    this.baseUrl = process.env.NVIDIA_VISION_BASE_URL || process.env.OPENAI_BASE_URL || this.baseUrl;
    this.model = process.env.VISION_MODEL || this.model;
  }

  static getInstance(): VisionTool {
    if (!VisionTool.instance) {
      VisionTool.instance = new VisionTool();
    }
    return VisionTool.instance;
  }

  async analyzeImage(imageUrl: string, prompt: string = 'Describe esta imagen en detalle.'): Promise<string> {
    if (!this.apiKey) {
      return 'Vision API no configurada. Set NVIDIA_VISION_API_KEY en .env';
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
        {
          model: this.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
          max_tokens: 512,
          temperature: 0.5,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        }
      );

      const result = response.data.choices?.[0]?.message?.content || 'No se pudo analizar la imagen';
      logger.info('vision', `Analyzed image: ${imageUrl.slice(0, 80)}`);
      return result;
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.message;
      logger.error('vision', `Analysis failed: ${msg}`);
      return `Error analizando imagen: ${msg}`;
    }
  }

  async ocrFromImage(imageUrl: string): Promise<string> {
    return this.analyzeImage(imageUrl, 'Extraé todo el texto visible en esta imagen (OCR). Respondé solo con el texto extraído.');
  }

  async describeImage(imageUrl: string): Promise<string> {
    return this.analyzeImage(imageUrl, 'Describí esta imagen en español con detalle.');
  }
}

export const visionTool = VisionTool.getInstance();
