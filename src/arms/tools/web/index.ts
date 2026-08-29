import { searchEngine } from './searchengine.js';
import { scraper } from './scraper.js';
import { downloadManager } from './downloader.js';
import { SearchOptions } from './types.js';
import { webCache } from './cache.js';

export class WebTool {
  private static instance: WebTool;

  private constructor() {}

  static getInstance(): WebTool {
    if (!WebTool.instance) {
      WebTool.instance = new WebTool();
    }
    return WebTool.instance;
  }

  async search(query: string, type: string = 'web', count: number = 8): Promise<string> {
    const cleanQ = this.cleanSearchQuery(query);
    const enhanced = this.enhanceQuery(cleanQ, type);
    const opts: SearchOptions = { type: type as any, count };
    const results = await searchEngine.search(enhanced, opts);

    if (results.length === 0) {
      return `No encontré nada sobre "${cleanQ}". Probá con otras palabras.`;
    }

    const topResults = results.slice(0, count);
    const isWeather = /clima|pron[oó]stico|temperatura|weather|lluvia|lluvioso|soleado|nublado|temp|tiemp/.test(cleanQ);

    if (isWeather) {
      const weatherSite = this.findWeatherSite(topResults);
      if (weatherSite) {
        try {
          const data = await this.tryScrapeWeather(weatherSite, cleanQ);
          if (data) return data;
        } catch {}
      }
      const snippetData = this.formatWeatherFromSnippets(cleanQ, topResults);
      if (snippetData) return snippetData;
      return this.formatWeatherFallback(cleanQ, topResults);
    }

    return this.formatGeneralResults(cleanQ, topResults);
  }

  private cleanSearchQuery(query: string): string {
    let clean = query
      .replace(/^(decime|dame|contame|mu[ée]strame|mostrame|necesito|quiero|quisiera|pod[eé]s|busc[áa]|buscar|averigu[áa]|encontr[áa]|investig[áa]|decir|dime|cu[ée]ntame|hacete|haceme|hacéme)\s+/i, '')
      .replace(/\s*(por\s*favor|porfa|pls|please|gracias|thank)\s*$/i, '')
      .trim();
    return clean || query;
  }

  private findWeatherSite(results: any[]): any | null {
    return results.find(r => {
      const url = r.url.toLowerCase();
      const title = r.title.toLowerCase();
      return !url.includes('wikipedia') &&
        !url.includes('instagram') &&
        !title.includes('noticias') &&
        (url.includes('weather') || url.includes('accuweather') ||
         url.includes('meteored') || url.includes('tiempo') ||
         url.includes('clima') || url.includes('eltiempo') ||
         title.includes('pronóstico') || title.includes('weather') ||
         title.includes('tiempo') || title.includes('clima') ||
         title.includes('meteored'));
    });
  }

