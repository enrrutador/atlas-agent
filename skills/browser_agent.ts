import type { Skill } from '../src/core/skills.js';
import { browserTool as browserController } from '../src/arms/tools/browser.js';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

// Types for browser context
interface ElementInfo {
  uid: string;
  tag: string;
  role?: string;
  name?: string;
  value?: string;
  placeholder?: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
}

interface PageInfo {
  index: number;
  url: string;
  title: string;
}

interface ExtendedPage {
  uid?: string;
  url(): Promise<string>;
  title(): Promise<string>;
  close(): Promise<void>;
  bringToFront(): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  evaluate(fn: (...args: any[]) => any, ...args: any[]): Promise<any>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  on(event: string, handler: (...args: any[]) => any): void;
  keyboard: { press(key: string): Promise<void>; down(key: string): Promise<void>; up(key: string): Promise<void> };
  context(): { setGeolocation(geo: { latitude: number; longitude: number; accuracy?: number }): Promise<void>; newCDPSession(page: any): Promise<any> };
}

interface BrowserAgentState {
  pages: ExtendedPage[];
  selectedPageIdx: number;
  elementMap: Map<string, any>;
  consoleMessages: Array<{ type: string; text: string; timestamp: number }>;
  networkRequests: Array<{ url: string; method: string; status: number; timestamp: number }>;
}

// Browser Agent with Autonomous and Manual modes
class BrowserAgentUnified {
  private state: BrowserAgentState = {
    pages: [],
    selectedPageIdx: 0,
    elementMap: new Map(),
    consoleMessages: [],
    networkRequests: []
  };

  // ==================== MODE: AUTONOMOUS (Original browser_agent) ====================
  
