import type { Skill } from '../src/core/skills.js';
import chokidar from 'chokidar';
import { telegramInterface } from '../src/interfaces/telegram.js';
import { dashboard } from '../src/interfaces/dashboard.js';
import { securityManager } from '../src/core/security.js';

const watchdogSkill: Skill = {
    name: 'watchdog',
    description: 'Monitor a directory for file changes and report to Telegram.',
    execute: async (args: { path: string }) => {
        const watcher = chokidar.watch(args.path, {
            ignored: /(^|[\/\\])\../, // ignore dotfiles
            persistent: true
        });

        watcher.on('add', (filePath) => {
            const msg = `🔍 [Watchdog] New file detected: ${filePath}`;
            console.log(msg);
            
            const userId = securityManager.getAuthorizedUserId();
            if (userId) {
                telegramInterface.sendMessage(userId, msg);
            }
            dashboard.emitLog('info', msg);
        });

        return { message: `Started monitoring directory: ${args.path}` };
    }
};

export default watchdogSkill;
