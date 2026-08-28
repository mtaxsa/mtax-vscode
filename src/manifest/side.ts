import { Side } from '../api/model';
import { globMatches, hasGlob, isCrossResourceEntry } from './parse';

export interface SideVerdict {
    side: Side;
    reason: string;
    certain: boolean;
}

export type FileLists = Record<string, string[]>;

export function sideFromLists(lists: FileLists, relativePath: string, source: string): SideVerdict | null {
    const rel = relativePath.split('\\').join('/');
    const hits: Side[] = [];

    const check = (key: string, side: Side) => {
        for (const entry of lists[key] ?? []) {
            if (isCrossResourceEntry(entry)) continue;
            const matched = hasGlob(entry)
                ? globMatches(entry, rel)
                : entry.toLowerCase() === rel.toLowerCase();
            if (matched) { hits.push(side); return; }
        }
    };

    check('shared_files', 'shared');
    check('server_files', 'server');
    check('client_files', 'client');

    if (!hits.length) return null;
    if (hits.length === 1) return { side: hits[0], reason: `declared in ${source}`, certain: true };
    return { side: 'shared', reason: 'declared on more than one side', certain: true };
}

export function guessSideFromPath(fsPath: string): SideVerdict {
    const norm = fsPath.split('\\').join('/').toLowerCase();
    const withoutExt = norm.replace(/\.lua$/, '');
    const base = withoutExt.slice(withoutExt.lastIndexOf('/') + 1);

    if (/\/(server|serverside)\//.test(norm)) return { side: 'server', reason: 'sits in a server/ folder', certain: false };
    if (/\/(client|clientside)\//.test(norm)) return { side: 'client', reason: 'sits in a client/ folder', certain: false };
    if (/\/(shared|common)\//.test(norm)) return { side: 'shared', reason: 'sits in a shared/ folder', certain: false };

    if (/^(s|server|main_s|server_main)$/.test(base) || /[_.-]s(erver)?$/.test(base)) {
        return { side: 'server', reason: 'named like a server script', certain: false };
    }
    if (/^(c|client|main_c|client_main)$/.test(base) || /[_.-]c(lient)?$/.test(base)) {
        return { side: 'client', reason: 'named like a client script', certain: false };
    }
    if (/^(g|shared|global)$/.test(base) || /[_.-](sh|shared|g)$/.test(base)) {
        return { side: 'shared', reason: 'named like a shared script', certain: false };
    }

    return { side: 'shared', reason: 'not declared anywhere — treated as shared', certain: false };
}

export function isUndeclared(lists: FileLists, relativePath: string): boolean {
    const rel = relativePath.split('\\').join('/');
    for (const entries of Object.values(lists)) {
        for (const entry of entries) {
            if (isCrossResourceEntry(entry)) continue;
            if (hasGlob(entry) ? globMatches(entry, rel) : entry.toLowerCase() === rel.toLowerCase()) return false;
        }
    }
    return true;
}

export interface MetaXml {
    server: string[];
    client: string[];
    shared: string[];
    files: string[];
    exports: string[];
    info: Record<string, string>;
    oop: boolean;
}

export function parseMetaXml(text: string): MetaXml {
    const out: MetaXml = { server: [], client: [], shared: [], files: [], exports: [], info: {}, oop: false };
    const attr = (tag: string, name: string): string | null => {
        const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
        return m ? m[1] : null;
    };

    for (const m of text.matchAll(/<script\b([^>]*)>/gi)) {
        const src = attr(m[1], 'src');
        if (!src) continue;
        const type = (attr(m[1], 'type') || 'server').toLowerCase();
        const normalised = src.split('\\').join('/');
        if (type === 'client') out.client.push(normalised);
        else if (type === 'shared') out.shared.push(normalised);
        else out.server.push(normalised);
    }
    for (const m of text.matchAll(/<file\b([^>]*)>/gi)) {
        const src = attr(m[1], 'src');
        if (src) out.files.push(src.split('\\').join('/'));
    }
    for (const m of text.matchAll(/<export\b([^>]*)>/gi)) {
        const fn = attr(m[1], 'function');
        if (fn) out.exports.push(fn);
    }
    const info = text.match(/<info\b([^>]*)>/i);
    if (info) {
        for (const m of info[1].matchAll(/([A-Za-z_][\w-]*)\s*=\s*["']([^"']*)["']/g)) {
            out.info[m[1]] = m[2];
        }
    }
    const oop = text.match(/<oop>\s*(true|false)\s*<\/oop>/i);
    out.oop = oop ? oop[1].toLowerCase() === 'true' : false;
    return out;
}