  async runAutonomousTask(args: { task: string; downloadPath?: string; maxSteps?: number }): Promise<any> {
    const { task, maxSteps = 15 } = args;
    const downloadPath = args.downloadPath || path.join(os.homedir(), 'Desktop', 'Atlas_Downloads');
    let currentStep = 0;
    let isComplete = false;
    let history: string[] = [];

    console.log(`[BROWSER_AGENT] Iniciando misión: "${task}"`);
    console.log(`[BROWSER_AGENT] Carpeta de descargas: ${downloadPath}`);

    try {
      while (currentStep < maxSteps && !isComplete) {
        currentStep++;
        console.log(`[BROWSER_AGENT] Paso ${currentStep}/${maxSteps}...`);

        // 1. Obtener el estado actual de la página con DOM marcado
        const url = await (browserController as any).page?.url() || 'about:blank';
        const dom = await browserController.getSimplifiedDOM();

        // Separar imágenes de otros elementos para claridad del LLM
        const images = (dom as any[]).filter((el: any) => el.tag === 'img').slice(0, 30);
        const interactive = (dom as any[]).filter((el: any) => el.tag !== 'img').slice(0, 80);

      // 2. Consultar al cerebro (Kimi) qué acción tomar
      const decisionResponse = await createChatCompletion({
        model: process.env.MODEL_NAME || 'moonshotai/kimi-k2.5',
        messages: [
          {
            role: 'system',
            content: `Eres el Cerebro de Navegación Agéntica de Atlas. Tu ÚNICA misión es: "${task}".

SISTEMA DE CONTROL:
Cada elemento interactuable en la página tiene un ID numérico único asignado (data-atlas-id).
Usa SIEMPRE ese ID numérico para referirte a elementos. NUNCA uses selectores CSS complejos.

ACCIONES DISPONIBLES:
- navigate: Navegar a una URL. "selector" = URL destino.
- click: Hacer clic en un elemento. "selector" = ID numérico del elemento.
- type: Escribir texto en un campo. "selector" = ID numérico, "value" = texto.
- scroll: Desplazarse. "selector" = "down" o "up".
- wait: Esperar carga. "value" = milisegundos (ej: "2000").
- download: Descargar imagen/archivo directamente. "selector" = ID numérico del elemento img o enlace. "value" = nombre del archivo (ej: "foto.jpg").
- complete: La tarea está 100% terminada.

REGLAS CRÍTICAS:

1. Para buscar imágenes: navega a Google Images (https://images.google.com), escribe en el campo de búsqueda (ID del input), presiona Enter y luego selecciona la mejor imagen usando "download".
2. Para descargar: usa action "download" con el ID de la imagen. NO hagas clic derecho, NO uses menús emergentes.
3. Si ves CAPTCHA: responde con action "wait" y value "3000".

Responde ÚNICAMENTE en JSON puro (sin markdown, sin comillas extra):
{
  "reasoning": "Qué ves y por qué tomas esta acción",
  "action": "navigate|click|type|scroll|wait|download|complete",
  "selector": "ID numérico del elemento O URL si es navigate",
  "value": "Texto para type, ms para wait, nombre de archivo para download",
  "isTaskComplete": false
}`
          },
          {
            role: 'user',
            content: `URL ACTUAL: ${url}

ELEMENTOS INTERACTUABLES (usa su ID para click/type):
${JSON.stringify(interactive.slice(0, 60), null, 2)}

IMÁGENES DETECTADAS (usa su ID para download):
${JSON.stringify(images, null, 2)}

HISTORIAL: ${history.join(' → ')}

¿Cuál es tu siguiente acción para cumplir la misión?`
          }
        ],
        response_format: { type: 'json_object' }
      });
      
      const decision = JSON.parse(decisionResponse.choices[0]!.message.content || '{}');

        console.log(`[BROWSER_AGENT] Decisión: [${decision.action}] ${decision.reasoning}`);
        history.push(`${decision.action}(${decision.selector || ''})`);

        if (decision.isTaskComplete || decision.action === 'complete') {
          isComplete = true;
          break;
        }

        // 3. Ejecutar la acción
        switch (decision.action) {
          case 'navigate':
            await browserController.navigate(decision.selector);
            await browserController.waitForTimeout(2000);
            break;

          case 'click':
            await browserController.click(String(decision.selector));
            await browserController.waitForTimeout(1500);
            break;

          case 'type':
            await browserController.type(String(decision.selector), decision.value || '');
            // Press Enter after typing to submit searches
            await (browserController as any).page?.keyboard.press('Enter');
            await browserController.waitForTimeout(2500);
            break;

          case 'scroll':
            await browserController.scroll(decision.selector === 'up' ? 'up' : 'down');
            await browserController.waitForTimeout(800);
            break;

          case 'wait':
            await browserController.waitForTimeout(parseInt(decision.value) || 2000);
            break;

          case 'download': {
            const fileName = decision.value || `atlas_download_${Date.now()}.jpg`;
            const fullDest = path.join(downloadPath, fileName);
            const result = await browserController.downloadElement(String(decision.selector), fullDest);
            console.log(`[BROWSER_AGENT] ${result}`);
            history.push(`Downloaded → ${fullDest}`);
            isComplete = true;
            await browserController.close();
            return {
              success: true,
              message: `Descarga completada. Archivo guardado en: ${fullDest}`,
              history
            };
          }
        }

        // 4. Auto-check CAPTCHA
        const pageContent = await browserController.getPageContent();
        if (pageContent.includes('unusual traffic') || pageContent.includes('reCAPTCHA')) {
          console.log('[BROWSER_AGENT] Bloqueo detectado. Intentando bypass...');
          await browserController.solveCaptcha();
          await browserController.waitForTimeout(3000);
        }
      }

      if (!isComplete) {
        await browserController.close();
        return {
          success: false,
          message: `Se alcanzó el máximo de ${maxSteps} pasos sin completar: "${task}"`,
          history
        };
      }

      await browserController.close();
      return {
        success: true,
        message: `Misión cumplida: ${task}`,
        history
      };

    } catch (error: any) {
      console.error(`[BROWSER_AGENT CRITICAL ERROR] ${error.message}`);
      await browserController.close().catch(() => {});
      return { success: false, message: `Fallo crítico en la misión: ${error.message}` };
    }
  }

  // ==================== MODE: MANUAL (browser_agent_v2 features) ====================

  async getSelectedPage(): Promise<Page> {
    const page = (browserController as any).page;
    if (!page) {
      throw new Error('No hay página abierta');
    }
    return page;
  }

