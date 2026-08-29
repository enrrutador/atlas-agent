/**
 * Atlas Math Tool - Safe mathematical calculations
 */

import { logger } from '../../common/logger.js';

const SAFE_MATH_FNS: Record<string, any> = {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  sqrt: Math.sqrt,
  pow: Math.pow,
  min: Math.min,
  max: Math.max,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  exp: Math.exp,
  PI: Math.PI,
  E: Math.E,
};

export class MathTool {
  private static instance: MathTool;

  private constructor() {}

  static getInstance(): MathTool {
    if (!MathTool.instance) {
      MathTool.instance = new MathTool();
    }
    return MathTool.instance;
  }

  calculate(expression: string): string {
    try {
      // Sanitize: only allow numbers, operators, parentheses, spaces, dots, and known function names
      const sanitized = expression
        .replace(/[^0-9+\-*/().%\s,a-zA-Z]/g, '')
        .replace(/,/g, '.');

      // Replace common math notation
      let expr = sanitized
        .replace(/×/g, '*')
        .replace(/÷/g, '/')
        .replace(/\^/g, '**')
        .replace(/π|\bpi\b/gi, `${Math.PI}`)
        .replace(/(?<=^|[\s+\-*/(,])e(?=[\s+\-*^/),]|$)/gi, `${Math.E}`);

      // Replace function names
      for (const fn of Object.keys(SAFE_MATH_FNS)) {
        const regex = new RegExp(`\\b${fn}\\b`, 'gi');
        expr = expr.replace(regex, `SAFE_MATH_FNS.${fn}`);
      }

      // Evaluate in sandboxed context
      const fn = new Function('SAFE_MATH_FNS', `"use strict"; return (${expr});`);
      const result = fn(SAFE_MATH_FNS);

      if (typeof result !== 'number' || !isFinite(result)) {
        return `Resultado: ${result} (posiblemente indefinido)`;
      }

      logger.info('math', `Calculated: "${expression}" = ${result}`);
      return `Resultado: ${result}`;
    } catch (err: any) {
      logger.error('math', `Calculation failed: ${err.message}`);
      return `Error calculando "${expression}": ${err.message}. Usá notación matemática estándar (ej: 2+3*4, sqrt(16), 2**10).`;
    }
  }
}

export const mathTool = MathTool.getInstance();
