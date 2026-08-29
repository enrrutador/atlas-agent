import type { Skill } from '../src/core/skills.js';
import { queryVLM, getVLMStatus } from '../src/core/vlm_client.js';
import { parseAction } from '../src/core/action_parser.js';
import { executeAction, takeScreenshot } from '../src/core/gui_executor.js';

interface GUIAgentArgs {
	task: string;
	maxSteps?: number;
	stepDelay?: number;
	dryRun?: boolean;
}

class GUIAgent {
	async runTask(args: GUIAgentArgs): Promise<any> {
		const { task, maxSteps = 20, stepDelay = 1000, dryRun = false } = args;
		const stepHistory: string[] = [];
		let currentStep = 0;
		let isComplete = false;

		console.log(`[GUI_AGENT] Starting task: "${task}" (max ${maxSteps} steps, dryRun=${dryRun})`);

		const vlmStatus = getVLMStatus();
		console.log(`[GUI_AGENT] VLM endpoint: ${vlmStatus.endpoint}, model: ${vlmStatus.model}`);

		try {
			while (currentStep < maxSteps && !isComplete) {
				currentStep++;
				console.log(`[GUI_AGENT] Step ${currentStep}/${maxSteps}...`);

				const screenshotPath = await takeScreenshot();
				console.log(`[GUI_AGENT] Screenshot: ${screenshotPath}`);

				const vlmResponse = await queryVLM(screenshotPath, task, stepHistory);
				console.log(`[GUI_AGENT] Thought: ${vlmResponse.thought}`);
				console.log(`[GUI_AGENT] Action: ${vlmResponse.action}`);

				const parsed = parseAction(vlmResponse.action);
				console.log(`[GUI_AGENT] Parsed: ${parsed.type}`, parsed.params);

				stepHistory.push(`Step ${currentStep}: ${vlmResponse.thought} → ${vlmResponse.action}`);

				if (parsed.type === 'finished') {
					isComplete = true;
					break;
				}

				if (dryRun) {
					console.log(`[GUI_AGENT] DRY RUN - would execute: ${parsed.type}`, parsed.params);
					stepHistory[stepHistory.length - 1] += ' [DRY RUN]';
				} else {
					const result = await executeAction(parsed);
					console.log(`[GUI_AGENT] Result: ${result.message}`);

					if (!result.success) {
						stepHistory[stepHistory.length - 1] += ` [FAILED: ${result.message}]`;
						if (result.message.includes('Permission denied')) {
							return {
								success: false,
								message: `Permission denied at step ${currentStep}: ${result.message}`,
								steps: currentStep,
								history: stepHistory,
							};
						}
					}
				}

				if (stepDelay > 0) {
					await new Promise(resolve => setTimeout(resolve, stepDelay));
				}
			}

			return {
				success: isComplete,
				message: isComplete
					? `Task completed: "${task}" in ${currentStep} steps`
					: `Max steps (${maxSteps}) reached for: "${task}"`,
				steps: currentStep,
				history: stepHistory,
      vlmEndpoint: vlmStatus.endpoint,
			};
		} catch (error: any) {
			console.error(`[GUI_AGENT] Critical error: ${error.message}`);
			return {
				success: false,
				message: `Critical error: ${error.message}`,
				steps: currentStep,
				history: stepHistory,
			};
		}
	}

	getStatus(): any {
		const vlmStatus = getVLMStatus();
    return {
      vlmEndpoint: vlmStatus.endpoint,
			vlmEndpoint: vlmStatus.endpoint,
			vlmModel: vlmStatus.model,
		};
	}
}

const agent = new GUIAgent();

const guiAgentSkill: Skill = {
  name: 'gui_agent',
  description: 'Controla el escritorio Windows con mouse y teclado. USAR SIEMPRE que el usuario pida: abrir/cerrar programas, hacer clic en algo, escribir texto en una app, navegar menues, interactuar con ventanas, o cualquier tarea visual del PC. Args: {"task": "descripción de lo que hay que hacer en pantalla"}',
  execute: async (args: any) => {
    try {
      if (args.status || args.action === 'status') {
        return { success: true, message: 'GUI Agent status', data: agent.getStatus() };
      }

      if (!args.task) {
        const taskFromArgs = args.args?.task;
        if (!taskFromArgs) {
          return {
            success: false,
            message: 'Se requiere "task". Ej: {"task": "abrir Excel y crear tabla"}',
          };
        }
        return await agent.runTask({
          task: taskFromArgs,
          maxSteps: args.args?.maxSteps || 20,
          stepDelay: args.args?.stepDelay || 1000,
          dryRun: args.args?.dryRun || false,
        });
      }

      return await agent.runTask({
        task: args.task,
        maxSteps: args.maxSteps || 20,
        stepDelay: args.stepDelay || 1000,
        dryRun: args.dryRun || false,
      });
    } catch (error: any) {
      return { success: false, message: `Error: ${error.message}` };
    }
  },
};

export default guiAgentSkill;