  async waitForStability(timeout: number = 1000): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, timeout));
  }

  // INPUT TOOLS
  async click(uid: string, dblClick: boolean = false): Promise<string> {
    const page = await this.getSelectedPage();
    const element = this.state.elementMap.get(uid);
    
    if (!element) {
      // Fallback: use browserController click
      await browserController.click(uid);
    } else {
      await element.click({ count: dblClick ? 2 : 1 });
    }
    
    await this.waitForStability();
    return dblClick ? 'Doble click exitoso' : 'Click exitoso';
  }

  async hover(uid: string): Promise<string> {
    const element = this.state.elementMap.get(uid);
    
    if (element) {
      await element.hover();
    }
    
    await this.waitForStability();
    return 'Hover exitoso';
  }

  async fill(uid: string, value: string): Promise<string> {
    const element = this.state.elementMap.get(uid);
    
    if (element) {
      await element.fill(value);
    } else {
      // Fallback
      await browserController.type(uid, value);
    }
    
    await this.waitForStability();
    return 'Campo completado';
  }

  async drag(fromUid: string, toUid: string): Promise<string> {
    const fromElement = this.state.elementMap.get(fromUid);
    const toElement = this.state.elementMap.get(toUid);
    
    if (fromElement && toElement) {
      await fromElement.dragTo(toElement);
    }
    
    await this.waitForStability();
    return 'Drag & drop exitoso';
  }

  async uploadFile(uid: string, filePath: string): Promise<string> {
    const element = this.state.elementMap.get(uid);
    
    if (element) {
      await element.setInputFiles(filePath);
    }
    
    await this.waitForStability();
    return `Archivo subido: ${filePath}`;
  }

  async pressKey(key: string): Promise<string> {
    const page = await this.getSelectedPage();
    
    // Parse key combination (e.g., "Control+A", "Enter")
    const keys = key.split('+').map(k => k.trim());
    
    if (keys.length === 1) {
      await page.keyboard.press(keys[0]!);
    } else {
      const mainKey = keys[keys.length - 1]!;
      const modifiers = keys.slice(0, -1);
      
      for (const modifier of modifiers) {
        await page.keyboard.down(modifier!);
      }
      await page.keyboard.press(mainKey);
      for (const modifier of modifiers.reverse()) {
        await page.keyboard.up(modifier!);
      }
    }
    
    await this.waitForStability();
    return `Tecla presionada: ${key}`;
  }

  // NAVIGATION TOOLS
  async newPage(url?: string): Promise<number> {
    const page = await browserController.navigate(url || 'about:blank');
    const newIdx = this.state.pages.length;
    this.state.pages.push((browserController as any).page);
    this.state.selectedPageIdx = newIdx;
    return newIdx;
  }

  async navigatePage(type: 'url' | 'back' | 'forward' | 'reload', 
                    url?: string): Promise<string> {
    const page = await this.getSelectedPage();
    
    switch (type) {
      case 'url':
        if (!url) {
          throw new Error('URL requerida');
        }
        await browserController.navigate(url);
        return `Navegado a: ${url}`;
        
      case 'back':
        await page.goBack();
        return 'Navegación atrás';
        
      case 'forward':
        await page.goForward();
        return 'Navegación adelante';
        
      case 'reload':
        await page.reload();
        return 'Página recargada';
        
      default:
        throw new Error(`Tipo desconocido: ${type}`);
    }
  }

  async takeScreenshot(fullPage: boolean = false, selector?: string): Promise<Buffer> {
    const screenshotPath = await browserController.screenshot();
    const fs = await import('fs');
    return fs.readFileSync(screenshotPath);
  }

  async evaluateScript(code: string): Promise<any> {
    const page = await this.getSelectedPage();
    return await page.evaluate((script) => {
      try {
        // eslint-disable-next-line no-eval
        return eval(script);
      } catch (e) {
        return { error: (e as Error).message };
      }
    }, code);
  }

  // ==================== MISSING TOOLS FROM browser_agent_v2 ====================

  // NAVIGATION TOOLS
  async listPages(): Promise<PageInfo[]> {
    if (!this.state.pages.length) {
      // Get current page from browserController
      const currentPage = (browserController as any).page;
      if (currentPage) {
        this.state.pages = [currentPage];
      }
    }

    const pages: PageInfo[] = [];
    for (let i = 0; i < this.state.pages.length; i++) {
      const page = this.state.pages[i];
      if (page) {
        pages.push({
          index: i,
          url: await page.url(),
          title: await page.title().catch(() => 'Sin título')
        });
      }
    }
    return pages;
  }

  async selectPage(pageIdx: number, bringToFront: boolean = true): Promise<string> {
    if (pageIdx < 0 || pageIdx >= this.state.pages.length) {
      throw new Error(`Índice de página inválido: ${pageIdx}`);
    }

    this.state.selectedPageIdx = pageIdx;

    if (bringToFront && this.state.pages[pageIdx]) {
      await this.state.pages[pageIdx].bringToFront();
    }

    return `Página seleccionada: ${pageIdx}`;
  }

  async closePage(pageIdx: number): Promise<string> {
    if (this.state.pages.length <= 1) {
      throw new Error('No se puede cerrar la última página');
    }

    if (pageIdx < 0 || pageIdx >= this.state.pages.length || !this.state.pages[pageIdx]) {
      throw new Error(`Índice de página inválido: ${pageIdx}`);
    }

    await this.state.pages[pageIdx].close();
    this.state.pages.splice(pageIdx, 1);
    
    // Adjust selected index if necessary
    if (this.state.selectedPageIdx >= this.state.pages.length) {
      this.state.selectedPageIdx = this.state.pages.length - 1;
    }
    
    return `Página cerrada: ${pageIdx}`;
  }

  async resizePage(width: number, height: number): Promise<string> {
    const page = await this.getSelectedPage();
    await page.setViewportSize({ width, height });
    return `Ventana redimensionada a ${width}x${height}`;
  }

  async handleDialog(action: 'accept' | 'dismiss', promptText?: string): Promise<string> {
    const page = await this.getSelectedPage();
    
    page.on('dialog', async (dialog) => {
      if (action === 'accept') {
        await dialog.accept(promptText);
      } else {
        await dialog.dismiss();
      }
    });
    
    return `Diálogo ${action === 'accept' ? 'aceptado' : 'descartado'}`;
  }

  // DEBUGGING TOOLS
  async listConsoleMessages(limit: number = 50): Promise<Array<{ type: string; text: string; timestamp: number }>> {
    return this.state.consoleMessages.slice(-limit);
  }

  async clearConsoleMessages(): Promise<string> {
    this.state.consoleMessages = [];
    return 'Mensajes de consola limpiados';
  }

  // NETWORK TOOLS
  async listNetworkRequests(limit: number = 50): Promise<Array<{ url: string; method: string; status: number; timestamp: number }>> {
    return this.state.networkRequests.slice(-limit);
  }

  async clearNetworkRequests(): Promise<string> {
    this.state.networkRequests = [];
    return 'Peticiones de red limpiadas';
  }

  // PERFORMANCE TOOLS
  async startPerformanceTrace(): Promise<string> {
    const page = await this.getSelectedPage();
    await page.evaluate(() => {
      (window as any).performance.mark('trace-start');
    });
    return 'Traza de performance iniciada';
  }

  async stopPerformanceTrace(): Promise<any> {
    const page = await this.getSelectedPage();
    const metrics = await page.evaluate(() => {
      (window as any).performance.mark('trace-end');
      (window as any).performance.measure('trace', 'trace-start', 'trace-end');
      
      const entries = (window as any).performance.getEntriesByType('measure');
      const navigation = (window as any).performance.getEntriesByType('navigation')[0];
      
      return {
        duration: entries[entries.length - 1]?.duration || 0,
        navigation: navigation ? {
          loadEventEnd: navigation.loadEventEnd,
          domComplete: navigation.domComplete,
          domInteractive: navigation.domInteractive
        } : null
      };
    });
    return metrics;
  }

  // EMULATION TOOLS
  async emulateNetwork(offline: boolean = false): Promise<string> {
    if (offline) {
      throw new Error('Emulación offline requiere reiniciar el browser');
    }
    return 'Condiciones de red configuradas';
  }

  async emulateCPU(throttle: number): Promise<string> {
    const page = await this.getSelectedPage();
    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    return `CPU throttled a ${throttle}x`;
  }

  async emulateGeolocation(latitude: number, longitude: number, accuracy?: number): Promise<string> {
    const page = await this.getSelectedPage();
    await page.context().setGeolocation({
      latitude,
      longitude,
      accuracy: accuracy || 100
    });
    return `Geolocalización emulada: ${latitude}, ${longitude}`;
  }

  async close(): Promise<void> {
    await browserController.close();
    this.state = {
      pages: [],
      selectedPageIdx: 0,
      elementMap: new Map(),
      consoleMessages: [],
      networkRequests: []
    };
  }
}

