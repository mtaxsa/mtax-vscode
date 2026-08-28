export enum TokenKind {
    Name,
    Number,
    String,
    Keyword,
    Punct,
    Comment,
    EOF,
}

export interface Token {
    kind: TokenKind;
    text: string;
    value?: string;
    start: number;
    end: number;
    long?: boolean;
}

export interface LexError {
    message: string;
    start: number;
    end: number;
}

export const KEYWORDS = new Set([
    'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if',
    'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
]);

const PUNCT = [
    '...', '..', '::', '<<', '>>', '//', '==', '~=', '<=', '>=',
    '+', '-', '*', '/', '%', '^', '#', '&', '~', '|', '<', '>', '=',
    '(', ')', '{', '}', '[', ']', ';', ':', ',', '.',
];

const isDigit = (c: string) => c >= '0' && c <= '9';
const isHex = (c: string) => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
const isNameStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isNamePart = (c: string) => isNameStart(c) || isDigit(c);
const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\v' || c === '\f';

export interface LexResult {
    tokens: Token[];
    comments: Token[];
    errors: LexError[];
}

export function lex(source: string): LexResult {
    const tokens: Token[] = [];
    const comments: Token[] = [];
    const errors: LexError[] = [];
    let i = 0;

    const fail = (message: string, start: number, end: number) => errors.push({ message, start, end });

    if (source.charCodeAt(0) === 0xfeff) i = 1;
    if (source[i] === '#') {
        const lineEnd = source.indexOf('\n', i);
        i = lineEnd === -1 ? source.length : lineEnd;
    }

    const readLongBracket = (at: number): { level: number; contentStart: number; contentEnd: number; end: number } | null => {
        if (source[at] !== '[') return null;
        let j = at + 1;
        let level = 0;
        while (source[j] === '=') { level++; j++; }
        if (source[j] !== '[') return null;
        const contentStart = j + 1;
        const close = `]${'='.repeat(level)}]`;
        const found = source.indexOf(close, contentStart);
        if (found === -1) {
            fail('unfinished long bracket', at, source.length);
            return { level, contentStart, contentEnd: source.length, end: source.length };
        }
        return { level, contentStart, contentEnd: found, end: found + close.length };
    };

    while (i < source.length) {
        const c = source[i];

        if (isSpace(c)) { i++; continue; }

        // comments
        if (c === '-' && source[i + 1] === '-') {
            const start = i;
            const long = readLongBracket(i + 2);
            if (long) {
                comments.push({ kind: TokenKind.Comment, text: source.slice(start, long.end), start, end: long.end, long: true });
                i = long.end;
                continue;
            }
            let end = source.indexOf('\n', i);
            if (end === -1) end = source.length;
            comments.push({ kind: TokenKind.Comment, text: source.slice(start, end), start, end });
            i = end;
            continue;
        }

        // long string
        if (c === '[') {
            const long = readLongBracket(i);
            if (long) {
                tokens.push({
                    kind: TokenKind.String,
                    text: source.slice(i, long.end),
                    value: source.slice(long.contentStart, long.contentEnd),
                    start: i,
                    end: long.end,
                    long: true,
                });
                i = long.end;
                continue;
            }
        }

        // short string
        if (c === '"' || c === "'") {
            const start = i;
            const quote = c;
            let j = i + 1;
            let value = '';
            let terminated = false;
            while (j < source.length) {
                const ch = source[j];
                if (ch === '\\') {
                    const next = source[j + 1];
                    value += unescape(next, source, j);
                    j += next === 'z' ? 2 : escapeLength(source, j);
                    continue;
                }
                if (ch === '\n') break;
                if (ch === quote) { terminated = true; j++; break; }
                value += ch;
                j++;
            }
            if (!terminated) fail('unfinished string', start, j);
            tokens.push({ kind: TokenKind.String, text: source.slice(start, j), value, start, end: j });
            i = j;
            continue;
        }

        // number
        if (isDigit(c) || (c === '.' && isDigit(source[i + 1]))) {
            const start = i;
            if (c === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X')) {
                i += 2;
                while (i < source.length && (isHex(source[i]) || source[i] === '.')) i++;
                if (source[i] === 'p' || source[i] === 'P') {
                    i++;
                    if (source[i] === '+' || source[i] === '-') i++;
                    while (i < source.length && isDigit(source[i])) i++;
                }
            } else {
                while (i < source.length && (isDigit(source[i]) || source[i] === '.')) i++;
                if (source[i] === 'e' || source[i] === 'E') {
                    i++;
                    if (source[i] === '+' || source[i] === '-') i++;
                    while (i < source.length && isDigit(source[i])) i++;
                }
            }
            tokens.push({ kind: TokenKind.Number, text: source.slice(start, i), start, end: i });
            continue;
        }

        // name or keyword
        if (isNameStart(c)) {
            const start = i;
            while (i < source.length && isNamePart(source[i])) i++;
            const text = source.slice(start, i);
            tokens.push({
                kind: KEYWORDS.has(text) ? TokenKind.Keyword : TokenKind.Name,
                text,
                start,
                end: i,
            });
            continue;
        }

        // punctuation
        const punct = PUNCT.find((p) => source.startsWith(p, i));
        if (punct) {
            tokens.push({ kind: TokenKind.Punct, text: punct, start: i, end: i + punct.length });
            i += punct.length;
            continue;
        }

        fail(`unexpected character ${JSON.stringify(c)}`, i, i + 1);
        i++;
    }

    tokens.push({ kind: TokenKind.EOF, text: '<eof>', start: source.length, end: source.length });
    return { tokens, comments, errors };
}

function escapeLength(source: string, at: number): number {
    const next = source[at + 1];
    if (next === 'x') return 4;
    if (next === 'u') {
        const close = source.indexOf('}', at);
        return close === -1 ? 2 : close - at + 1;
    }
    if (isDigit(next)) {
        let n = 1;
        while (n < 3 && isDigit(source[at + 1 + n])) n++;
        return 1 + n;
    }
    return 2;
}

function unescape(next: string, source: string, at: number): string {
    switch (next) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        case 'a': return '\x07';
        case 'b': return '\b';
        case 'f': return '\f';
        case 'v': return '\v';
        case '\\': return '\\';
        case '"': return '"';
        case "'": return "'";
        case '\n': return '\n';
        case 'z': return '';
        case 'x': return String.fromCharCode(parseInt(source.substr(at + 2, 2), 16) || 0);
        default:
            if (next >= '0' && next <= '9') {
                const m = source.slice(at + 1).match(/^\d{1,3}/);
                return m ? String.fromCharCode(parseInt(m[0], 10)) : '';
            }
            return next ?? '';
    }
}