  private extractLocation(query: string): string {
    let clean = query
      .replace(/^(?:el|la|los|las|un|una)\s+/i, '')
      .replace(/\b(?:clima|pron[oó]stico|temperatura|weather|temp|hoy|ahora|actual|mañana|finde|semana|d[ií]a|tiempo|para|decime|dame|contame|necesito|quiero|quisiera|pod[eé]s|busc[áa]r?|averigu[áa]r?)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    const locMatch = clean.match(/\b(?:en|de)\s+(?:el|la|los|las)?\s*(.+?)\s*$/i);
    if (locMatch) return locMatch[1].trim();
    const words = clean.split(/\s+/).filter(w => !/^(en|de|para|el|la|los|las|un|una|por|con|sin|y|e|o|a)$/i.test(w));
    return words.filter(w => w.length > 2).join(' ') || '';
  }

  private async tryScrapeWeather(site: any, query: string): Promise<string | null> {
    const result = await scraper.scrape(site.url, { depth: 'basic', extractLinks: false });
    const text = result.content || result.excerpt || '';

    const tempMatch = text.match(/\b\d{1,2}\s*°\s*[CFcf]\b/);
    const feelsLike = text.match(/(?:sensaci[oó]n|sensacion|feels\s+like|real\s+feel|sensación\s+t[eé]rmica)[^\d]{0,10}(\d{1,2})/i);
    const conditionMatch = text.match(/(?:mayormente\s+)?(solead[oá]|nublad[oá]|lluvia|lluvios[oá]|despejad[oá]|parcialmente\s+nublad[oá]|tormenta|nevada|vient[oó]|h[uú]med[oó]|c[aá]lid[oó]|fr[íi]o|cubiert[oó]|chubascos?|tormentas?\s*el[eé]ctricas?|neblina|bruma|granizo|tornado|hurac[aá]n|vendaval)/i);
    const humidityMatch = text.match(/(?:humedad|humidity)[^\d]{0,5}(\d{1,3})/i);
    const windMatch = text.match(/(?:viento|wind)[^\d]{0,5}(\d{1,3})/i);

    const location = this.extractLocation(query) || 'tu zona';

    if (tempMatch || conditionMatch) {
      let weather = `🌤️ **Clima en ${location}**`;
      if (tempMatch) weather += `\n🌡️ Temperatura: ${tempMatch[0]}`;
      if (feelsLike) weather += `\n🤔 Sensación térmica: ${feelsLike[1]}°`;
      if (conditionMatch) weather += `\n☁️ ${conditionMatch[1].toLowerCase()}`;
      if (humidityMatch) weather += `\n💧 Humedad: ${humidityMatch[1]}%`;
      if (windMatch) weather += `\n💨 Viento: ${windMatch[1]} km/h`;
      weather += `\n\n📡 Fuente: ${site.title}`;
      weather += `\n\n¿Querés que vea el pronóstico extendido o algo más?`;
      return weather;
    }
    return null;
  }

  private formatWeatherFromSnippets(query: string, results: any[]): string | null {
    const location = this.extractLocation(query) || 'tu zona';
    const parts: string[] = [];
    for (const r of results) {
      if (r.snippet && (r.title.toLowerCase().includes('tiempo') ||
          r.title.toLowerCase().includes('clima') ||
          r.title.toLowerCase().includes('pronóstico') ||
          r.title.toLowerCase().includes('pronostico'))) {
        const tempMatch = r.snippet.match(/\b\d{1,3}\s*°\s*[CFcf]\b/);
        const condMatch = r.snippet.match(/(?:mayormente\s+)?(solead[oá]|nublad[oá]|lluvia|lluvios[oá]|despejad[oá]|parcialmente\s+nublad[oá]|tormenta|nevada|vient[oó]|h[uú]med[oó]|c[aá]lid[oó]|fr[íi]o|cubiert[oó]|chubasco|tormenta\s*el[eé]ctrica|neblina|bruma|granizo)/i);
        if (tempMatch || condMatch) {
          let info = '';
          if (tempMatch) info += `🌡️ ${tempMatch[0]}`;
          if (condMatch) info += `${info ? ' | ' : ''}☁️ ${condMatch[1].toLowerCase()}`;
          parts.push(`• ${r.title}: ${info}`);
        }
      }
    }
    if (parts.length > 0) {
      return `🌤️ **Clima en ${location}** — según distintas fuentes:\n\n${parts.join('\n')}\n\n¿Querés que revise algún pronóstico en detalle?`;
    }
    return null;
  }

  private formatWeatherFallback(query: string, results: any[]): string {
    const location = this.extractLocation(query) || 'tu zona';
    const weatherResults = results.filter(r => {
      const t = (r.title + ' ' + (r.snippet || '')).toLowerCase();
      return t.includes('tiempo') || t.includes('clima') || t.includes('pronóstico') || t.includes('temperatura') || t.includes('weather');
    });
    const use = weatherResults.length > 0 ? weatherResults : results.slice(0, 3);
    let resp = `🌤️ Información del clima en ${location}:\n\n`;
    resp += use.slice(0, 3).map((r, i) => {
      let text = `${i + 1}. **${r.title}**`;
      if (r.snippet) text += `\n   ${r.snippet.replace(/\s+/g, ' ').slice(0, 200)}`;
      return text;
    }).join('\n\n');
    resp += `\n\n¿Querés que revise alguno con más detalle?`;
    return resp;
  }

  private formatGeneralResults(query: string, results: any[]): string {
    const top = results.slice(0, 5);
    let resp = `${query}:\n\n`;
    resp += top.map((r, i) => {
      let text = `${i + 1}. **${r.title}**`;
      if (r.snippet) text += `\n   ${r.snippet.replace(/\s+/g, ' ').slice(0, 250)}`;
      return text;
    }).join('\n\n');
    resp += `\n\n¿Querés que profundice en alguno?`;
    return resp;
  }

  private enhanceQuery(query: string, _type: string): string {
    const lower = query.toLowerCase();
    const weatherWords = /clima|pron[oó]stico|temperatura|weather|lluvia|soleado|nublado|temp|tiemp/i;

    if (weatherWords.test(lower)) {
      if (!lower.includes('hoy') && !lower.includes('ahora') && !lower.includes('actual')) {
        return `${query} hoy`;
      }
      return query;
    }

    if (/noticia|ultim|breaking|novedad|actualidad/i.test(lower)) {
      return query;
    }

    return query;
  }

  async scrape(url: string, depth: string = 'full'): Promise<string> {
    const result = await scraper.scrape(url, { depth: depth as any, extractLinks: true });

    let output = '';
    if (result.title) output += `# ${result.title}\n\n`;
    if (result.excerpt) output += `${result.excerpt}\n\n`;
    if (result.byline) output += `Autor: ${result.byline}\n`;
    if (result.publishedDate) output += `Fecha: ${result.publishedDate}\n`;
    if (result.siteName) output += `Sitio: ${result.siteName}\n`;
    if (result.textLength > 300) {
      output += `[+${result.textLength - 300} caracteres más]\n\n`;
    }
    if (result.links.length > 0) {
      const topLinks = result.links.slice(0, 5);
      output += `\nEnlaces:\n${topLinks.map(l => `  • ${l.text.slice(0, 80)} → ${l.href}`).join('\n')}`;
    }
    if (result.jsonLd.length > 0) {
      output += `\nDatos: ${JSON.stringify(result.jsonLd[0]).slice(0, 300)}`;
    }

    return output.trim();
  }

  async download(url: string, destDir: string = './downloads', fileName?: string): Promise<string> {
    const result = await downloadManager.download(url, destDir, { fileName });
    if (result.success) {
      return `Descargado: ${result.fileName}\nDestino: ${result.destPath}\nTamaño: ${(result.fileSize / 1024).toFixed(1)} KB\nTiempo: ${(result.elapsedMs / 1000).toFixed(1)}s`;
    }
    return `Error descargando ${url}: ${result.error || 'Desconocido'}`;
  }

  async discover(url: string): Promise<string> {
    try {
      const result = await scraper.scrape(url, { depth: 'basic', extractLinks: true });
      let output = `# Enlaces descubiertos en ${url}\n\n`;
      if (result.title) output += `Pagina: ${result.title}\n`;
      output += `Total enlaces: ${result.links.length}\n`;
      output += `Total imagenes: ${result.images.length}\n`;
      if (result.links.length > 0) {
        output += `\nTop enlaces:\n${result.links.slice(0, 15).map(l => `  • ${l.text.slice(0, 60)} → ${l.href}`).join('\n')}`;
      }
      return output;
    } catch (err) {
      return `Error descubriendo enlaces en ${url}: ${(err as Error).message}`;
    }
  }

  cacheStats(): string {
    return `Cache entries: ${webCache.size}`;
  }
}

export const webTool = WebTool.getInstance();
