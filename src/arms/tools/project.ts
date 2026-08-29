/**
 * Atlas Project Scaffold Tool - Initialize projects from templates
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../common/logger.js';

const execAsync = promisify(exec);

interface ProjectTemplate {
  name: string;
  description: string;
  files: Record<string, string>;
  postCommands?: string[];
}

const TEMPLATES: Record<string, ProjectTemplate> = {
  'node-ts': {
    name: 'Node.js + TypeScript',
    description: 'Proyecto Node.js con TypeScript, ESLint, y estructura estándar',
    files: {
      'package.json': `{
  "name": "{{NAME}}",
  "version": "1.0.0",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node src/index.ts",
    "lint": "eslint src/"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "ts-node": "^10.9.0",
    "@types/node": "^20.0.0",
    "eslint": "^8.56.0"
  }
}`,
      'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}`,
      'src/index.ts': `console.log('Hello from {{NAME}}!');\n`,
      '.gitignore': `node_modules/\ndist/\n.env\n*.log\n`,
      'README.md': `# {{NAME}}\n\n{{DESCRIPTION}}\n`,
    },
    postCommands: ['npm install'],
  },
  'react-vite': {
    name: 'React + Vite + TypeScript',
    description: 'Frontend React con Vite, TypeScript, y Tailwind CSS',
    files: {
      'package.json': `{
  "name": "{{NAME}}",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.2.0",
    "typescript": "^5.3.0",
    "vite": "^5.0.0",
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "tailwindcss": "^3.4.0",
    "postcss": "^8.4.0",
    "autoprefixer": "^10.4.0"
  }
}`,
      'src/App.tsx': `export default function App() {\n  return <div className="p-8"><h1 className="text-2xl font-bold">{{NAME}}</h1></div>;\n}\n`,
      'src/main.tsx': `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\nimport './index.css';\n\nReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);\n`,
      'src/index.css': `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`,
      'index.html': `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>{{NAME}}</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`,
    },
    postCommands: ['npm install'],
  },
  'python-fastapi': {
    name: 'Python FastAPI',
    description: 'Backend Python con FastAPI, uvicorn, y estructura estándar',
    files: {
      'requirements.txt': `fastapi>=0.104.0\nuvicorn>=0.24.0\npydantic>=2.5.0\npython-dotenv>=1.0.0\n`,
      'app/main.py': `from fastapi import FastAPI\n\napp = FastAPI(title="{{NAME}}")\n\n@app.get("/")\nasync def root():\n    return {"message": "Hello from {{NAME}}"}\n`,
      'app/__init__.py': ``,
      '.env.example': `PORT=8000\nDEBUG=true\n`,
      '.gitignore': `__pycache__/\n*.pyc\n.env\nvenv/\n*.egg-info/\n`,
      'README.md': `# {{NAME}}\n\n{{DESCRIPTION}}\n\n## Run\n\`\`\`bash\npip install -r requirements.txt\nuvicorn app.main:app --reload\n\`\`\`\n`,
    },
    postCommands: ['pip install -r requirements.txt'],
  },
  'express-api': {
    name: 'Express.js REST API',
    description: 'Backend REST API con Express.js, TypeScript, y estructura MVC',
    files: {
      'package.json': `{
  "name": "{{NAME}}",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node-dev --respawn src/index.ts"
  },
  "dependencies": {
    "express": "^4.18.0",
    "cors": "^2.8.5",
    "dotenv": "^16.3.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "ts-node-dev": "^2.0.0",
    "@types/express": "^4.17.0",
    "@types/cors": "^2.8.0",
    "@types/node": "^20.0.0"
  }
}`,
      'src/index.ts': `import express from 'express';\nimport cors from 'cors';\nimport dotenv from 'dotenv';\ndotenv.config();\n\nconst app = express();\napp.use(cors());\napp.use(express.json());\n\napp.get('/api/health', (_req, res) => res.json({ status: 'ok' }));\n\nconst PORT = process.env.PORT || 3000;\napp.listen(PORT, () => console.log(\`Server on port \${PORT}\`));\n`,
      'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}`,
    },
    postCommands: ['npm install'],
  },
  'nextjs': {
    name: 'Next.js Fullstack',
    description: 'Next.js App Router con TypeScript y Tailwind CSS',
    files: {
      'package.json': `{
  "name": "{{NAME}}",
  "version": "1.0.0",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "^14.0.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "@types/react": "^18.2.0",
    "@types/node": "^20.0.0",
    "tailwindcss": "^3.4.0",
    "postcss": "^8.4.0",
    "autoprefixer": "^10.4.0"
  }
}`,
      'src/app/page.tsx': `export default function Home() {\n  return <main className="p-8"><h1 className="text-3xl font-bold">{{NAME}}</h1></main>;\n}\n`,
      'src/app/layout.tsx': `export const metadata = { title: '{{NAME}}' };\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang="es"><body>{children}</body></html>;\n}\n`,
    },
    postCommands: ['npm install'],
  },
};

export class ProjectTool {
  private static instance: ProjectTool;

  private constructor() {}

  static getInstance(): ProjectTool {
    if (!ProjectTool.instance) {
      ProjectTool.instance = new ProjectTool();
    }
    return ProjectTool.instance;
  }

  listTemplates(): string {
    return Object.entries(TEMPLATES)
      .map(([key, t]) => `  ${key}: ${t.description}`)
      .join('\n');
  }

  async scaffold(templateName: string, projectName: string, targetDir: string): Promise<string> {
    const template = TEMPLATES[templateName];
    if (!template) {
      return `Template "${templateName}" no encontrado. Disponibles:\n${this.listTemplates()}`;
    }

    const safeName = path.basename(projectName.replace(/[^a-zA-Z0-9_-]/g, '_'));
    const projectDir = path.join(targetDir, safeName);

    if (fs.existsSync(projectDir)) {
      return `El directorio ${projectDir} ya existe.`;
    }

    try {
      fs.mkdirSync(projectDir, { recursive: true });

      for (const [filePath, content] of Object.entries(template.files)) {
        const finalContent = content
          .replace(/\{\{NAME\}\}/g, projectName)
          .replace(/\{\{DESCRIPTION\}\}/g, template.description);

        const fullPath = path.join(projectDir, filePath);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(fullPath, finalContent);
      }

      // Run post-commands
      if (template.postCommands) {
        for (const cmd of template.postCommands) {
          try {
            await execAsync(cmd, { cwd: projectDir, timeout: 120000 });
          } catch (err: any) {
            logger.warn('project', `Post-command "${cmd}" failed: ${err.message}`);
          }
        }
      }

      logger.info('project', `Scaffolded ${templateName} → ${projectDir}`);
      return `Proyecto "${projectName}" creado en ${projectDir} usando template "${template.name}".\nArchivos: ${Object.keys(template.files).join(', ')}`;
    } catch (err: any) {
      logger.error('project', `Scaffold failed: ${err.message}`);
      return `Error creando proyecto: ${err.message}`;
    }
  }
}

export const projectTool = ProjectTool.getInstance();
