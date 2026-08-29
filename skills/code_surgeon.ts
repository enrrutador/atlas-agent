import type { Skill } from '../src/core/skills.js';
import fs from 'fs';
import path from 'path';

/**
 * code_surgeon — Precise surgical code editing
 *
 * Actions:
 *   read    — read file with line numbers (optional range)
 *   edit    — replace exact text (unique match required)
 *   create  — create a new file (fails if already exists unless force: true)
 *   list    — list files in a directory with optional extension filter
 *   delete  — delete a file (requires explicit confirmation)
 */

const codeSurgeonSkill: Skill = {
    name: 'code_surgeon',
    description: 'Ediciones quirúrgicas precisas en archivos de código. Acciones: read, edit, create, list, delete. JSON Args: { "action": "read", "filePath": "ruta.ts", "startLine": 1, "endLine": 100 } | { "action": "edit", "filePath": "ruta.ts", "target": "texto_exacto", "replacement": "nuevo_texto" } | { "action": "create", "filePath": "ruta.ts", "content": "contenido", "force": false } | { "action": "list", "dirPath": "src/", "extensions": [".ts"], "recursive": false } | { "action": "delete", "filePath": "ruta.ts", "confirm": true }',
    execute: async (args: {
        action: 'read' | 'edit' | 'create' | 'list' | 'delete';
        filePath?: string;
        dirPath?: string;
        startLine?: number;
        endLine?: number;
        target?: string;
        replacement?: string;
        content?: string;
        force?: boolean;
        extensions?: string[];
        recursive?: boolean;
        confirm?: boolean;
    }) => {
        const { action } = args;

        try {
            // ── READ ──────────────────────────────────────────────────────────
            if (action === 'read') {
                const { filePath, startLine, endLine } = args;
                if (!filePath) return { success: false, message: "Se requiere 'filePath'" };

                const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
                if (!fs.existsSync(fullPath)) {
                    return { success: false, message: `El archivo no existe: ${filePath}` };
                }

                const content = fs.readFileSync(fullPath, 'utf-8');
                const lines = content.split('\n');
                const start = startLine ? Math.max(1, startLine) : 1;
                const end = endLine ? Math.min(lines.length, endLine) : lines.length;
                const slicedLines = lines.slice(start - 1, end);
                const numberedContent = slicedLines.map((line, index) => `${start + index}: ${line}`).join('\n');

                return {
                    success: true,
                    message: `Leídas líneas ${start}-${end} de ${filePath} (total: ${lines.length})`,
                    content: numberedContent,
                    totalLines: lines.length,
                };
            }

            // ── EDIT ──────────────────────────────────────────────────────────
            if (action === 'edit') {
                const { filePath, target, replacement } = args;
                if (!filePath) return { success: false, message: "Se requiere 'filePath'" };
                if (!target || replacement === undefined) {
                    return { success: false, message: "Para editar se requiere 'target' y 'replacement'." };
                }

                const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
                if (!fs.existsSync(fullPath)) {
                    return { success: false, message: `El archivo no existe: ${filePath}` };
                }

                const content = fs.readFileSync(fullPath, 'utf-8');
                const occurrences = content.split(target).length - 1;

                if (occurrences === 0) {
                    return { success: false, message: "No se encontró el 'target' exacto. Verificá espacios y saltos de línea." };
                }
                if (occurrences > 1) {
                    return { success: false, message: `Se encontraron ${occurrences} coincidencias. El target debe ser único.` };
                }

                const newContent = content.replace(target, replacement);
                fs.writeFileSync(fullPath, newContent, 'utf-8');

                return {
                    success: true,
                    message: `✅ Edición aplicada en ${filePath}`,
                    change: `"${target.slice(0, 60)}${target.length > 60 ? '...' : ''}" → nuevo contenido`,
                };
            }

            // ── CREATE ────────────────────────────────────────────────────────
            if (action === 'create') {
                const { filePath, content = '', force = false } = args;
                if (!filePath) return { success: false, message: "Se requiere 'filePath'" };

                const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);

                if (fs.existsSync(fullPath) && !force) {
                    return {
                        success: false,
                        message: `El archivo ya existe: ${filePath}. Usá force: true para sobreescribir.`,
                    };
                }

                // Create parent directories if needed
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                fs.writeFileSync(fullPath, content, 'utf-8');

                return {
                    success: true,
                    message: `✅ Archivo creado: ${filePath} (${content.length} chars)`,
                    filePath,
                    size: content.length,
                };
            }

            // ── LIST ──────────────────────────────────────────────────────────
            if (action === 'list') {
                const { dirPath = '.', extensions, recursive = false } = args;
                const fullDir = path.isAbsolute(dirPath) ? dirPath : path.join(process.cwd(), dirPath);

                if (!fs.existsSync(fullDir)) {
                    return { success: false, message: `Directorio no existe: ${dirPath}` };
                }

                const files: Array<{ path: string; size: number; modified: string }> = [];

                function walk(dir: string, relBase: string) {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const relPath = path.join(relBase, entry.name);
                        const fullPath = path.join(dir, entry.name);

                        if (entry.isDirectory()) {
                            if (recursive && entry.name !== 'node_modules' && entry.name !== '.git') {
                                walk(fullPath, relPath);
                            }
                        } else if (entry.isFile()) {
                            const ext = path.extname(entry.name).toLowerCase();
                            if (!extensions || extensions.includes(ext)) {
                                const stat = fs.statSync(fullPath);
                                files.push({
                                    path: relPath,
                                    size: stat.size,
                                    modified: new Date(stat.mtime).toISOString().slice(0, 16),
                                });
                            }
                        }
                    }
                }

                walk(fullDir, '');

                const formatted = files
                    .map(f => `${f.path} (${(f.size / 1024).toFixed(1)}KB, ${f.modified})`)
                    .join('\n');

                return {
                    success: true,
                    message: `${files.length} archivos en ${dirPath}`,
                    files,
                    formatted,
                };
            }

            // ── DELETE ────────────────────────────────────────────────────────
            if (action === 'delete') {
                const { filePath, confirm = false } = args;
                if (!filePath) return { success: false, message: "Se requiere 'filePath'" };
                if (!confirm) {
                    return { success: false, message: "Para eliminar un archivo, pasá confirm: true explícitamente." };
                }

                const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
                if (!fs.existsSync(fullPath)) {
                    return { success: false, message: `El archivo no existe: ${filePath}` };
                }

                fs.unlinkSync(fullPath);
                return { success: true, message: `✅ Archivo eliminado: ${filePath}` };
            }

            return { success: false, message: `Acción no reconocida: '${action}'. Usá: read, edit, create, list, delete` };

        } catch (error: any) {
            return { success: false, message: `Error en code_surgeon: ${error.message}` };
        }
    }
};

export default codeSurgeonSkill;
