/**
 * Atlas CLI Interface - Direct terminal interaction
 * All processing goes through taskHandler which handles skill routing
 */

import * as readline from 'readline';
import { logger } from '../common/logger.js';
import { Message } from '../common/types.js';
import { sessionDB } from '../memory/session_db.js';
import { taskHandler } from '../brain/task_handler.js';
import { forgeGate } from '../forge/core/forge_gate.js';
import { forgeRunner } from '../forge/missions/forge_runner.js';
import { missionManager, MissionManager } from '../forge/missions/mission_manager.js';
import { monitor } from '../shield/monitor.js';
import { proposalManager } from '../forge/proposals/proposal_manager.js';
import { brainSkills } from '../brain/skills.js';
import { logsPanel } from './tui/logs_panel.js';

export class CLIInterface {
  private static instance: CLIInterface;
  private rl: readline.Interface | null = null;
  private messages: Message[] = [];
  private llmClient: any = null;
  private systemPrompt: string = '';
  private readonly SESSION_ID = 'cli_session';

  private constructor() {}

  static getInstance(): CLIInterface {
    if (!CLIInterface.instance) {
      CLIInterface.instance = new CLIInterface();
    }
    return CLIInterface.instance;
  }

  setLLMClient(client: any): void {
    this.llmClient = client;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  async start(): Promise<void> {
    const session = await sessionDB.getSession(this.SESSION_ID);
    this.messages = session.messages;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'atlas> ',
    });

    logsPanel.activate();
    this.rl.prompt();

    this.rl.on('line', async (line: string) => {
      const input = line.trim();
      if (!input) {
        this.rl?.prompt();
        return;
      }

      if (input.startsWith('/')) {
        await this.handleCommand(input);
        this.rl?.prompt();
        return;
      }

      await this.processInput(input);
      this.rl?.prompt();
    });

    this.rl.on('close', async () => {
      await sessionDB.saveSession(this.SESSION_ID, this.messages);
      logger.info('cli', 'Session ended');
      process.exit(0);
    });

