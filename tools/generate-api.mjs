/*
 * MTAX for VS Code — API generator.
 *
 * Reads the engine sources (MTAX-Purple) and the wiki (wiki/) and emits:
 *   data/api.json          the snapshot the extension ships with
 *   definitions/*.lua      LuaCATS meta files for lua-language-server
 *
 * Usage:  node tools/generate-api.mjs [--root "D:/Projetos MTAX"] [--quiet]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const argRoot = argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : null;
const QUIET = argv.includes('--quiet');

const log = (...a) => { if (!QUIET) console.log(...a); };
const warn = (...a) => console.warn(...a);

function findRoot() {
    if (argRoot) return path.resolve(argRoot);
    let dir = OUT_DIR;
    for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, 'MTAX-Purple')) && fs.existsSync(path.join(dir, 'wiki'))) return dir;
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    throw new Error('Could not locate the MTAX root (a folder holding both MTAX-Purple/ and wiki/). Pass --root.');
}

const ROOT = findRoot();
const ENGINE = path.join(ROOT, 'MTAX-Purple');
const WIKI = path.join(ROOT, 'wiki/src/content/docs');
log(`root:   ${ROOT}`);

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

function parseCatalog() {
    const file = path.join(ENGINE, 'Shared/src/lua_api/catalog/functions.h');
    const src = read(file);
    const out = [];
    const seen = new Set();
    for (const m of src.matchAll(/\{\s*"([^"]+)"\s*,\s*eLuaSide::(\w+)\s*,\s*eLuaTrust::(\w+)\s*\}/g)) {
        const [, name, side, trust] = m;
        if (seen.has(name)) { warn(`  duplicate catalog entry: ${name}`); continue; }
        seen.add(name);
        out.push({ name, side: side.toLowerCase(), trust: trust.toLowerCase() });
    }
    log(`natives: ${out.length}`);
    return out;
}

function parsePolicy() {
    const file = path.join(ENGINE, 'Shared/src/lua_api/sandbox/policy.h');
    if (!exists(file)) return null;
    const src = read(file);
    const list = (name) => {
        const m = src.match(new RegExp(`${name}\\[\\]\\s*=\\s*\\{([^}]*)\\}`));
        if (!m) return [];
        return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    };
    return {
        openLibsClient: list('luaOpenLibsClient'),
        openLibsServer: list('luaOpenLibsServer'),
        removedGlobals: list('luaRemovedGlobals'),
        restrictedOsFields: list('luaRestrictedOsFields'),
    };
}

function parsePairsBlock(body) {
    // splits a C++ initialiser list into per-entry `{ ... }` strings
    const entries = [];
    let depth = 0, cur = '', inStr = false, esc = false;
    for (const ch of body) {
        if (inStr) {
            cur += ch;
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') { inStr = true; cur += ch; continue; }
        if (ch === '{') { depth++; if (depth === 1) { cur = ''; continue; } }
        if (ch === '}') { depth--; if (depth === 0) { entries.push(cur); cur = ''; continue; } }
        if (depth > 0) cur += ch;
    }
    return entries;
}

function splitTopLevel(entry) {
    const parts = [];
    let depth = 0, cur = '', inStr = false, esc = false;
    for (const ch of entry) {
        if (inStr) {
            cur += ch;
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') { inStr = true; cur += ch; continue; }
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        if (ch === ')' || ch === '}' || ch === ']') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
}

const unquote = (s) => {
    if (!s) return null;
    const t = s.trim();
    if (t === 'nullptr') return null;
    const m = t.match(/^"([\s\S]*)"$/);
    return m ? m[1] : t;
};
const enumTail = (s, fallback) => {
    if (!s) return fallback;
    const m = s.match(/::(\w+)/);
    return m ? m[1].toLowerCase() : fallback;
};

function parseOop() {
    const file = path.join(ENGINE, 'Shared/src/lua_api/oop/oopclasses.h');
    if (!exists(file)) return { classes: [], statics: [], elementClasses: [] };
    const src = read(file);

    const arrays = new Map();
    for (const m of src.matchAll(/inline constexpr (OopMethod|OopProperty) (\w+)\[\]\s*=\s*\{([\s\S]*?)\n\};/g)) {
        const [, kind, name, body] = m;
        const entries = parsePairsBlock(body).map((e) => splitTopLevel(e));
        if (kind === 'OopMethod') {
            arrays.set(name, entries.map((p) => ({
                name: unquote(p[0]),
                native: unquote(p[1]),
                call: enumTail(p[2], 'plain'),
                side: enumTail(p[3], 'shared'),
            })).filter((x) => x.name && x.native));
        } else {
            arrays.set(name, entries.map((p) => ({
                name: unquote(p[0]),
                getter: unquote(p[1]),
                setter: unquote(p[2]),
                value: enumTail(p[3], 'plain'),
                side: enumTail(p[4], 'shared'),
            })).filter((x) => x.name));
        }
    }

    const classes = [];
    for (const m of src.matchAll(/inline constexpr OopClass (\w+)\[\]\s*=\s*\{([\s\S]*?)\n\};/g)) {
        for (const entry of parsePairsBlock(m[2])) {
            const p = splitTopLevel(entry);
            const name = unquote(p[0]);
            if (!name) continue;
            const methodsRef = (p[2] || '').trim();
            const propsRef = (p[4] || '').trim();
            classes.push({
                name,
                parent: unquote(p[1]),
                methods: arrays.get(methodsRef) ?? [],
                properties: arrays.get(propsRef) ?? [],
            });
        }
    }

    const statics = [];
    for (const m of src.matchAll(/inline constexpr OopStaticClass (\w+)\[\]\s*=\s*\{([\s\S]*?)\n\};/g)) {
        for (const entry of parsePairsBlock(m[2])) {
            const p = splitTopLevel(entry);
            const name = unquote(p[0]);
            if (!name) continue;
            statics.push({
                name,
                methods: arrays.get((p[1] || '').trim()) ?? [],
                properties: arrays.get((p[3] || '').trim()) ?? [],
            });
        }
    }

    const elementClasses = [];
    for (const m of src.matchAll(/inline constexpr OopElementClass (\w+)\[\]\s*=\s*\{([\s\S]*?)\n\};/g)) {
        for (const entry of parsePairsBlock(m[2])) {
            const p = splitTopLevel(entry);
            const type = (p[0] || '').match(/::(\w+)/);
            const className = unquote(p[1]);
            if (type && className) elementClasses.push({ elementType: type[1], className });
        }
    }

    log(`oop:     ${classes.length} classes, ${statics.length} static classes`);
    return { classes, statics, elementClasses };
}

function walk(dir, out = []) {
    if (!exists(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.mdx') || e.name.endsWith('.md')) out.push(p);
    }
    return out;
}

function slug(title) {
    return title
        .toLowerCase()
        .replace(/`/g, '')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-');
}

// Strips MDX/Starlight noise that reads badly inside a hover panel.
function cleanProse(text) {
    return text
        .replace(/^import\s+.*$/gm, '')
        .replace(/<FileTree>[\s\S]*?<\/FileTree>/g, '')
        .replace(/:::(caution|note|tip|danger|warning)(\[([^\]]*)\])?/g, (_, kind, __, label) => {
            const head = label || kind.charAt(0).toUpperCase() + kind.slice(1);
            return `**${head}:**`;
        })
        .replace(/^:::$/gm, '')
        .replace(/\(\/(en|pt)\/([^)]*)\)/g, (_, lang, rest) => `(https://wiki.mtax.com.br/${lang}/${rest})`)
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Splits a document into heading-delimited sections, keeping the raw body.
function sections(text) {
    const lines = text.split(/\r?\n/);
    const out = [];
    let cur = null;
    let inFence = false;
    for (const line of lines) {
        if (/^\s*```/.test(line)) inFence = !inFence;
        const m = !inFence && line.match(/^(#{2,4})\s+(.+?)\s*$/);
        if (m) {
            if (cur) out.push(cur);
            cur = { level: m[1].length, title: m[2].trim(), body: [] };
        } else if (cur) {
            cur.body.push(line);
        }
    }
    if (cur) out.push(cur);
    return out.map((s) => ({ ...s, body: s.body.join('\n') }));
}

function codeBlocks(body) {
    return [...body.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1], code: m[2].replace(/\s+$/, '') }));
}

// The first lua block that reads like a prototype rather than an example.
function signatureBlock(name, blocks) {
    const proto = new RegExp(`(^|[^\\w.:])${name}\\s*\\(`);
    for (const b of blocks) {
        if (b.lang && b.lang !== 'lua') continue;
        if (!proto.test(b.code)) continue;
        const meaningful = b.code.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));
        // an example assigns, calls or ends statements; a prototype does not
        const looksLikeExample = meaningful.some((l) => /^\s*(local|function|if|for|while|end|return)\b/.test(l))
            || meaningful.every((l) => !/\)\s*$/.test(l.trim()) && !/\[/.test(l));
        if (!looksLikeExample) return b.code;
    }
    return null;
}

function parseParamTable(body) {
    const m = body.match(/\*\*(Parameters|Par.metros)\*\*\s*\n+((?:\|.*\n)+)/);
    if (!m) return [];
    const rows = m[2].trim().split('\n').map((r) => r.trim()).filter(Boolean);
    if (rows.length < 3) return [];
    const header = rows[0].split('|').map((c) => c.trim().toLowerCase()).filter(Boolean);
    const idxName = 0;
    const idxType = header.findIndex((h) => h === 'type' || h === 'tipo');
    const idxDefault = header.findIndex((h) => h === 'default' || h === 'padrão' || h === 'padrao');
    const idxDesc = header.findIndex((h) => h.startsWith('desc'));
    const out = [];
    for (const row of rows.slice(2)) {
        const cells = row.split('|').map((c) => c.trim());
        const body = cells.slice(1, -1).length ? cells.slice(1, -1) : cells;
        const pick = (i) => (i >= 0 && i < body.length ? body[i] : '');
        const rawName = pick(idxName).replace(/`/g, '');
        if (!rawName) continue;
        out.push({
            name: rawName,
            type: pick(idxType).replace(/`/g, '') || null,
            default: (pick(idxDefault).replace(/`/g, '') || '').replace(/^—$/, '') || null,
            description: pick(idxDesc) || '',
        });
    }
    return out;
}

function firstProse(body) {
    const lines = body.split('\n');
    const buf = [];
    for (const line of lines) {
        if (/^\s*```/.test(line)) break;
        if (/^\s*\*\*(OOP|Parameters|Returns|Par.metros|Retorna|Example|Exemplo)/.test(line)) break;
        buf.push(line);
        if (buf.length > 12) break;
    }
    return cleanProse(buf.join('\n')).trim();
}

function docUrlFor(file) {
    const rel = path.relative(WIKI, file).replace(/\\/g, '/').replace(/\.(mdx|md)$/, '');
    const clean = rel.endsWith('/index') ? rel.slice(0, -'/index'.length) : rel;
    return `https://wiki.mtax.com.br/${clean}/`;
}

function parseWiki(lang, natives) {
    const base = path.join(WIKI, lang);
    const files = walk(base);
    const byName = new Map();
    const nativeNames = new Set(natives.map((n) => n.name));

    // pass 1 — a heading that is exactly a native name
    for (const file of files) {
        const text = read(file);
        const secs = sections(text);
        for (const sec of secs) {
            const title = sec.title.replace(/`/g, '').trim();
            if (!nativeNames.has(title)) continue;
            const blocks = codeBlocks(sec.body);
            const sig = signatureBlock(title, blocks);
            const oop = (sec.body.match(/\*\*OOP\*\*\s*[—-]?\s*(.+)/) || [])[1] || null;
            const ret = (sec.body.match(/\*\*(?:Returns|Retorna)\*\*\s*[—-]?\s*([\s\S]*?)(?:\n\n|$)/) || [])[1] || null;
            const examples = blocks
                .filter((b) => (!b.lang || b.lang === 'lua') && b.code !== sig)
                .map((b) => b.code)
                .slice(0, 2);
            const prev = byName.get(title);
            const entry = {
                description: firstProse(sec.body),
                signature: sig,
                oop: oop ? oop.trim() : null,
                params: parseParamTable(sec.body),
                returns: ret ? cleanProse(ret).replace(/\n+/g, ' ').trim() : null,
                examples,
                url: `${docUrlFor(file)}#${slug(title)}`,
            };
            // prefer the richer of two documents mentioning the same native
            if (!prev || score(entry) > score(prev)) byName.set(title, entry);
        }
    }

    // pass 2 — natives documented inside a grouped section: recover at least a signature
    for (const file of files) {
        const text = read(file);
        for (const sec of sections(file === null ? '' : text)) {
            const blocks = codeBlocks(sec.body);
            for (const b of blocks) {
                if (b.lang && b.lang !== 'lua') continue;
                for (const line of b.code.split('\n')) {
                    const m = line.match(/^\s*(?:[\w.]+(?:\s*\.\.\.)?(?:\s*,\s*[\w.]+)*\s+)?([a-zA-Z_]\w*)\s*\(/);
                    if (!m) continue;
                    const name = m[1];
                    if (!nativeNames.has(name)) continue;
                    if (byName.has(name) && byName.get(name).signature) continue;
                    const existing = byName.get(name);
                    byName.set(name, {
                        description: existing?.description || firstProse(sec.body),
                        signature: (existing?.signature) || b.code,
                        oop: existing?.oop ?? ((sec.body.match(/\*\*OOP\*\*\s*[—-]?\s*(.+)/) || [])[1] || null),
                        params: existing?.params?.length ? existing.params : parseParamTable(sec.body),
                        returns: existing?.returns ?? null,
                        examples: existing?.examples ?? [],
                        url: `${docUrlFor(file)}#${slug(sec.title)}`,
                    });
                }
            }
        }
    }

    log(`docs ${lang}: ${byName.size} natives documented`);
    return byName;
}

function score(e) {
    return (e.signature ? 4 : 0) + (e.description ? 2 : 0) + (e.params?.length ? 1 : 0) + (e.returns ? 1 : 0);
}

// Turns `element createElement ( string elementType [, string elementID = "" ] )`
// into a return type plus an ordered parameter list.
function analyseSignature(name, sigBlock) {
    if (!sigBlock) return null;
    const lines = sigBlock.split('\n');
    const variants = [];
    let cur = null;
    let tag = null;
    for (const raw of lines) {
        const line = raw.replace(/\r/g, '');
        const comment = line.match(/^\s*--\s*(client|server|shared)\b/i);
        if (comment) { tag = comment[1].toLowerCase(); continue; }
        if (!line.trim() || /^\s*--/.test(line)) continue;
        const starts = new RegExp(`(^|[^\\w.:])${name}\\s*\\(`).test(line);
        if (starts) {
            if (cur) variants.push(cur);
            cur = { side: tag, text: line.trim() };
            tag = null;
        } else if (cur) {
            cur.text += ' ' + line.trim();
        }
    }
    if (cur) variants.push(cur);
    if (!variants.length) return null;

    return variants.map((v) => {
        const head = v.text.slice(0, v.text.indexOf(name));
        const returnType = head.trim().replace(/\s+/g, ' ') || null;
        const open = v.text.indexOf('(', v.text.indexOf(name));
        const close = v.text.lastIndexOf(')');
        const inner = open >= 0 && close > open ? v.text.slice(open + 1, close) : '';
        return { side: v.side, returnType, params: splitParams(inner), text: v.text.replace(/\s+/g, ' ').trim() };
    });
}

function splitParams(inner) {
    const out = [];
    let depth = 0, cur = '', optionalDepth = 0;
    const push = (text, optional) => {
        const t = text.trim().replace(/^,/, '').trim();
        if (!t) return;
        const def = t.match(/=\s*(.+)$/);
        const withoutDefault = def ? t.slice(0, t.indexOf('=')).trim() : t;
        const words = withoutDefault.split(/\s+/).filter(Boolean);
        let type = null, pname = withoutDefault;
        if (words.length >= 2) { type = words.slice(0, -1).join(' '); pname = words[words.length - 1]; }
        out.push({
            name: pname.replace(/[^\w.]/g, '') || pname,
            type,
            optional,
            default: def ? def[1].trim() : null,
            varargs: /\.\.\./.test(withoutDefault),
        });
    };
    for (const ch of inner) {
        if (ch === '[') { push(cur, optionalDepth > 0); cur = ''; optionalDepth++; continue; }
        if (ch === ']') { push(cur, true); cur = ''; optionalDepth = Math.max(0, optionalDepth - 1); continue; }
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { push(cur, optionalDepth > 0); cur = ''; continue; }
        cur += ch;
    }
    push(cur, optionalDepth > 0);
    return out;
}

// A handful of globals are not C++ natives but pure-Lua helpers injected by the
// prelude (bit*, utf*, split, inspect, …). The wiki lists them in a prose table,
// so their signatures come from the prelude source itself.
function parsePrelude(nativeNames) {
    const file = path.join(ENGINE, 'Shared/src/lua_api/prelude/prelude.h');
    if (!exists(file)) return new Map();
    const src = read(file);
    const out = new Map();
    const lines = src.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s*function\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)/);
        if (!m) continue;
        const [, name, rawParams] = m;
        if (!nativeNames.has(name) || out.has(name)) continue;

        // read the body to spot `x = x or default` fallbacks -> optional parameter
        const body = lines.slice(i + 1, i + 40).join('\n');
        const params = rawParams
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean)
            .map((p) => {
                if (p === '...') return { name: '...', type: null, optional: true, default: null, varargs: true };
                const defMatch = body.match(new RegExp(`\\b${p}\\s*=\\s*${p}\\s+or\\s+([^\\n]+)`));
                const nilCheck = new RegExp(`\\b${p}\\s*==\\s*nil`).test(body);
                return {
                    name: p,
                    type: null,
                    optional: Boolean(defMatch) || nilCheck,
                    default: defMatch ? defMatch[1].trim().replace(/\s*(then|do)\s*$/, '') : null,
                    varargs: false,
                };
            });

        const text = `${name} ( ${params.map((p) => (p.varargs ? '...' : p.optional ? `[ ${p.name} ]` : p.name)).join(', ')} )`;
        out.set(name, [{ side: null, returnType: null, params, text }]);
    }
    log(`prelude: ${out.size} helper signatures`);
    return out;
}

// The "Bundled utilities" table on the scripting index documents these helpers.
function parseProseDescriptions(lang, nativeNames) {
    const file = path.join(WIKI, lang, 'scripting/index.mdx');
    if (!exists(file)) return new Map();
    const text = read(file);
    const out = new Map();
    for (const row of text.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm)) {
        const [, left, right] = row;
        if (/^-+$/.test(left.trim()) || /^Feature|^Recurso/i.test(left)) continue;
        const names = [...left.matchAll(/`([a-zA-Z_]\w*)/g)].map((m) => m[1]).filter((n) => nativeNames.has(n));
        if (!names.length) continue;
        const desc = cleanProse(right).trim();
        for (const n of names) if (!out.has(n)) out.set(n, desc);
    }
    return out;
}

function parseEvents(lang) {
    const out = [];
    for (const side of ['client', 'server']) {
        const file = path.join(WIKI, lang, 'scripting/events', `${side}.mdx`);
        if (!exists(file)) continue;
        const text = read(file);
        for (const sec of sections(text)) {
            const title = sec.title.replace(/`/g, '').trim();
            if (!/^on[A-Z]\w*$/.test(title)) continue;
            const params = parseEventParams(sec.body);
            const source = (sec.body.match(/\*\*(?:Source|Origem)\*\*\s*[—-]?\s*(.+)/) || [])[1] || null;
            const cancellable = /cancel/i.test(sec.body) && !/cannot be cancelled|não pode ser cancelad/i.test(sec.body);
            out.push({
                name: title,
                side,
                description: firstProse(sec.body),
                params,
                source: source ? source.trim().replace(/`/g, '') : null,
                cancellable,
                url: `${docUrlFor(file)}#${slug(title)}`,
            });
        }
    }
    log(`events ${lang}: ${out.length}`);
    return out;
}

function parseEventParams(body) {
    // Event pages list parameters either as a table or as a "no parameters" note.
    const m = body.match(/\*\*(?:Parameters|Par.metros)\*\*\s*\n+((?:\|.*\n)+)/);
    if (m) return parseParamTable(body);
    const inline = body.match(/^\s*```lua\n([\s\S]*?)```/m);
    if (inline) {
        const fn = inline[1].match(/function\s*\(([^)]*)\)/);
        if (fn && fn[1].trim()) {
            return fn[1].split(',').map((p) => ({ name: p.trim(), type: null, default: null, description: '' }));
        }
    }
    return [];
}

const MANIFEST_KEYS = [
    { name: 'resource_name', type: 'string', description: 'Resource name, reported by `getResourceInfo`.' },
    { name: 'resource_version', type: 'string', description: 'Free-form version, e.g. `"1.0.0"`.' },
    { name: 'resource_author', type: 'string', description: 'Author or owning team.' },
    { name: 'resource_info', type: 'table', description: 'Free-form text pairs read back by `getResourceInfo`.' },
    { name: 'server_files', type: 'string[]', description: '`.lua` only. Runs on the server and is never sent to the client.' },
    { name: 'client_files', type: 'string[]', description: '`.lua` only. Downloaded and executed on the client.' },
    { name: 'shared_files', type: 'string[]', description: '`.lua` only. Executed on both sides.' },
    { name: 'files', type: 'string[]', description: 'Assets downloaded by the client. Anything **except** `.lua`.' },
    { name: 'map_files', type: 'string[]', description: 'Map XML read by the server. Never `.lua`, never borrowed.' },
    { name: 'ui_page', type: 'string', description: 'HTML entry point of the resource UI. Must also appear in `files`.' },
    { name: 'loadscreen', type: 'boolean', description: 'Marks the resource as a loading screen, downloaded before every other.' },
    { name: 'loadscreen_manual_shutdown', type: 'boolean', description: 'Keeps the load screen up until `shutdownLoadingScreen` is called.' },
    { name: 'exports', type: 'string[]', description: 'Function names this resource offers to others through `exports`/`call`.' },
    {
        name: 'escrow_files',
        type: 'string[]',
        description: 'Files the portal build leaves **unprotected** on purpose (config a server owner has to edit). '
            + 'Read by the portal only — the runtime does not know the field exists. Each entry has to be a file the '
            + 'build would otherwise protect: a `.lua`, or a `dff`/`txd`/`col`/`ifp`, already declared in another list.',
    },
];

/** Extensions the portal build protects, and that escrow_files can therefore open. */
const PROTECTABLE_EXTENSIONS = ['.lua', '.dff', '.txd', '.col', '.ifp'];