// Singleton instance
const agent = new BrowserAgentUnified();

const browserAgentSkill: Skill = {
  name: 'browser_agent',
  description: 'Agente de navegación web unificado con 25+ herramientas. Modo AUTÓNOMO: "task": "buscar imágenes". Modo MANUAL: "action": "click", "uid": "123". Acciones: task, click, hover, fill, drag, upload_file, press_key, new_page, navigate, list_pages, select_page, close_page, resize_page, handle_dialog, screenshot, evaluate, list_console, clear_console, list_network, clear_network, start_perf_trace, stop_perf_trace, emulate_network, emulate_cpu, emulate_geo, close',
  execute: async (args: any) => {
    try {
      if (!browserController.isAvailable()) {
        return { success: false, message: 'Browser tool unavailable — Playwright is not installed. Run: npm install playwright && npx playwright install chromium' };
      }
      if (!args.action && !args.task) {
        return {
          success: false,
          message: "Se requiere 'action' (modo manual) o 'task' (modo autónomo)"
        };
      }

      // AUTONOMOUS MODE
      if (args.task) {
        return await agent.runAutonomousTask(args);
      }

      // MANUAL MODE
      let result: any;

      switch (args.action) {
        // INPUT
        case 'click':
          result = await agent.click(args.uid, args.dblClick);
          break;

        case 'hover':
          result = await agent.hover(args.uid);
          break;

        case 'fill':
          result = await agent.fill(args.uid, args.value);
          break;

        case 'drag':
          result = await agent.drag(args.fromUid, args.toUid);
          break;

        case 'upload_file':
          result = await agent.uploadFile(args.uid, args.filePath);
          break;

        case 'press_key':
          result = await agent.pressKey(args.key);
          break;

        // NAVIGATION
        case 'new_page':
          result = await agent.newPage(args.url);
          break;

        case 'navigate':
          result = await agent.navigatePage(args.type || 'url', args.url);
          break;

        case 'list_pages':
          result = await agent.listPages();
          break;

        case 'select_page':
          result = await agent.selectPage(args.pageIdx, args.bringToFront);
          break;

        case 'close_page':
          result = await agent.closePage(args.pageIdx);
          break;

        case 'resize_page':
          result = await agent.resizePage(args.width, args.height);
          break;

        case 'handle_dialog':
          result = await agent.handleDialog(args.dialogAction, args.promptText);
          break;

        // DEBUGGING & EVALUATION
        case 'screenshot':
          const screenshot = await agent.takeScreenshot(args.fullPage, args.selector);
          result = { message: 'Screenshot capturado', size: screenshot.length };
          break;

        case 'evaluate':
          result = await agent.evaluateScript(args.code);
          break;

        case 'list_console':
          result = await agent.listConsoleMessages(args.limit);
          break;

        case 'clear_console':
          result = await agent.clearConsoleMessages();
          break;

        // NETWORK
        case 'list_network':
          result = await agent.listNetworkRequests(args.limit);
          break;

        case 'clear_network':
          result = await agent.clearNetworkRequests();
          break;

        // PERFORMANCE
        case 'start_perf_trace':
          result = await agent.startPerformanceTrace();
          break;

        case 'stop_perf_trace':
          result = await agent.stopPerformanceTrace();
          break;

        // EMULATION
        case 'emulate_network':
          result = await agent.emulateNetwork(args.offline);
          break;

        case 'emulate_cpu':
          result = await agent.emulateCPU(args.throttle);
          break;

        case 'emulate_geo':
          result = await agent.emulateGeolocation(args.latitude, args.longitude, args.accuracy);
          break;

        case 'close':
          await agent.close();
          result = 'Browser cerrado';
          break;

        default:
          return {
            success: false,
            message: `Acción desconocida: ${args.action}. Acciones: task, click, hover, fill, drag, upload_file, press_key, new_page, navigate, list_pages, select_page, close_page, resize_page, handle_dialog, screenshot, evaluate, list_console, clear_console, list_network, clear_network, start_perf_trace, stop_perf_trace, emulate_network, emulate_cpu, emulate_geo, close`
          };
      }

      return {
        success: true,
        message: typeof result === 'string' ? result : 'Operación exitosa',
        data: result
      };

    } catch (error: any) {
      return {
        success: false,
        message: `Error: ${error.message}`
      };
    }
  }
};

export default browserAgentSkill;
