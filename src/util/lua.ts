export interface LuaString {
    start: number;
    end: number;
    contentStart: number;
    contentEnd: number;
    value: string;
    quote: string;
    unterminated: boolean;
}

export interface LuaScan {
    masked: string;
    strings: LuaString[];
    comments: { start: number; end: number }[];
}

const SPACE = ' ';

function blank(out: string[], text: string, start: number, end: number): void {
    for (let i = start; i < end && i < text.length; i++) {
        out[i] = text[i] === '\n' ? '\n' : text[i] === '\r' ? '\r' : SPACE;
    }
}

function longBracketLevel(text: string, i: number): number {
    if (text[i] !== '[') return -1;
    let j = i + 1;
    let level = 0;
    while (text[j] === '=') { level++; j++; }
    return text[j] === '[' ? level : -1;
}

export function scanLua(text: string): LuaScan {
    const out = text.split('');
    const strings: LuaString[] = [];
    const comments: { start: number; end: number }[] = [];
    let i = 0;

    while (i < text.length) {
        const ch = text[i];

        // line comment or long comment
        if (ch === '-' && text[i + 1] === '-') {
            const level = longBracketLevel(text, i + 2);
            if (level >= 0) {
                const close = `]${'='.repeat(level)}]`;
                const at = text.indexOf(close, i + 2);
                const end = at === -1 ? text.length : at + close.length;
                blank(out, text, i, end);
                comments.push({ start: i, end });
                i = end;
                continue;
            }
            let end = text.indexOf('\n', i);
            if (end === -1) end = text.length;
            blank(out, text, i, end);
            comments.push({ start: i, end });
            i = end;
            continue;
        }

        // long string
        {
            const level = longBracketLevel(text, i);
            if (level >= 0) {
                const close = `]${'='.repeat(level)}]`;
                const contentStart = i + 2 + level;
                const at = text.indexOf(close, contentStart);
                const contentEnd = at === -1 ? text.length : at;
                const end = at === -1 ? text.length : at + close.length;
                strings.push({
                    start: i,
                    end,
                    contentStart,
                    contentEnd,
                    value: text.slice(contentStart, contentEnd),
                    quote: '[[',
                    unterminated: at === -1,
                });
                blank(out, text, i, end);
                i = end;
                continue;
            }
        }

        // quoted string
        if (ch === '"' || ch === "'") {
            const quote = ch;
            let j = i + 1;
            let terminated = false;
            while (j < text.length) {
                const c = text[j];
                if (c === '\\') { j += 2; continue; }
                if (c === '\n') break;
                if (c === quote) { terminated = true; break; }
                j++;
            }
            const contentEnd = Math.min(j, text.length);
            const end = terminated ? j + 1 : contentEnd;
            strings.push({
                start: i,
                end,
                contentStart: i + 1,
                contentEnd,
                value: text.slice(i + 1, contentEnd),
                quote,
                unterminated: !terminated,
            });
            blank(out, text, i, end);
            i = end;
            continue;
        }

        i++;
    }

    return { masked: out.join(''), strings, comments };
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

export interface IdentifierHit {
    name: string;
    start: number;
    end: number;
    accessor: ':' | '.' | null;
    receiver: string | null;
}

export function identifierAt(masked: string, offset: number): IdentifierHit | null {
    if (offset > masked.length) return null;
    let start = offset;
    while (start > 0 && IDENT_PART.test(masked[start - 1])) start--;
    let end = offset;
    while (end < masked.length && IDENT_PART.test(masked[end])) end++;
    if (start === end) return null;
    const name = masked.slice(start, end);
    if (!IDENT_START.test(name[0])) return null;
    const { accessor, receiver } = accessorBefore(masked, start);
    return { name, start, end, accessor, receiver };
}

function accessorBefore(masked: string, start: number): { accessor: ':' | '.' | null; receiver: string | null } {
    let i = start - 1;
    while (i >= 0 && /[ \t]/.test(masked[i])) i--;
    if (i < 0) return { accessor: null, receiver: null };
    const ch = masked[i];
    if (ch !== ':' && ch !== '.') return { accessor: null, receiver: null };
    let j = i - 1;
    while (j >= 0 && /[ \t]/.test(masked[j])) j--;
    let k = j;
    // the receiver may itself be a chain: `getVehicle(x).name`, `a.b.c`
    while (k >= 0 && (IDENT_PART.test(masked[k]) || masked[k] === '.' || masked[k] === ')' || masked[k] === ']')) {
        if (masked[k] === ')' || masked[k] === ']') {
            const open = masked[k] === ')' ? '(' : '[';
            const close = masked[k];
            let depth = 0;
            while (k >= 0) {
                if (masked[k] === close) depth++;
                else if (masked[k] === open) { depth--; if (depth === 0) { k--; break; } }
                k--;
            }
            continue;
        }
        k--;
    }
    const receiver = masked.slice(k + 1, j + 1).trim();
    return { accessor: ch as ':' | '.', receiver: receiver || null };
}

export interface CallContext {
    name: string;
    receiver: string | null;
    accessor: ':' | '.' | null;
    openParen: number;
    argIndex: number;
    argStarts: number[];
}

export function callContextAt(masked: string, offset: number): CallContext | null {
    let depth = 0;
    let commas = 0;
    const argStarts: number[] = [];
    let i = Math.min(offset, masked.length) - 1;

    for (; i >= 0; i--) {
        const ch = masked[i];
        if (ch === ')' || ch === ']' || ch === '}') { depth++; continue; }
        if (ch === '(' || ch === '[' || ch === '{') {
            if (depth > 0) { depth--; continue; }
            if (ch !== '(') return null; // a table or index expression, not a call
            break;
        }
        if (ch === ',' && depth === 0) { commas++; argStarts.unshift(i + 1); continue; }
        if (ch === ';' && depth === 0) return null;
    }
    if (i < 0) return null;

    const openParen = i;
    let j = i - 1;
    while (j >= 0 && /[ \t\r\n]/.test(masked[j])) j--;
    const ident = identifierAt(masked, j + 1);
    if (!ident || ident.end !== j + 1) return null;

    argStarts.unshift(openParen + 1);
    return {
        name: ident.name,
        receiver: ident.receiver,
        accessor: ident.accessor,
        openParen,
        argIndex: commas,
        argStarts,
    };
}

export function stringAt(scan: LuaScan, offset: number): LuaString | null {
    for (const s of scan.strings) {
        if (offset >= s.contentStart && offset <= s.contentEnd) return s;
    }
    return null;
}

export function inComment(scan: LuaScan, offset: number): boolean {
    return scan.comments.some((c) => offset >= c.start && offset <= c.end);
}

export interface CallSite {
    name: string;
    start: number;
    end: number;
    receiver: string | null;
    accessor: ':' | '.' | null;
}

export function findCalls(masked: string): CallSite[] {
    const out: CallSite[] = [];
    const re = /([A-Za-z_][A-Za-z0-9_]*)\s*[({"']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked))) {
        const start = m.index;
        const name = m[1];
        const { accessor, receiver } = accessorBefore(masked, start);
        out.push({ name, start, end: start + name.length, receiver, accessor });
        re.lastIndex = start + name.length;
    }
    return out;
}

export function findIdentifiers(masked: string): CallSite[] {
    const out: CallSite[] = [];
    const re = /[A-Za-z_][A-Za-z0-9_]*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked))) {
        const start = m.index;
        const { accessor, receiver } = accessorBefore(masked, start);
        out.push({ name: m[0], start, end: start + m[0].length, receiver, accessor });
    }
    return out;
}

export function declaredNames(masked: string): Set<string> {
    const names = new Set<string>();
    const add = (raw: string) => {
        for (const part of raw.split(',')) {
            const n = part.trim().replace(/^\(|\)$/g, '');
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) names.add(n);
        }
    };

    for (const m of masked.matchAll(/\blocal\s+function\s+([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
    for (const m of masked.matchAll(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*[.:(]/g)) names.add(m[1]);
    for (const m of masked.matchAll(/\blocal\s+([A-Za-z_][A-Za-z0-9_,\s]*?)\s*(?:=|$|\n)/gm)) add(m[1]);
    for (const m of masked.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=[^=]/gm)) names.add(m[1]);
    for (const m of masked.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_,\s]*?)\s+(?:=|in)\b/g)) add(m[1]);
    for (const m of masked.matchAll(/\bfunction\s*(?:[A-Za-z_][A-Za-z0-9_.:]*)?\s*\(([^)]*)\)/g)) add(m[1]);
    return names;
}

export function editDistance(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const prev = new Array<number>(b.length + 1);
    const cur = new Array<number>(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        cur[0] = i;
        let best = cur[0];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            if (cur[j] < best) best = cur[j];
        }
        if (best > max) return max + 1;
        for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
}