const GLOBALS = [
    { name: 'root', side: 'shared', type: 'element', description: 'Root of the element tree. A handler attached here catches an event wherever it came from.' },
    { name: 'resourceRoot', side: 'shared', type: 'element', description: "This resource's own root element. Everything it creates hangs off it." },
    { name: 'localPlayer', side: 'client', type: 'player', description: 'The player at this machine.' },
    { name: 'source', side: 'shared', type: 'element', description: 'Inside an event handler: the element the event came from.' },
    { name: 'client', side: 'server', type: 'player', description: 'Inside a handler for a remote event: the player who triggered it. `nil` otherwise — always validate it.' },
    { name: 'eventName', side: 'shared', type: 'string', description: 'Inside an event handler: the name of the running event.' },
    { name: 'sourceResource', side: 'shared', type: 'resource', description: 'The resource whose script called `triggerEvent`. `nil` when the engine fired it.' },
    { name: 'sourceResourceRoot', side: 'shared', type: 'element', description: "That resource's root element, `nil` in the same cases." },
    { name: 'exports', side: 'shared', type: 'table', description: 'Proxy table for calling another resource\'s exported functions: `exports.bank:getBalance(player)`.' },
];

function build() {
    const natives = parseCatalog();
    const policy = parsePolicy();
    const oop = parseOop();
    const docsEn = parseWiki('en', natives);
    const docsPt = parseWiki('pt', natives);
    const eventsEn = parseEvents('en');
    const eventsPt = parseEvents('pt');

    const ptByName = new Map(eventsPt.map((e) => [e.name, e]));
    const events = eventsEn.map((e) => {
        const pt = ptByName.get(e.name);
        return { ...e, pt: pt ? { description: pt.description, params: pt.params, source: pt.source } : null };
    });
    for (const e of eventsPt) if (!events.some((x) => x.name === e.name)) events.push({ ...e, pt: { description: e.description, params: e.params, source: e.source } });

    const nativeNames = new Set(natives.map((n) => n.name));
    const prelude = parsePrelude(nativeNames);
    const proseEn = parseProseDescriptions('en', nativeNames);
    const prosePt = parseProseDescriptions('pt', nativeNames);

    let withSig = 0;
    let withDesc = 0;
    const functions = natives.map((n) => {
        const en = docsEn.get(n.name) || null;
        const pt = docsPt.get(n.name) || null;
        const variants = analyseSignature(n.name, en?.signature || pt?.signature || null) || prelude.get(n.name) || null;
        const description = en?.description || proseEn.get(n.name) || null;
        const ptDescription = pt?.description || prosePt.get(n.name) || null;
        if (variants) withSig++;
        if (description || ptDescription) withDesc++;
        return {
            name: n.name,
            side: n.side,
            trust: n.trust,
            signature: en?.signature || pt?.signature || variants?.map((v) => v.text).join('\n') || null,
            variants,
            returns: en?.returns || null,
            oop: en?.oop || pt?.oop || null,
            params: en?.params?.length ? en.params : (pt?.params ?? []),
            description,
            examples: en?.examples?.length ? en.examples : (pt?.examples ?? []),
            url: en?.url || pt?.url || null,
            pt: (pt || ptDescription)
                ? { description: ptDescription, returns: pt?.returns ?? null, params: pt?.params ?? [], url: pt?.url ?? null }
                : null,
        };
    });

    log(`coverage: ${withSig}/${functions.length} signatures, ${withDesc}/${functions.length} descriptions`);

    return {
        generatedFrom: {
            engine: path.relative(ROOT, ENGINE).replace(/\\/g, '/'),
            wiki: path.relative(ROOT, WIKI).replace(/\\/g, '/'),
        },
        schema: 2,
        luaVersion: '5.4',
        functions,
        events,
        oop,
        policy,
        manifestKeys: MANIFEST_KEYS,
        protectableExtensions: PROTECTABLE_EXTENSIONS,
        globals: GLOBALS,
    };
}

