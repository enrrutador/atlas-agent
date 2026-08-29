/**
 * Atlas Telegram Bot Interface - User communication via Telegram
 * All processing goes through taskHandler which handles skill routing
 */

import { logger } from '../../common/logger.js';
import { Message } from '../../common/types.js';
import { sessionDB } from '../../memory/session_db.js';
import { taskHandler } from '../../brain/task_handler.js';
import { forgeGate } from '../../forge/core/forge_gate.js';
import { forgeRunner } from '../../forge/missions/forge_runner.js';
import { missionManager, MissionManager } from '../../forge/missions/mission_manager.js';
import { idleBuilder } from '../../brain/idle_builder.js';
import { monitor } from '../../shield/monitor.js';
import { proposalManager } from '../../forge/proposals/proposal_manager.js';

export class TelegramInterface {
  private static instance: TelegramInterface;
  private bot: any = null;
  private token: string;
  private adminChatId: number;
  private llmClient: any = null;
  private systemPrompt: string = '';

  get isRunning(): boolean {
    return this._running;
  }
  private _running = false;

  private constructor() {
    this.token = process.env.TELEGRAM_BOT_TOKEN || '';
    this.adminChatId = parseInt(process.env.ADMIN_CHAT_ID || '0', 10);
  }

  static getInstance(): TelegramInterface {
    if (!TelegramInterface.instance) {
      TelegramInterface.instance = new TelegramInterface();
    }
    return TelegramInterface.instance;
  }

