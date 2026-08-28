import * as vscode from 'vscode';

import { Api, ApiFunction, ApiVariant, Side } from '../api/model';
import { ResourceIndex } from '../manifest/resource';
import { scanLua, callContextAt } from '../util/lua';
import { docsLanguage, paramLabel } from './docs';

export class MtaxSignatureHelpProvider implements vscode.SignatureHelpProvider {
    constructor(private readonly api: Api, private readonly resources: ResourceIndex) {}

    provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.SignatureHelp | undefined {
        if (!vscode.workspace.getConfiguration('mtax').get<boolean>('enable', true)) return undefined;

        const scan = scanLua(document.getText());
        const offset = document.offsetAt(position);
        const call = callContextAt(scan.masked, offset);
        if (!call) return undefined;

        const resolved = this.resolve(call.name, call.receiver, call.accessor);
        if (!resolved) return undefined;
        const { fn, dropped } = resolved;
        if (!fn.variants?.length) return undefined;

        const lang = docsLanguage();
        const { side } = this.resources.resolveSide(document.uri.fsPath);

        const help = new vscode.SignatureHelp();
        help.signatures = fn.variants.map((v) => buildSignature(fn, v, dropped, lang));
        help.activeSignature = pickVariant(fn.variants, side);
        help.activeParameter = Math.min(
            call.argIndex,
            Math.max(0, (fn.variants[help.activeSignature]?.params.length ?? 1) - 1 - dropped),
        );
        return help;
    }

    private resolve(
        name: string,
        receiver: string | null,
        accessor: ':' | '.' | null,
    ): { fn: ApiFunction; dropped: number } | undefined {
        if (!accessor) {
            const fn = this.api.fn(name);
            return fn ? { fn, dropped: 0 } : undefined;
        }

        const cls = receiver ? this.api.class(receiver) : undefined;
        if (cls) {
            const method = this.api.membersOf(cls.name).methods.find((m) => m.name === name);
            if (method) {
                const fn = this.api.fn(method.native);
                if (fn) return { fn, dropped: accessor === ':' && isSelfFirst(method.call) ? 1 : 0 };
            }
        }

        const staticCls = receiver ? this.api.staticClass(receiver) : undefined;
        const staticMethod = staticCls?.methods.find((m) => m.name === name);
        if (staticMethod) {
            const fn = this.api.fn(staticMethod.native);
            if (fn) return { fn, dropped: 0 };
        }

        const candidates = this.api.methodsNamed(name);
        if (candidates.length) {
            const fn = this.api.fn(candidates[0].native);
            if (fn) return { fn, dropped: accessor === ':' && isSelfFirst(candidates[0].call) ? 1 : 0 };
        }
        return undefined;
    }
}

function isSelfFirst(call: string): boolean {
    return call === 'plain' || call === 'with_true' || call === 'with_false';
}

function buildSignature(
    fn: ApiFunction,
    variant: ApiVariant,
    dropped: number,
    lang: 'en' | 'pt',
): vscode.SignatureInformation {
    const params = variant.params.slice(dropped);
    const label = `${fn.name}(${params.map(paramLabel).join(', ')})`;
    const info = new vscode.SignatureInformation(label);

    const local = lang === 'pt' && fn.pt ? fn.pt : null;
    const docParams = (local?.params?.length ? local.params : fn.params) ?? [];
    const description = local?.description || fn.description || '';
    const sideNote = variant.side ? ` *(${variant.side})*` : '';
    const md = new vscode.MarkdownString(`${description}${sideNote}`);
    md.isTrusted = true;
    info.documentation = md;

    let cursor = fn.name.length + 1;
    info.parameters = params.map((p) => {
        const text = paramLabel(p);
        const start = label.indexOf(text, cursor);
        cursor = start + text.length;
        const doc = docParams.find((d) => d.name.replace(/[^\w]/g, '') === p.name.replace(/[^\w]/g, ''));
        const param = new vscode.ParameterInformation(
            start >= 0 ? [start, start + text.length] : text,
            doc?.description ? new vscode.MarkdownString(doc.description) : undefined,
        );
        return param;
    });

    return info;
}

function pickVariant(variants: ApiVariant[], side: Side): number {
    const exact = variants.findIndex((v) => v.side === side);
    if (exact >= 0) return exact;
    const generic = variants.findIndex((v) => !v.side);
    return generic >= 0 ? generic : 0;
}
