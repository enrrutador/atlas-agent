import type { Skill } from '../src/core/skills.js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import path from 'path';
import fs from 'fs';
import os from 'os';

class HumanImageDownloader {
  private browser: any = null;
  private context: any = null;
  private page: any = null;
  private downloadPath: string = '';
  private readonly TIMEOUT_MS = 45000; // 45 segundos max

  constructor() {}

  private async humanDelay(min: number = 800, max: number = 2000): Promise<void> {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  public async init(downloadPath: string): Promise<void> {
    this.downloadPath = downloadPath;
    
    if (!fs.existsSync(downloadPath)) {
      fs.mkdirSync(downloadPath, { recursive: true });
      console.log(`[HUMAN_DOWNLOADER] Carpeta creada: ${downloadPath}`);
    }

    console.log(`[HUMAN_DOWNLOADER] Iniciando navegador...`);

    let pw: any;
    try {
      // @ts-ignore - playwright-extra is optional
      pw = await import('playwright-extra');
    } catch {
      throw new Error('Playwright not installed. Run: npm install playwright-extra playwright && npx playwright install chromium');
    }

    this.browser = await pw.chromium.launch({
      headless: false,
      args: [
        '--window-size=800,1080',
        '--window-position=1120,0',
        '--no-default-browser-check',
        '--disable-infobars',
      ]
    });

    this.context = await this.browser.newContext({
      viewport: { width: 800, height: 1080 },
      acceptDownloads: true,
    });

    this.page = await this.context.newPage();
    await this.humanDelay(1000, 1500);
  }

  public async searchImage(query: string): Promise<boolean> {
    if (!this.page) throw new Error('Navegador no inicializado');

    console.log(`[HUMAN_DOWNLOADER] Buscando: "${query}"`);

    try {
      // Ir a Google Images con timeout
      await Promise.race([
        this.page.goto('https://www.google.com/imghp', { waitUntil: 'domcontentloaded' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout navegando a Google Images')), 15000))
      ]);
      
      await this.humanDelay(1500, 2500);

      // Buscar campo de búsqueda
      const searchBox = await this.page.$('input[name="q"]');
      if (!searchBox) {
        console.log('[HUMAN_DOWNLOADER] No se encontró campo de búsqueda');
        return false;
      }

      // Click y escribir
      await searchBox.click();
      await this.humanDelay(300, 600);
      
      for (const char of query) {
        await this.page.keyboard.type(char, { delay: Math.random() * 80 + 40 });
      }
      
      await this.humanDelay(500, 1000);
      await this.page.keyboard.press('Enter');
      await this.humanDelay(3000, 5000);

      return true;
    } catch (e: any) {
      console.error(`[HUMAN_DOWNLOADER ERROR] ${e.message}`);
      return false;
    }
  }

  public async downloadFirstImage(): Promise<string | null> {
    if (!this.page) return null;

    try {
      // Esperar que carguen imágenes
      await this.page.waitForSelector('img', { timeout: 10000 });
      await this.humanDelay(2000, 3000);

      // Encontrar imágenes visibles (no logos/iconos)
      const images = await this.page.$$eval('img', (imgs) => {
        return imgs
          .filter(img => {
            const rect = img.getBoundingClientRect();
            return rect.width > 150 && 
                   rect.height > 150 && 
                   img.src &&
                   !img.src.includes('logo') &&
                   !img.src.includes('icon') &&
                   img.src.startsWith('http');
          })
          .slice(0, 5)
          .map((img, i) => ({
            index: i,
            src: img.src,
            alt: img.alt || '',
            width: img.naturalWidth,
            height: img.naturalHeight
          }));
      });

      if (images.length === 0) {
        console.log('[HUMAN_DOWNLOADER] No se encontraron imágenes válidas');
        return null;
      }

    // Seleccionar primera imagen válida
    const selectedImage = images[0];
    if (!selectedImage) {
      console.log('[HUMAN_DOWNLOADER] No se encontraron imágenes válidas');
      return null;
    }
    console.log(`[HUMAN_DOWNLOADER] Imagen seleccionada: ${selectedImage.src.substring(0, 80)}...`);

      // Determinar extensión
      const ext = selectedImage.src.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i)?.[1] || 'jpg';
      const fileName = `imagen_${Date.now()}.${ext}`;
      const finalPath = path.join(this.downloadPath, fileName);

      // Descargar usando fetch nativo
      console.log(`[HUMAN_DOWNLOADER] Descargando...`);
      
      const response = await Promise.race([
        fetch(selectedImage.src, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout descargando imagen')), 20000))
      ]) as Response;

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      fs.writeFileSync(finalPath, Buffer.from(buffer));

      // Verificar
      const stats = fs.statSync(finalPath);
      if (stats.size < 1000) {
        fs.unlinkSync(finalPath);
        throw new Error('Archivo descargado está vacío o corrupto');
      }

      console.log(`[HUMAN_DOWNLOADER] Descargada: ${finalPath} (${Math.round(stats.size/1024)}KB)`);
      return finalPath;

    } catch (e: any) {
      console.error(`[HUMAN_DOWNLOADER ERROR] ${e.message}`);
      return null;
    }
  }

  public async close(): Promise<void> {
    if (this.page) {
      await this.page.close().catch(() => {});
    }
    if (this.browser) {
      await this.browser.close();
      console.log('[HUMAN_DOWNLOADER] Navegador cerrado');
    }
  }
}

const humanImageDownloaderSkill: Skill = {
  name: 'human_image_downloader',
  description: 'BUSCA Y DESCARGA IMÁGENES DE INTERNET (Google Images). USAR ESTA SKILL cuando el usuario pide buscar o descargar una imagen de cualquier tema (animales, paisajes, objetos, etc.). NO usar para productos de Coto. JSON Args: { "query": "texto de búsqueda descriptivo", "downloadPath": "C:/Users/Marcelo/Pictures/mis_imagenes" }',
  
  execute: async (args: { query: string, downloadPath?: string }) => {
    const downloader = new HumanImageDownloader();
    const downloadPath = args.downloadPath || path.join(os.homedir(), 'Pictures', 'Atlas_Downloads');

    // Timeout global
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Timeout: Operación excedió 60 segundos')), 60000);
    });

    const taskPromise = (async () => {
      try {
        console.log(`[HUMAN_IMAGE_DOWNLOADER] === INICIANDO ===`);
        console.log(`[HUMAN_IMAGE_DOWNLOADER] Búsqueda: "${args.query}"`);
        console.log(`[HUMAN_IMAGE_DOWNLOADER] Destino: ${downloadPath}`);

        await downloader.init(downloadPath);
        
        const searchSuccess = await downloader.searchImage(args.query);
        if (!searchSuccess) {
          return {
            success: false,
            message: 'No se pudo realizar la búsqueda. Intenta con otros términos.',
            query: args.query
          };
        }

        const downloadedPath = await downloader.downloadFirstImage();

        if (downloadedPath) {
          return {
            success: true,
            message: `Imagen descargada exitosamente`,
            path: downloadedPath,
            query: args.query
          };
        } else {
          return {
            success: false,
            message: 'No se pudo descargar la imagen. Intenta con otros términos de búsqueda.',
            query: args.query
          };
        }

      } catch (error: any) {
        console.error(`[HUMAN_IMAGE_DOWNLOADER ERROR] ${error.message}`);
        return {
          success: false,
          message: `Error: ${error.message}`,
          query: args.query
        };
      } finally {
        await downloader.close().catch(() => {});
      }
    })();

    try {
      return await Promise.race([taskPromise, timeoutPromise]);
    } catch (timeoutError: any) {
      await downloader.close().catch(() => {});
      return {
        success: false,
        message: 'La operación tomó demasiado tiempo (timeout). Intenta de nuevo.',
        query: args.query
      };
    }
  }
};

export default humanImageDownloaderSkill;
