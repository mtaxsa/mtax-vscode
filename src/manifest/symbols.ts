import * as fs from 'fs';
import * as path from 'path';

import { scanLua, declaredNames } from '../util/lua';
import { globMatches, hasGlob, isCrossResourceEntry } from './parse';
import { FileLists } from './side';

export interface ResourceSymbols {
    names: Set<string>;
    events: Set<string>;
    borrows: boolean;
}

interface CacheEntry {
    symbols: ResourceSymbols;
    stamp: number;
    fileCount: number;
}

const cache = new Map<string, CacheEntry>();

export function resolveScripts(root: string, lists: FileLists): string[] {
    const declared: string[] = [];
    const globs: string[] = [];

    for (const key of ['server_files', 'client_files', 'shared_files']) {
        for (const entry of lists[key] ?? []) {
            if (isCrossResourceEntry(entry)) continue;
            if (hasGlob(entry)) globs.push(entry);
            else declared.push(entry);
        }
    }

    const out = new Set<string>();
    for (const rel of declared) {
        const abs = path.join(root, ...rel.split('/'));
        if (fs.existsSync(abs)) out.add(abs);
    }

    if (globs.length) {
        for (const abs of walkLua(root)) {
            const rel = path.relative(root, abs).split(path.sep).join('/');
            if (globs.some((g) => globMatches(g, rel))) out.add(abs);
        }
    }

    return [...out];
}

function walkLua(dir: string, out: string[] = [], depth = 0): string[] {
    if (depth > 8) return out;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkLua(full, out, depth + 1);
        else if (entry.name.toLowerCase().endsWith('.lua')) out.push(full);
    }
    return out;
}

export function symbolsOf(root: string, lists: FileLists): ResourceSymbols {
    const files = [...new Set([...resolveScripts(root, lists), ...walkLua(root)])];
    const borrows = Object.values(lists).some((entries) => entries.some(isCrossResourceEntry));

    let stamp = 0;
    for (const file of files) {
        try { stamp = Math.max(stamp, fs.statSync(file).mtimeMs); } catch { /* vanished */ }
    }

    const cached = cache.get(root);
    if (cached && cached.stamp === stamp && cached.fileCount === files.length) return cached.symbols;

    const names = new Set<string>();
    const events = new Set<string>();

    for (const file of files) {
        let text: string;
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        if (text.length > 2_000_000) continue;

        const scan = scanLua(text);
        for (const name of declaredNames(scan.masked)) names.add(name);

        for (const m of scan.masked.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=[^=]/gm)) names.add(m[1]);
        for (const m of scan.masked.matchAll(/\bfunction\s+([A-Za-z_][A-Za-z0-9_.]*)/g)) {
            names.add(m[1].split('.')[0]);
        }

        for (const literal of scan.strings) {
            const before = scan.masked.slice(Math.max(0, literal.start - 24), literal.start);
            if (/\baddEvent\s*\(\s*$/.test(before)) events.add(literal.value);
        }
    }

    const symbols: ResourceSymbols = { names, events, borrows };
    cache.set(root, { symbols, stamp, fileCount: files.length });
    return symbols;
}

export function clearSymbolCache(): void {
    cache.clear();
}
