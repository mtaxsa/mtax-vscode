import * as vscode from 'vscode';

import { ApiEvent, ApiFunction, ApiParam, OopClass, OopMethod, OopProperty, Side } from '../api/model';

export type DocsLanguage = 'en' | 'pt';

export function docsLanguage(): DocsLanguage {
    const setting = vscode.workspace.getConfiguration('mtax').get<string>('docsLanguage', 'auto');
    if (setting === 'en' || setting === 'pt') return setting;
    return vscode.env.language.toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

const T = {
    en: {
        side: 'Side', trust: 'Trust', parameters: 'Parameters', returns: 'Returns',
        example: 'Example', oop: 'OOP', docs: 'Open the documentation',
        serverOnly: 'server only', clientOnly: 'client only', both: 'client and server',
        cancellable: 'Cancellable with `cancelEvent()`.',
        notCancellable: 'Not cancellable.',
        source: 'Source', event: 'Event', handler: 'Handler', wraps: 'Wraps',
        readOnly: 'read-only', property: 'Property', method: 'Method', klass: 'Class',
        noParams: 'Takes no arguments.',
    },
    pt: {
        side: 'Lado', trust: 'Confiança', parameters: 'Parâmetros', returns: 'Retorna',
        example: 'Exemplo', oop: 'OOP', docs: 'Abrir a documentação',
        serverOnly: 'apenas no servidor', clientOnly: 'apenas no cliente', both: 'cliente e servidor',
        cancellable: 'Pode ser cancelado com `cancelEvent()`.',
        notCancellable: 'Não pode ser cancelado.',
        source: 'Origem', event: 'Evento', handler: 'Handler', wraps: 'Encapsula',
        readOnly: 'somente leitura', property: 'Propriedade', method: 'Método', klass: 'Classe',
        noParams: 'Não recebe argumentos.',
    },
} as const;

export function sideLabel(side: Side, lang: DocsLanguage): string {
    const t = T[lang];
    if (side === 'server') return t.serverOnly;
    if (side === 'client') return t.clientOnly;
    return t.both;
}

const SIDE_ICON: Record<Side, string> = { client: '🖥️', server: '🗄️', shared: '🔗' };

function markdown(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportHtml = false;
    md.isTrusted = true;
    return md;
}

export function functionDoc(fn: ApiFunction, lang: DocsLanguage, options: { compact?: boolean } = {}): vscode.MarkdownString {
    const t = T[lang];
    const md = markdown();
    const local = lang === 'pt' && fn.pt ? fn.pt : null;

    if (fn.signature) {
        md.appendCodeblock(fn.signature, 'lua');
    } else {
        md.appendCodeblock(`${fn.name}(...)`, 'lua');
    }

    const description = local?.description || fn.description;
    if (description) md.appendMarkdown(`\n${description}\n\n`);

    md.appendMarkdown(`${SIDE_ICON[fn.side]} **${t.side}:** ${sideLabel(fn.side, lang)}`);
    if (fn.trust === 'authoritative') md.appendMarkdown('  ·  🔒 authoritative');
    md.appendMarkdown('\n\n');

    if (!options.compact) {
        const params = (local?.params?.length ? local.params : fn.params) ?? [];
        if (params.length) {
            md.appendMarkdown(`**${t.parameters}**\n\n`);
            for (const p of params) {
                const type = p.type ? ` *${p.type}*` : '';
                const def = p.default ? ` = \`${p.default}\`` : '';
                md.appendMarkdown(`- \`${p.name}\`${type}${def}${p.description ? ` — ${stripTables(p.description)}` : ''}\n`);
            }
            md.appendMarkdown('\n');
        }

        const returns = local?.returns || fn.returns;
        if (returns) md.appendMarkdown(`**${t.returns}** — ${stripTables(returns)}\n\n`);

        if (fn.oop) md.appendMarkdown(`**${t.oop}** — ${fn.oop}\n\n`);

        if (fn.examples.length) {
            md.appendMarkdown(`**${t.example}**\n`);
            md.appendCodeblock(fn.examples[0], 'lua');
        }
    }

    const url = local?.url || fn.url;
    if (url) md.appendMarkdown(`\n[${t.docs}](${url})`);
    return md;
}

export function eventDoc(ev: ApiEvent, lang: DocsLanguage): vscode.MarkdownString {
    const t = T[lang];
    const md = markdown();
    const local = lang === 'pt' && ev.pt ? ev.pt : null;

    md.appendCodeblock(`addEventHandler("${ev.name}", root, function(${ev.params.map((p) => p.name).join(', ')})\nend)`, 'lua');

    const description = local?.description || ev.description;
    if (description) md.appendMarkdown(`\n${description}\n\n`);

    md.appendMarkdown(`${SIDE_ICON[ev.side]} **${t.event}** · ${ev.side}\n\n`);

    const source = local?.source || ev.source;
    if (source) md.appendMarkdown(`**${t.source}** — ${stripTables(source)}\n\n`);

    const params = (local?.params?.length ? local.params : ev.params) ?? [];
    if (params.length) {
        md.appendMarkdown(`**${t.parameters}**\n\n`);
        for (const p of params) {
            const type = p.type ? ` *${p.type}*` : '';
            md.appendMarkdown(`- \`${p.name}\`${type}${p.description ? ` — ${stripTables(p.description)}` : ''}\n`);
        }
        md.appendMarkdown('\n');
    } else {
        md.appendMarkdown(`${t.noParams}\n\n`);
    }

    md.appendMarkdown(ev.cancellable ? `${t.cancellable}\n\n` : `${t.notCancellable}\n\n`);
    if (ev.url) md.appendMarkdown(`[${t.docs}](${ev.url})`);
    return md;
}

export function methodDoc(cls: OopClass, method: OopMethod, native: ApiFunction | undefined, lang: DocsLanguage): vscode.MarkdownString {
    const t = T[lang];
    const md = markdown();
    const local = lang === 'pt' && native?.pt ? native.pt : null;

    md.appendCodeblock(`${cls.name}:${method.name}(${nativeParamNames(native, method).join(', ')})`, 'lua');
    const description = local?.description || native?.description;
    if (description) md.appendMarkdown(`\n${description}\n\n`);
    md.appendMarkdown(`**${t.wraps}** \`${method.native}\`\n\n`);
    if (native) {
        md.appendMarkdown(`${SIDE_ICON[native.side]} **${t.side}:** ${sideLabel(native.side, lang)}\n\n`);
        const returns = local?.returns || native.returns;
        if (returns) md.appendMarkdown(`**${t.returns}** — ${stripTables(returns)}\n\n`);
        const url = local?.url || native.url;
        if (url) md.appendMarkdown(`[${t.docs}](${url})`);
    }
    return md;
}

export function propertyDoc(cls: OopClass, prop: OopProperty, api: { fn(name: string): ApiFunction | undefined }, lang: DocsLanguage): vscode.MarkdownString {
    const t = T[lang];
    const md = markdown();
    const getter = prop.getter ? api.fn(prop.getter) : undefined;
    const native = getter ?? (prop.setter ? api.fn(prop.setter) : undefined);
    const local = lang === 'pt' && native?.pt ? native.pt : null;

    md.appendCodeblock(`${cls.name}.${prop.name}`, 'lua');
    const description = local?.description || native?.description;
    if (description) md.appendMarkdown(`\n${description}\n\n`);
    md.appendMarkdown(`**${t.property}**${prop.setter ? '' : ` · ${t.readOnly}`}\n\n`);
    if (prop.getter) md.appendMarkdown(`- ${t.wraps} \`${prop.getter}\`\n`);
    if (prop.setter) md.appendMarkdown(`- ${t.wraps} \`${prop.setter}\`\n`);
    const url = local?.url || native?.url;
    if (url) md.appendMarkdown(`\n[${t.docs}](${url})`);
    return md;
}

export function nativeParamNames(native: ApiFunction | undefined, method: OopMethod): string[] {
    const params = native?.variants?.[0]?.params ?? [];
    const drop = method.call === 'plain' || method.call === 'with_true' || method.call === 'with_false' ? 1 : 0;
    return params.slice(drop).map((p) => (p.varargs ? '...' : p.name));
}

export function paramLabel(p: ApiParam): string {
    const type = p.type ? `${p.type} ` : '';
    const def = p.default ? ` = ${p.default}` : '';
    const label = `${type}${p.name}${def}`;
    return p.optional ? `[${label}]` : label;
}

function stripTables(text: string): string {
    return text.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
}
