/**
 * Atlas Social Media Tool - Post to multiple platforms via Zenrio or direct APIs
 */

import axios from 'axios';
import { logger } from '../../common/logger.js';

export class SocialMediaTool {
  private static instance: SocialMediaTool;
  private zenrioApiKey: string = '';
  private zenrioBaseUrl: string = 'https://api.zenrio.io/v1';

  private constructor() {
    this.zenrioApiKey = process.env.ZENRIO_API_KEY || '';
    this.zenrioBaseUrl = process.env.ZENRIO_BASE_URL || this.zenrioBaseUrl;
  }

  static getInstance(): SocialMediaTool {
    if (!SocialMediaTool.instance) {
      SocialMediaTool.instance = new SocialMediaTool();
    }
    return SocialMediaTool.instance;
  }

  async post(args: { platform: string; content: string; image_url?: string; schedule_time?: string }): Promise<string> {
    if (!this.zenrioApiKey) {
      return 'Zenrio API no configurada. Set ZENRIO_API_KEY en .env para manejar redes sociales.';
    }

    try {
      const response = await axios.post(
        `${this.zenrioBaseUrl}/post`,
        {
          platform: args.platform,
          content: args.content,
          image_url: args.image_url,
          schedule_time: args.schedule_time,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.zenrioApiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      const result = response.data;
      logger.info('social_media', `Posted to ${args.platform}: ${result.id || 'ok'}`);
      return `Post publicado en ${args.platform}: ${result.message || result.id || 'OK'}`;
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      logger.error('social_media', `Post failed: ${msg}`);
      return `Error publicando en ${args.platform}: ${msg}`;
    }
  }

  async getAnalytics(args: { platform: string; post_id?: string; metric?: string }): Promise<string> {
    if (!this.zenrioApiKey) {
      return 'Zenrio API no configurada. Set ZENRIO_API_KEY en .env.';
    }

    try {
      const params: any = { platform: args.platform };
      if (args.post_id) params.post_id = args.post_id;
      if (args.metric) params.metric = args.metric;

      const response = await axios.get(`${this.zenrioBaseUrl}/analytics`, {
        params,
        headers: { 'Authorization': `Bearer ${this.zenrioApiKey}` },
        timeout: 15000,
      });

      const data = response.data;
      logger.info('social_media', `Analytics for ${args.platform}: ${JSON.stringify(data).slice(0, 200)}`);
      return `Analytics de ${args.platform}: ${JSON.stringify(data, null, 2)}`;
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.message;
      return `Error obteniendo analytics: ${msg}`;
    }
  }

  async schedule(args: { platform: string; content: string; schedule_time: string; image_url?: string }): Promise<string> {
    return this.post({ ...args, schedule_time: args.schedule_time });
  }

  async getTrending(args: { platform: string; limit?: number }): Promise<string> {
    if (!this.zenrioApiKey) {
      return 'Zenrio API no configurada. Set ZENRIO_API_KEY en .env.';
    }

    try {
      const response = await axios.get(`${this.zenrioBaseUrl}/trending`, {
        params: { platform: args.platform, limit: args.limit || 10 },
        headers: { 'Authorization': `Bearer ${this.zenrioApiKey}` },
        timeout: 15000,
      });

      const topics = response.data?.topics || response.data?.trending || [];
      logger.info('social_media', `Trending on ${args.platform}: ${topics.length} topics`);
      return `Trending en ${args.platform}:\n${JSON.stringify(topics, null, 2)}`;
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.message;
      return `Error obteniendo trending: ${msg}`;
    }
  }
}

export const socialMediaTool = SocialMediaTool.getInstance();