const LUA_TYPE_MAP = {
    bool: 'boolean', boolean: 'boolean',
    int: 'integer', integer: 'integer', number: 'number', float: 'number', uint: 'integer',
    string: 'string', str: 'string',
    table: 'table', func: 'function', function: 'function',
    var: 'any', any: 'any', mixed: 'any', value: 'any',
    nil: 'nil', void: 'nil',
};

function luaType(raw) {
    if (!raw) return 'any';
    let t = raw.trim().replace(/`/g, '').replace(/\.\.\.$/, '').trim();
    if (!t) return 'any';
    if (/^\w+\s*\|/.test(t) || t.includes('/')) {
        return t.split(/[|/]/).map((x) => luaType(x)).join('|');
    }
    const lower = t.toLowerCase();
    if (LUA_TYPE_MAP[lower]) return LUA_TYPE_MAP[lower];
    // element-ish types stay as the class names emitted below
    if (/^[a-z][\w]*$/.test(lower)) return lower;
    return 'any';
}

function luaIdent(raw, index) {
    let n = (raw || '').replace(/[^\w]/g, '');
    if (!n) n = `arg${index + 1}`;
    if (/^\d/.test(n)) n = `_${n}`;
    const reserved = new Set(['end', 'function', 'local', 'then', 'and', 'or', 'not', 'if', 'else', 'for', 'in', 'do', 'while', 'repeat', 'until', 'return', 'break', 'nil', 'true', 'false', 'goto']);
    return reserved.has(n) ? `${n}_` : n;
}

function docComment(fn, lang) {
    const doc = lang === 'pt' && fn.pt?.description ? fn.pt.description : fn.description;
    const lines = [];
    if (doc) for (const l of doc.split('\n')) lines.push(`--- ${l}`);
    else lines.push(`--- MTAX native (${fn.side}).`);
    lines.push('---');
    lines.push(`--- Side: **${fn.side}** · Trust: **${fn.trust}**`);
    if (fn.url) lines.push(`--- @see ${fn.url}`);
    return lines;
}

// Vector2/3/4 and Matrix are pure-Lua classes injected by the prelude, so they have
// no catalog entry to generate from. Kept in step with Shared/src/lua_api/prelude.
const VECTOR_MATRIX_DEFS = `
---@class Vector2
---@field x number
---@field y number
---@field length number
---@field squaredLength number
---@field normalized Vector2
---@operator add(Vector2): Vector2
---@operator sub(Vector2): Vector2
---@operator mul(number|Vector2): Vector2
---@operator div(number|Vector2): Vector2
---@operator unm: Vector2
local Vector2 = {}
function Vector2:getLength() end
function Vector2:getSquaredLength() end
function Vector2:getNormalized() end
function Vector2:normalize() end
---@param other Vector2
function Vector2:dot(other) end
function Vector2:getX() end
function Vector2:getY() end
---@param value number
function Vector2:setX(value) end
---@param value number
function Vector2:setY(value) end

---@class Vector3
---@field x number
---@field y number
---@field z number
---@field length number
---@field squaredLength number
---@field normalized Vector3
---@operator add(Vector3): Vector3
---@operator sub(Vector3): Vector3
---@operator mul(number|Vector3): Vector3
---@operator div(number|Vector3): Vector3
---@operator unm: Vector3
local Vector3 = {}
function Vector3:getLength() end
function Vector3:getSquaredLength() end
function Vector3:getNormalized() end
function Vector3:normalize() end
---@param other Vector3
function Vector3:dot(other) end
---@param other Vector3
---@return Vector3
function Vector3:cross(other) end
--- Moeller-Trumbore segment/triangle intersection. Returns the hit point, or \`false\`.
---@param dir Vector3
---@param v0 Vector3
---@param v1 Vector3
---@param v2 Vector3
---@return Vector3|boolean
function Vector3:intersectsSegmentTriangle(dir, v0, v1, v2) end
function Vector3:getX() end
function Vector3:getY() end
function Vector3:getZ() end
---@param value number
function Vector3:setX(value) end
---@param value number
function Vector3:setY(value) end
---@param value number
function Vector3:setZ(value) end

---@class Vector4 : Vector3
---@field w number
local Vector4 = {}
function Vector4:getW() end
---@param value number
function Vector4:setW(value) end

---@class Matrix
---@field position Vector3
---@field rotation Vector3
---@field forward Vector3
---@field right Vector3
---@field up Vector3
local Matrix = {}
---@return Vector3
function Matrix:getPosition() end
---@param position Vector3
function Matrix:setPosition(position) end
---@return Vector3
function Matrix:getRotation() end
---@param rotation Vector3
function Matrix:setRotation(rotation) end
---@param v Vector3
---@return Vector3
function Matrix:transformPosition(v) end
---@param v Vector3
---@return Vector3
function Matrix:transformDirection(v) end
---@return Matrix
function Matrix:inverse() end

---@param x number|table|nil
---@param y? number
---@return Vector2
function Vector2(x, y) end
---@param x number|table|nil
---@param y? number
---@param z? number
---@return Vector3
function Vector3(x, y, z) end
---@param x number|table|nil
---@param y? number
---@param z? number
---@param w? number
---@return Vector4
function Vector4(x, y, z, w) end
---@param position? Vector3
---@param rotation? Vector3
---@return Matrix
function Matrix(position, rotation) end
`;

function emitDefinitions(api) {
    const files = {};
    const classNames = new Set([
        'element', 'player', 'ped', 'vehicle', 'object', 'marker', 'blip', 'pickup', 'colshape',
        'radararea', 'team', 'water', 'sound', 'sound3d', 'light', 'searchlight', 'effect', 'weapon',
        'projectile', 'txd', 'dff', 'col', 'ifp', 'shader', 'texture', 'screensource', 'browser',
        'resource', 'account', 'aclgroup', 'acl', 'ban', 'timer', 'xmlnode', 'file', 'querybrowser',
        'connection', 'querybrowserquery', 'request', 'building', 'camera', 'svg', 'dui', 'matrix',
        'vector2', 'vector3', 'vector4', 'primitive', 'handling', 'userdata',
    ]);

    const header = (name) => [
        '---@meta',
        `-- MTAX Lua API — ${name}`,
        '-- Generated by mtax-vscode (tools/generate-api.mjs). Do not edit by hand.',
        '',
    ];

    // The docs name element types in lowercase (`vehicle theVehicle`); the OOP layer
    // names the same thing `Vehicle`. Alias one onto the other so `createVehicle(...)`
    // hands back something that answers `:getName()`.
    const oopByLower = new Map(api.oop.classes.map((c) => [c.name.toLowerCase(), c.name]));
    for (const alias of ['Vector2', 'Vector3', 'Vector4', 'Matrix']) oopByLower.set(alias.toLowerCase(), alias);
    const classes = [...classNames].sort().map((c) => {
        const oopName = oopByLower.get(c);
        return oopName ? `---@class ${c} : ${oopName}` : `---@class ${c}`;
    }).join('\n');

    files['mtax-types.lua'] = [
        ...header('types'),
        classes,
        '',
        VECTOR_MATRIX_DEFS,
        '',
        api.globals.map((g) => `--- ${g.description}\n--- Side: **${g.side}**\n---@type ${luaType(g.type)}\n${g.name} = nil`).join('\n\n'),
        '',
    ].join('\n');

    for (const side of ['shared', 'client', 'server']) {
        const lines = header(`${side} natives`);
        for (const fn of api.functions.filter((f) => f.side === side)) {
            lines.push(...docComment(fn, 'en'));
            const variant = fn.variants?.[0];
            const params = variant?.params ?? [];
            const names = [];
            params.forEach((p, i) => {
                if (p.varargs) {
                    lines.push(`---@param ... any ${p.description || ''}`.trimEnd());
                    names.push('...');
                    return;
                }
                const id = luaIdent(p.name, i);
                names.push(id);
                const meta = api.functions.find((f) => f.name === fn.name);
                const doc = meta?.params?.find((x) => x.name.replace(/[^\w]/g, '') === p.name.replace(/[^\w]/g, ''));
                const desc = (doc?.description || '').replace(/\s+/g, ' ').trim();
                lines.push(`---@param ${id}${p.optional ? '?' : ''} ${luaType(p.type)}${desc ? ` ${desc}` : ''}`);
            });
            if (variant?.returnType) {
                const rets = variant.returnType.split(/[,\s]+/).filter(Boolean);
                const retDoc = (fn.returns || '').replace(/\s+/g, ' ').trim();
                lines.push(`---@return ${rets.map((r) => luaType(r)).join(', ')}${retDoc ? ` # ${retDoc}` : ''}`);
            }
            lines.push(`function ${fn.name}(${names.join(', ')}) end`);
            lines.push('');
        }
        files[`mtax-${side}.lua`] = lines.join('\n');
    }

    // OOP classes
    {
        const lines = header('OOP classes');
        for (const cls of api.oop.classes) {
            lines.push(`---@class ${cls.name}${cls.parent ? ` : ${cls.parent}` : ''}`);
            for (const p of cls.properties) {
                const g = api.functions.find((f) => f.name === p.getter);
                const t = p.value === 'vector3' ? 'Vector3' : luaType(g?.variants?.[0]?.returnType);
                lines.push(`---@field ${p.name} ${t}`);
            }
            lines.push(`local ${cls.name} = {}`);
            lines.push('');
            for (const m of cls.methods) {
                const native = api.functions.find((f) => f.name === m.native);
                lines.push(`--- Wraps \`${m.native}\`.`);
                if (native?.description) lines.push(`--- ${native.description.split('\n')[0]}`);
                const params = native?.variants?.[0]?.params ?? [];
                const drop = m.call === 'plain' || m.call === 'with_true' || m.call === 'with_false' ? 1 : 0;
                const rest = params.slice(drop);
                const names = rest.map((p, i) => (p.varargs ? '...' : luaIdent(p.name, i)));
                rest.forEach((p, i) => {
                    if (p.varargs) { lines.push('---@param ... any'); return; }
                    lines.push(`---@param ${luaIdent(p.name, i)}${p.optional ? '?' : ''} ${luaType(p.type)}`);
                });
                if (native?.variants?.[0]?.returnType) {
                    lines.push(`---@return ${native.variants[0].returnType.split(/[,\s]+/).filter(Boolean).map(luaType).join(', ')}`);
                }
                lines.push(`function ${cls.name}:${m.name}(${names.join(', ')}) end`);
                lines.push('');
            }
        }
        for (const cls of api.oop.statics) {
            lines.push(`---@class ${cls.name}Static`);
            lines.push(`${cls.name} = {}`);
            lines.push('');
            for (const m of cls.methods) {
                const native = api.functions.find((f) => f.name === m.native);
                lines.push(`--- Wraps \`${m.native}\`.`);
                const params = native?.variants?.[0]?.params ?? [];
                const names = params.map((p, i) => (p.varargs ? '...' : luaIdent(p.name, i)));
                lines.push(`function ${cls.name}.${m.name}(${names.join(', ')}) end`);
                lines.push('');
            }
        }
        files['mtax-oop.lua'] = lines.join('\n');
    }

    return files;
}

const escapeForRegex = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alternation = (names) =>
    [...new Set(names)].sort((a, b) => b.length - a.length).map(escapeForRegex).join('|');

function emitGrammar(api) {
    const natives = api.functions.map((f) => f.name);
    const classes = [
        ...api.oop.classes.map((c) => c.name),
        ...api.oop.statics.map((c) => c.name),
        'Vector2', 'Vector3', 'Vector4', 'Matrix',
    ];
    const globals = api.globals.map((g) => g.name);

    return {
        scopeName: 'mtax.lua.injection',
        injectionSelector: 'L:source.lua -comment -string',
        patterns: [
            { name: 'support.function.mtax.lua', match: `(?<![.:\\w])(?:${alternation(natives)})\\b` },
            { name: 'support.class.mtax.lua', match: `(?<![.:\\w])(?:${alternation(classes)})\\b` },
            { name: 'support.constant.mtax.lua', match: `(?<![.:\\w])(?:${alternation(globals)})\\b` },
        ],
    };
}

function emitEventGrammar(api) {
    return {
        scopeName: 'mtax.lua.events',
        injectionSelector: 'L:source.lua string.quoted',
        patterns: [
            {
                name: 'support.constant.event.mtax.lua',
                match: `\\b(?:${alternation(api.events.map((e) => e.name))})\\b`,
            },
        ],
    };
}

const api = build();

fs.mkdirSync(path.join(OUT_DIR, 'data'), { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'data/api.json'), JSON.stringify(api), 'utf8');
log(`wrote data/api.json (${(fs.statSync(path.join(OUT_DIR, 'data/api.json')).size / 1024).toFixed(0)} KB)`);

const defs = emitDefinitions(api);
const defDir = path.join(OUT_DIR, 'definitions');
fs.mkdirSync(defDir, { recursive: true });
for (const [name, content] of Object.entries(defs)) {
    fs.writeFileSync(path.join(defDir, name), content, 'utf8');
    log(`wrote definitions/${name} (${(content.length / 1024).toFixed(0)} KB)`);
}

const syntaxDir = path.join(OUT_DIR, 'syntaxes');
fs.mkdirSync(syntaxDir, { recursive: true });
for (const [name, grammar] of [['mtax-injection.json', emitGrammar(api)], ['mtax-events.json', emitEventGrammar(api)]]) {
    const content = JSON.stringify(grammar, null, 2);
    fs.writeFileSync(path.join(syntaxDir, name), content, 'utf8');
    log(`wrote syntaxes/${name} (${(content.length / 1024).toFixed(0)} KB)`);
}