    logger.info('cli', `CLI started (${this.messages.length} restored messages)`);
  }

  private async processInput(input: string): Promise<void> {
    // If Forge is waiting for an answer, deliver this input to it
    if (missionManager.isAwaitingAnswer()) {
      missionManager.answerQuestion(input);
      console.log('\n[FORGE] Respuesta enviada. Sigue trabajando.');
      return;
    }

    // Check for natural language Forge mission request
    const forgeRequest = MissionManager.parseMissionRequest(input);
    if (forgeRequest && !input.startsWith('/')) {
      console.log(`\n[FORGE] Misión detectada: "${forgeRequest.goal}" (${forgeRequest.variants} variantes)`);
      try {
        await missionManager.startMission(
          forgeRequest.goal,
          forgeRequest.variants,
          async (msg) => console.log(`\n${msg}`),
          async (question) => question,
          async (idea, total) => {
            console.log(`\n✅ Idea ${idea.index + 1}/${total}: ${idea.title} (${idea.score}/10)`);
            console.log(`${idea.summary}\n`);
          },
        );
        console.log(`\n[FORGE] Misión lanzada. Forge trabaja en background.`);
      } catch (err) {
        console.log(`\nError con Forge: ${(err as Error).message}`);
      }
      return;
    }

    this.messages.push({ role: 'user', content: input, timestamp: Date.now() });

    try {
      const result = await taskHandler.handle(this.messages, this.SESSION_ID);

      if (result.escalated && result.forgeInput) {
        const forgeResult = await forgeGate.process(result.forgeInput);

        if (forgeResult.output.decision === 'propose' && forgeResult.output.proposal) {
          console.log(`\n[PROPOSAL] ${forgeResult.output.proposal.description}`);
          console.log(`Impact: ${forgeResult.output.proposal.impact} | Risk: ${forgeResult.output.proposal.risk}`);
          console.log('Use /approve or /reject\n');
        } else if (this.llmClient && forgeResult.output.decision === 'proceed') {
          const response = await this.llmClient.chatCompletion([
            { role: 'system', content: this.systemPrompt },
            ...this.messages,
          ]);
          console.log(`\n${response}\n`);
          this.messages.push({ role: 'assistant', content: response, timestamp: Date.now() });
        } else {
          console.log(`\n${forgeResult.output.reasoning || result.response}\n`);
          this.messages.push({ role: 'assistant', content: forgeResult.output.reasoning || result.response, timestamp: Date.now() });
        }
      } else {
        console.log(`\n${result.response}\n`);
        this.messages.push({ role: 'assistant', content: result.response, timestamp: Date.now() });
      }

      await sessionDB.saveSession(this.SESSION_ID, this.messages);
    } catch (err) {
      monitor.logError('cli_input', err as Error);
      console.log(`\nError: ${(err as Error).message}\n`);
    }
  }

  private async handleCommand(input: string): Promise<void> {
    const [cmd, ..._args] = input.slice(1).split(' ');

    switch (cmd.toLowerCase()) {
      case 'status': {
        const skills = brainSkills.list();
        console.log(`Pending Proposals: ${proposalManager.getPending().length}`);
        console.log(`Skills: ${skills.length} (${skills.map(s => s.name).join(', ')})`);
        console.log(`Messages: ${this.messages.length}`);
        break;
      }
      case 'skills': {
        const skillList = brainSkills.list();
        if (skillList.length === 0) {
          console.log('No skills registered');
        } else {
          for (const s of skillList) {
            console.log(` ${s.name} — ${s.description}`);
          }
        }
        break;
      }
      case 'logs': {
        const entries = logsPanel.getFiltered(20);
        for (const entry of entries) {
          console.log(logsPanel.formatEntry(entry));
        }
        break;
      }
      case 'logstats': {
        const stats = logsPanel.getStats();
        console.log(`Total: ${stats.total}`);
        console.log(`By Level:`, stats.byLevel);
        console.log(`By Source:`, stats.bySource);
        break;
      }
      case 'clear':
        this.messages = [];
        await sessionDB.saveSession(this.SESSION_ID, this.messages);
        console.log('Context cleared');
        break;
      case 'approve': {
        const pending = proposalManager.getPending();
        if (pending.length > 0) {
          proposalManager.approve(pending[0].id);
          console.log(`Approved: ${pending[0].name}`);
        } else {
          console.log('No pending proposals');
        }
        break;
      }
      case 'reject': {
        const toReject = proposalManager.getPending();
        if (toReject.length > 0) {
          proposalManager.reject(toReject[0].id);
          console.log(`Rejected: ${toReject[0].name}`);
        } else {
          console.log('No pending proposals');
        }
        break;
      }
      case 'forge': {
        const sub = _args[0]?.toLowerCase() || '';
        if (sub === 'status' || sub === '') {
          console.log(missionManager.getStatus());
        } else if (sub === 'cancel' || sub === 'stop') {
          if (forgeRunner.isRunning()) {
            missionManager.abort();
            console.log('⏸️ Forge pausado. Progreso guardado.');
          } else {
            console.log('Forge no está activo.');
          }
        } else if (sub === 'resume') {
          const plan = forgeRunner.getCurrentPlan();
          if (plan) {
            try {
              await missionManager.resumeMission(plan.id, async (msg) => console.log(msg), async (q) => q, async (idea, total) => {
                console.log(`✅ Idea ${idea.index + 1}/${total}: ${idea.title} (${idea.score}/10)`);
              });
            } catch (err) {
              console.log(`Error: ${(err as Error).message}`);
            }
          } else {
            console.log('No hay misión para retomar.');
          }
        } else {
          const goal = _args.join(' ');
          if (goal.length < 10) {
            console.log('Uso: /forge <descripción de la misión>\nEjemplo: /forge investigá 5 formas de ganar dinero con IA');
          } else {
            const parsed = MissionManager.parseMissionRequest(`/forge ${goal}`);
            if (parsed) {
              try {
                await missionManager.startMission(parsed.goal, parsed.variants, async (msg) => console.log(msg), async (q) => q, async (idea, total) => {
                  console.log(`✅ Idea ${idea.index + 1}/${total}: ${idea.title} (${idea.score}/10)`);
                });
              } catch (err) {
                console.log(`Error: ${(err as Error).message}`);
              }
            }
          }
        }
        break;
      }
      case 'help':
        console.log('Commands: /status /skills /logs /logstats /clear /approve /reject /forge /help /exit');
        break;
      case 'exit':
        await sessionDB.saveSession(this.SESSION_ID, this.messages);
        this.rl?.close();
        break;
      default:
        console.log(`Unknown: /${cmd}. Type /help`);
    }
  }
}

export const cliInterface = CLIInterface.getInstance();