  setLLMClient(client: any): void {
    this.llmClient = client;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  async start(): Promise<boolean> {
    if (!this.token) {
      logger.error('telegram', 'No TELEGRAM_BOT_TOKEN configured');
      return false;
    }

    if (this.adminChatId === 0) {
      logger.warn('telegram', 'ADMIN_CHAT_ID is 0 — will respond to all chats');
    }

    try {
      const TelegramBot = (await import('node-telegram-bot-api')).default;
      this.bot = new TelegramBot(this.token, {
        polling: {
          interval: 1000,
          autoStart: true,
          params: { timeout: 10 },
        },
      });

      this.bot.on('message', async (msg: any) => {
        try {
          await this.handleMessage(msg);
        } catch (err) {
          logger.error('telegram', `Unhandled message error: ${err}`);
        }
      });

      this.bot.on('callback_query', async (query: any) => {
        try {
          await this.handleCallback(query);
        } catch (err) {
          logger.error('telegram', `Unhandled callback error: ${err}`);
        }
      });

      this.bot.on('polling_error', (err: any) => {
        logger.error('telegram', `Polling error: ${err.message || err}`);
      });

      this._running = true;
      logger.info('telegram', `Bot started — admin: ${this.adminChatId}`);
      return true;
    } catch (err) {
      logger.error('telegram', `Failed to start: ${err}`);
      monitor.logError('telegram_start', err as Error);
      return false;
    }
  }

  stop(): void {
    if (this.bot) {
      this.bot.stopPolling();
      this._running = false;
      logger.info('telegram', 'Bot stopped');
    }
  }

  async send(chatId: number, text: string): Promise<void> {
    if (!this.bot) return;
    try {
      const chunks = this.splitMessage(text, 4000);
      for (const chunk of chunks) {
        await this.bot.sendMessage(chatId, chunk);
      }
    } catch (err: any) {
      if (err?.response?.body?.error_code === 400) {
        try {
          await this.bot.sendMessage(chatId, text.slice(0, 4000));
        } catch (err2) {
          logger.error('telegram', `Send failed (plain fallback): ${err2}`);
        }
      } else {
        logger.error('telegram', `Send failed: ${err}`);
      }
    }
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      let cut = remaining.lastIndexOf('\n', maxLen);
      if (cut === -1 || cut > maxLen) cut = maxLen;
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
    return chunks;
  }

  private async handleMessage(msg: any): Promise<void> {
    const chatId: number = msg.chat?.id;
    const text: string = msg.text;

    if (!text || !chatId) return;

    logger.info('telegram', `Received: "${text.slice(0, 80)}" from ${chatId} (admin: ${this.adminChatId})`);

    if (this.adminChatId !== 0 && chatId !== this.adminChatId) {
      await this.send(chatId, 'Unauthorized. This bot is private.');
      return;
    }

    idleBuilder.recordActivity();

    if (text.startsWith('/')) {
      await this.handleCommand(chatId, text);
      return;
    }

    // If Forge is waiting for an answer, deliver this message to it
    if (missionManager.isAwaitingAnswer()) {
      missionManager.answerQuestion(text);
      await this.send(chatId, '✅ Respuesta enviada a Forge. Sigue trabajando.');
      return;
    }

    // Check for natural language Forge mission request
    const forgeRequest = MissionManager.parseMissionRequest(text);
    if (forgeRequest && !text.startsWith('/')) {
      logger.info('telegram', `Forge mission detected: "${forgeRequest.goal}" (${forgeRequest.variants} variants)`);
      try {
        await missionManager.startMission(
          forgeRequest.goal,
          forgeRequest.variants,
          async (msg) => await this.send(chatId, msg),
          async (question) => {
            await this.send(chatId, `❓ ${question}`);
            return question;
          },
          async (idea, total) => {
            await this.send(chatId, `✅ Idea ${idea.index + 1}/${total}: **${idea.title}** (${idea.score}/10)\n\n${idea.summary}`);
          },
        );
        await this.send(chatId, `🚀 Misión "${forgeRequest.goal}" lanzada. Forge trabaja en background.`);
      } catch (err) {
        await this.send(chatId, `Error con Forge: ${(err as Error).message}`);
      }
      return;
    }

    try {
      const session = await sessionDB.getSession(chatId.toString());
      const userMessage: Message = { role: 'user', content: text, timestamp: Date.now() };
      session.messages.push(userMessage);

      logger.info('telegram', `Processing (session: ${chatId}, msgs: ${session.messages.length})`);

      // Send "typing" indicator so user knows bot is working
      this.bot.sendChatAction(chatId, 'typing').catch(() => {});

      const result = await taskHandler.handle(session.messages, chatId.toString());

      if (result.escalated && result.forgeInput) {
        logger.info('telegram', `Escalated to Forge: ${result.forgeInput.problem.slice(0, 60)}`);
        const forgeResult = await forgeGate.process(result.forgeInput);

        if (forgeResult.output.decision === 'propose' && forgeResult.output.proposal) {
          await this.send(chatId, `Proposal requires approval:\n\n${forgeResult.output.proposal.description}\n\nImpact: ${forgeResult.output.proposal.impact} | Risk: ${forgeResult.output.proposal.risk}\n\nReply /approve or /reject`);
        } else if (this.llmClient && forgeResult.output.decision === 'proceed') {
          const llmResponse = await this.llmClient.chatCompletion([
            { role: 'system', content: this.systemPrompt },
            ...session.messages,
          ]);
          logger.info('telegram', `LLM responded (${llmResponse.length} chars)`);
          await this.send(chatId, llmResponse);
          session.messages.push({ role: 'assistant', content: llmResponse, timestamp: Date.now() });
        } else {
          const resp = forgeResult.output.reasoning || result.response;
          await this.send(chatId, resp);
          session.messages.push({ role: 'assistant', content: resp, timestamp: Date.now() });
        }
      } else {
        await this.send(chatId, result.response);
        session.messages.push({ role: 'assistant', content: result.response, timestamp: Date.now() });
      }

      await sessionDB.saveSession(chatId.toString(), session.messages);
      logger.info('telegram', `Session saved (${session.messages.length} messages)`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('telegram', `Message processing failed: ${errMsg}`);
      monitor.logError('telegram_message', err as Error);
      await this.send(chatId, `Error: ${errMsg}`);
    }
  }

  private async handleCommand(chatId: number, text: string): Promise<void> {
    const [cmd, ...args] = text.split(' ');

    switch (cmd.toLowerCase()) {
      case '/start':
        await this.send(chatId, 'Atlas Agent online. How can I help?');
        break;
      case '/status': {
        const pending = proposalManager.getPending();
        const forgeStatus = forgeRunner.isRunning() ? '\n🔧 Forge: activo' : '\n🔧 Forge: inactivo';
        await this.send(chatId, `Atlas Status:\nPending Proposals: ${pending.length}\nIdle: ${idleBuilder.isIdle()}${forgeStatus}`);
        break;
      }
      case '/approve': {
        const pendingProposals = proposalManager.getPending();
        if (pendingProposals.length > 0) {
          proposalManager.approve(pendingProposals[0].id);
          await this.send(chatId, `Approved: ${pendingProposals[0].name}`);
        } else {
          await this.send(chatId, 'No pending proposals');
        }
        break;
      }
      case '/reject': {
        const toReject = proposalManager.getPending();
        if (toReject.length > 0) {
          proposalManager.reject(toReject[0].id);
          await this.send(chatId, `Rejected: ${toReject[0].name}`);
        } else {
          await this.send(chatId, 'No pending proposals');
        }
        break;
      }
      case '/forge': {
        const subcommand = args[0]?.toLowerCase() || '';

        if (subcommand === 'status' || subcommand === '') {
          await this.send(chatId, missionManager.getStatus());
          break;
        }

        if (subcommand === 'cancel' || subcommand === 'stop') {
          if (forgeRunner.isRunning()) {
            missionManager.abort();
            await this.send(chatId, '⏸️ Forge pausado. Progreso guardado. Usá /forge resume para continuar.');
          } else {
            await this.send(chatId, 'Forge no está activo.');
          }
          break;
        }

        if (subcommand === 'resume') {
          const plan = forgeRunner.getCurrentPlan();
          if (plan) {
            try {
              await missionManager.resumeMission(plan.id, async (msg) => await this.send(chatId, msg), async (q) => q, async (idea, total) => {
                await this.send(chatId, `✅ Idea ${idea.index + 1}/${total}: ${idea.title} (${idea.score}/10)\n\n${idea.summary}`);
              });
              await this.send(chatId, '🔄 Retomando misión...');
            } catch (err) {
              await this.send(chatId, `Error: ${(err as Error).message}`);
            }
          } else {
            await this.send(chatId, 'No hay misión para retomar.');
          }
          break;
        }

        // /forge <goal> — start a new mission
        const missionText = text.replace(/^\/forge\s*/i, '').trim();
        if (missionText.length < 10) {
          await this.send(chatId, 'Uso: /forge <descripción de la misión>\nEjemplo: /forge pensá en 5 formas de ganar dinero con IA');
          break;
        }

        const parsed = MissionManager.parseMissionRequest(`/forge ${missionText}`);
        if (!parsed) {
          await this.send(chatId, 'No pude interpretar la misión. Intentá algo como:\n/forge investigá 5 formas de ganar dinero con IA');
          break;
        }

        try {
          await missionManager.startMission(
            parsed.goal,
            parsed.variants,
            async (msg) => await this.send(chatId, msg),
            async (question) => {
              await this.send(chatId, `❓ ${question}`);
              return question;
            },
            async (idea, total) => {
              await this.send(chatId, `✅ Idea ${idea.index + 1}/${total}: **${idea.title}** (${idea.score}/10)\n\n${idea.summary}`);
            },
          );
          await this.send(chatId, `🚀 Misión "${parsed.goal}" lanzada. Forge trabaja en background.`);
        } catch (err) {
          await this.send(chatId, `Error: ${(err as Error).message}`);
        }
        break;
      }
      default:
        await this.send(chatId, `Unknown command: ${cmd}`);
    }
  }

  private async handleCallback(query: any): Promise<void> {
    const chatId = query.message?.chat?.id;
    if (chatId) {
      await this.bot.answerCallbackQuery(query.id);
    }
  }
}

export const telegramInterface = TelegramInterface.getInstance();
