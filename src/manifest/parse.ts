import { scanLua, LuaScan, LuaString } from '../util/lua';

export interface ManifestEntry {
    value: string;
    start: number;
    end: number;
    contentStart: number;
    contentEnd: number;
}

export interface ManifestAssignment {
    key: string;
    keyStart: number;
    keyEnd: number;
    valueStart: number;
    valueEnd: number;
    kind: 'string' | 'list' | 'boolean' | 'table' | 'other';
    string?: ManifestEntry;
    list?: ManifestEntry[];
    boolean?: boolean;
    table?: { key: string; value: ManifestEntry }[];
}

export interface ParsedManifest {
    text: string;
    scan: LuaScan;
    assignments: ManifestAssignment[];
    byKey: Map<string, ManifestAssignment>;
}

const FILE_LIST_KEYS = ['server_files', 'client_files', 'shared_files', 'files', 'map_files'] as const;
export type FileListKey = (typeof FILE_LIST_KEYS)[number];
export const FILE_LIST_KEY_NAMES: readonly string[] = FILE_LIST_KEYS;
export const SCRIPT_LIST_KEYS: readonly string[] = ['server_files', 'client_files', 'shared_files'];

function toEntry(s: LuaString): ManifestEntry {
    return {
        value: s.value,
        start: s.start,
        end: s.end,
        contentStart: s.contentStart,
        contentEnd: s.contentEnd,
    };
}

function matchBrace(masked: string, open: number): number {
    let depth = 0;
    for (let i = open; i < masked.length; i++) {
        const c = masked[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    }
    return masked.length;
}

export function parseManifest(text: string): ParsedManifest {
    const scan = scanLua(text);
    const masked = scan.masked;
    const assignments: ManifestAssignment[] = [];
    const byKey = new Map<string, ManifestAssignment>();

    const re = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked))) {
        const key = m[1];
        const keyStart = m.index + m[0].indexOf(key);
        const keyEnd = keyStart + key.length;
        let valueStart = m.index + m[0].length;
        while (valueStart < text.length && (text[valueStart] === ' ' || text[valueStart] === '\t')) valueStart++;
        const head = text[valueStart];

        const inRange = (s: LuaString, from: number, to: number) => s.start >= from && s.end <= to;

        if (head === '{') {
            const valueEnd = matchBrace(masked, valueStart);
            const inner = scan.strings.filter((s) => inRange(s, valueStart, valueEnd));
            const pairRe = /([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/g;
            const region = masked.slice(valueStart, valueEnd);
            const pairs: { key: string; value: ManifestEntry }[] = [];
            let p: RegExpExecArray | null;
            while ((p = pairRe.exec(region))) {
                let at = valueStart + p.index + p[0].length;
                while (at < text.length && (text[at] === ' ' || text[at] === '\t')) at++;
                const lit = inner.find((s) => s.start === at);
                if (lit) pairs.push({ key: p[1], value: toEntry(lit) });
            }
            const a: ManifestAssignment = {
                key, keyStart, keyEnd, valueStart, valueEnd,
                kind: pairs.length ? 'table' : 'list',
                list: inner.map(toEntry),
                table: pairs.length ? pairs : undefined,
            };
            assignments.push(a);
            byKey.set(key, a);
            re.lastIndex = valueEnd;
            continue;
        }

        const literal = scan.strings.find((s) => s.start === valueStart);
        if (literal) {
            const a: ManifestAssignment = {
                key, keyStart, keyEnd, valueStart, valueEnd: literal.end,
                kind: 'string', string: toEntry(literal),
            };
            assignments.push(a);
            byKey.set(key, a);
            re.lastIndex = literal.end;
            continue;
        }

        const boolMatch = masked.slice(valueStart).match(/^(true|false)\b/);
        if (boolMatch) {
            const a: ManifestAssignment = {
                key, keyStart, keyEnd, valueStart, valueEnd: valueStart + boolMatch[1].length,
                kind: 'boolean', boolean: boolMatch[1] === 'true',
            };
            assignments.push(a);
            byKey.set(key, a);
            continue;
        }

        let lineEnd = masked.indexOf('\n', valueStart);
        if (lineEnd === -1) lineEnd = masked.length;
        const a: ManifestAssignment = {
            key, keyStart, keyEnd, valueStart, valueEnd: lineEnd, kind: 'other',
        };
        assignments.push(a);
        byKey.set(key, a);
    }

    return { text, scan, assignments, byKey };
}

export function isSafeRelativePath(p: string): boolean {
    if (!p || p.startsWith('/')) return false;
    if (p.includes('\\') || p.includes(':')) return false;
    for (const segment of p.split('/')) {
        if (segment === '' || segment === '.' || segment === '..') return false;
    }
    return true;
}

export function isLuaPath(p: string): boolean {
    return p.toLowerCase().endsWith('.lua');
}

export function isCrossResourceEntry(p: string): boolean {
    return p.startsWith(':');
}

export function splitCrossResourceEntry(p: string): { resource: string; path: string } | null {
    if (!p.startsWith(':')) return null;
    const slash = p.indexOf('/', 1);
    if (slash <= 1) return null;
    const resource = p.slice(1, slash);
    const rest = p.slice(slash + 1);
    if (!resource || !rest) return null;
    return { resource, path: rest };
}

function segmentMatches(pattern: string, name: string): boolean {
    const p = pattern.toLowerCase();
    const n = name.toLowerCase();
    let pi = 0, ni = 0, star = -1, mark = 0;
    while (ni < n.length) {
        if (pi < p.length && p[pi] === n[ni]) { pi++; ni++; }
        else if (pi < p.length && p[pi] === '*') { star = pi++; mark = ni; }
        else if (star !== -1) { pi = star + 1; ni = ++mark; }
        else return false;
    }
    while (pi < p.length && p[pi] === '*') pi++;
    return pi === p.length;
}

export function globMatches(pattern: string, path: string): boolean {
    const pp = pattern.split('/');
    const np = path.split('/');

    const walk = (pi: number, ni: number): boolean => {
        if (pi === pp.length) return ni === np.length;
        if (pp[pi] === '**') {
            for (let skip = ni; skip <= np.length; skip++) {
                if (walk(pi + 1, skip)) return true;
            }
            return false;
        }
        if (ni >= np.length) return false;
        if (!segmentMatches(pp[pi], np[ni])) return false;
        return walk(pi + 1, ni + 1);
    };

    return walk(0, 0);
}

export function hasGlob(p: string): boolean {
    return p.includes('*');
}
