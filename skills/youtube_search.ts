import type { Skill } from '../src/core/skills.js';
import { browserController } from '../src/tools/browser.js';

const youtubeSearchSkill: Skill = {
    name: 'youtube_search',
    description: 'Search for videos on YouTube and return the results.',
    execute: async (args: { query: string }) => {
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(args.query)}`;
        await browserController.navigate(url);
        // Wait for results to load
        // This is a simplified version, in a real scenario we'd parse the DOM
        const screenshot = await browserController.screenshot();
        return { message: `Searched for ${args.query} on YouTube. Results are in the screenshot.`, screenshot };
    }
};

export default youtubeSearchSkill;
