import type { Skill } from '../src/core/skills.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

interface MermaidConfig {
  theme?: 'default' | 'dark' | 'forest' | 'neutral' | 'base';
  backgroundColor?: string;
  scale?: number;
  width?: number;
  height?: number;
}

class MermaidRenderer {
  private outputDir: string;
  private browser: any = null;
  
  constructor() {
    this.outputDir = path.join(process.cwd(), 'data', 'diagrams');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  private async getBrowser() {
    if (!this.browser) {
      try {
        // @ts-ignore - playwright is optional
        const pw = await import('playwright');
        this.browser = await pw.chromium.launch({ headless: true });
      } catch {
        throw new Error('Playwright not installed. Run: npm install playwright && npx playwright install chromium');
      }
    }
    return this.browser;
  }

  async render(markup: string, format: 'png' | 'svg' | 'pdf' = 'png', config: MermaidConfig = {}): Promise<{ filePath: string; metadata: any }> {
    const timestamp = Date.now();
    const id = `${timestamp}_${Math.random().toString(36).substring(7)}`;
    const inputFile = path.join(this.outputDir, `input_${id}.mmd`);
    
    try {
      // Save markup to file
      fs.writeFileSync(inputFile, markup, 'utf-8');

      let outputFile: string;

      if (format === 'svg') {
        // Generate SVG using mermaid-cli
        outputFile = path.join(this.outputDir, `diagram_${id}.svg`);
        await this.renderSVG(inputFile, outputFile, config);
      } else if (format === 'png') {
        // Generate PNG using mermaid-cli
        outputFile = path.join(this.outputDir, `diagram_${id}.png`);
        await this.renderPNG(inputFile, outputFile, config);
      } else if (format === 'pdf') {
        // Generate PDF (convert from PNG or use puppeteer)
        outputFile = path.join(this.outputDir, `diagram_${id}.pdf`);
        await this.renderPDF(inputFile, outputFile, config);
      } else {
        throw new Error(`Formato no soportado: ${format}`);
      }

      // Get metadata
      const stats = fs.statSync(outputFile);
      const metadata = {
        format,
        fileSize: stats.size,
        createdAt: stats.birthtime,
        dimensions: format === 'png' ? await this.getImageDimensions(outputFile) : null,
      };

      return {
        filePath: outputFile,
        metadata,
      };
      
    } catch (error) {
      throw error;
    } finally {
      // Cleanup input file
      if (fs.existsSync(inputFile)) {
        try {
          fs.unlinkSync(inputFile);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
  }

  private async renderSVG(inputFile: string, outputFile: string, config: MermaidConfig): Promise<void> {
    const theme = config.theme || 'default';
    const backgroundColor = config.backgroundColor || 'white';
    
    const command = `npx -p @mermaid-js/mermaid-cli mmdc -i "${inputFile}" -o "${outputFile}" -b ${backgroundColor} -t ${theme}`;
    
    await execAsync(command, {
      timeout: 60000,
      cwd: this.outputDir,
    });
  }

  private async renderPNG(inputFile: string, outputFile: string, config: MermaidConfig): Promise<void> {
    const theme = config.theme || 'default';
    const backgroundColor = config.backgroundColor || 'white';
    const scale = config.scale || 2;
    
    const command = `npx -p @mermaid-js/mermaid-cli mmdc -i "${inputFile}" -o "${outputFile}" -b ${backgroundColor} -t ${theme} -s ${scale}`;
    
    await execAsync(command, {
      timeout: 60000,
      cwd: this.outputDir,
    });
  }

  private async renderPDF(inputFile: string, outputFile: string, config: MermaidConfig): Promise<void> {
    // First render as SVG, then convert to PDF using puppeteer
    const tempSvg = outputFile.replace('.pdf', '.temp.svg');
    await this.renderSVG(inputFile, tempSvg, config);
    
    try {
      const browser = await this.getBrowser();
      const page = await browser.newPage();
      
      // Read SVG content
      const svgContent = fs.readFileSync(tempSvg, 'utf-8');
      
      // Set content and generate PDF
      await page.setContent(`
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
            svg { max-width: 100%; height: auto; }
          </style>
        </head>
        <body>
          ${svgContent}
        </body>
        </html>
      `);
      
      await page.pdf({
        path: outputFile,
        printBackground: true,
        preferCSSPageSize: true,
      });
      
      await page.close();
    } finally {
      // Cleanup temp SVG
      if (fs.existsSync(tempSvg)) {
        fs.unlinkSync(tempSvg);
      }
    }
  }

  private async getImageDimensions(filePath: string): Promise<{ width: number; height: number } | null> {
    try {
      const browser = await this.getBrowser();
      const page = await browser.newPage();
      
      // Load image and get dimensions
      const dimensions = await page.evaluate(async (imagePath: string) => {
        return new Promise<{ width: number; height: number }>((resolve) => {
          const img = new Image();
          img.onload = () => {
            resolve({ width: img.width, height: img.height });
          };
          img.src = 'file://' + imagePath;
        });
      }, filePath);
      
      await page.close();
      return dimensions;
    } catch (e) {
      return null;
    }
  }

  async renderToBuffer(markup: string, format: 'png' | 'svg' = 'png', config: MermaidConfig = {}): Promise<Buffer> {
    const { filePath } = await this.render(markup, format, config);
    const buffer = fs.readFileSync(filePath);
    
    // Cleanup after reading
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      // Ignore cleanup errors
    }
    
    return buffer;
  }

  async validateMermaidSyntax(markup: string): Promise<{ valid: boolean; error?: string }> {
    try {
      // Quick syntax check using mermaid-cli with --check flag
      const tempFile = path.join(this.outputDir, `check_${Date.now()}.mmd`);
      fs.writeFileSync(tempFile, markup);
      
      try {
        await execAsync(
          `npx -p @mermaid-js/mermaid-cli mmdc --check -i "${tempFile}"`,
          { timeout: 10000 }
        );
        return { valid: true };
      } catch (error: any) {
        return { valid: false, error: error.stderr || error.message };
      } finally {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      }
    } catch (error: any) {
      return { valid: false, error: error.message };
    }
  }

  async getAvailableDiagramTypes(): Promise<string[]> {
    return [
      'flowchart',      // Diagramas de flujo
      'sequenceDiagram', // Diagramas de secuencia
      'classDiagram',    // Diagramas de clases
      'stateDiagram',    // Diagramas de estado
      'erDiagram',       // Diagramas ER (Entidad-Relación)
      'gantt',           // Diagramas de Gantt
      'pie',             // Gráficos de torta
      'requirementDiagram', // Diagramas de requisitos
      'gitGraph',        // Diagramas de Git
      'mindmap',         // Mapas mentales
      'timeline',        // Líneas de tiempo
      'journey',         // Mapas de viaje del usuario
      'c4c',             // Diagramas C4 Context
      'c4d',             // Diagramas C4 Dynamic
      'c4d',             // Diagramas C4 Deployment
    ];
  }

  async cleanup(): Promise<void> {
    // Close browser if open
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }

    // Cleanup old files (older than 1 hour)
    try {
      const files = fs.readdirSync(this.outputDir);
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      
      for (const file of files) {
        const filePath = path.join(this.outputDir, file);
        const stats = fs.statSync(filePath);
        
        if (now - stats.mtime.getTime() > oneHour) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

// Create singleton instance
const renderer = new MermaidRenderer();

const mermaidRendererSkill: Skill = {
  name: 'mermaid_renderer',
  description: 'Renderiza diagramas Mermaid a imágenes PNG, SVG o PDF. Soporta: flowchart, sequence, class, state, erd, gantt, pie, gitgraph, mindmap, timeline. JSON Args: { "markup": "graph TD; A-->B;", "format": "png", "config": { "theme": "default", "scale": 2 } }',
  execute: async (args: { 
    markup: string; 
    format?: 'png' | 'svg' | 'pdf';
    config?: MermaidConfig;
    action?: 'render' | 'validate' | 'types';
  }) => {
    try {
      const action = args.action || 'render';

      switch (action) {
        case 'render':
          if (!args.markup) {
            return { 
              success: false, 
              message: "Se requiere 'markup' para renderizar" 
            };
          }

          const format = args.format || 'png';
          const config = args.config || {};
          
          const { filePath, metadata } = await renderer.render(args.markup, format, config);
          
          return {
            success: true,
            message: `Diagrama renderizado exitosamente`,
            filePath,
            format,
            metadata,
          };

        case 'validate':
          if (!args.markup) {
            return { 
              success: false, 
              message: "Se requiere 'markup' para validar" 
            };
          }
          
          const validation = await renderer.validateMermaidSyntax(args.markup);
          return {
            success: validation.valid,
            message: validation.valid ? 'Sintaxis válida' : `Error de sintaxis: ${validation.error}`,
            error: validation.error || null,
          };

        case 'types':
          const types = await renderer.getAvailableDiagramTypes();
          return {
            success: true,
            message: 'Tipos de diagramas disponibles',
            types,
          };

        default:
          return {
            success: false,
            message: `Acción desconocida: ${action}. Usa: render, validate, types`,
          };
      }
      
    } catch (error: any) {
      return { 
        success: false, 
        message: `Error al renderizar: ${error.message}` 
      };
    }
  }
};

export default mermaidRendererSkill;
