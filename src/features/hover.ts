import * as vscode from 'vscode';

import { Api } from '../api/model';
import { ResourceIndex } from '../manifest/resource';
import { scanLua, identifierAt, stringAt, callContextAt } from '../util/lua';
import { docsLanguage, functionDoc, eventDoc, methodDoc, propertyDoc } from './docs';
import { isManifest, enclosingListKey } from './completion';

export class MtaxHoverProvider implements vscode.HoverProvider {
    constructor(private readonly api: Api, private readonly resources: ResourceIndex) {}

    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        if (!vscode.workspace.getConfiguration('mtax').get<boolean>('enable', true)) return undefined;

        const text = document.getText();
        const offset = document.offsetAt(position);
        const scan = scanLua(text);
        const lang = docsLanguage();

        const literal = stringAt(scan, offset);
        if (literal) {
            const range = new vscode.Range(
                document.positionAt(literal.contentStart),
                document.positionAt(literal.contentEnd),
            );
            const event = this.api.event(literal.value);
            if (event) return new vscode.Hover(eventDoc(event, lang), range);

            if (isManifest(document)) {
                const key = enclosingListKey(scan.masked, literal.start);
                const meta = key ? this.api.manifestKey(key) : undefined;
                if (meta) {
                    const md = new vscode.MarkdownString(`\`${literal.value}\`\n\n**${key}** — ${meta.description}`);
                    return new vscode.Hover(md, range);
                }
            }
            return undefined;
        }

        const ident = identifierAt(scan.masked, offset);
        if (!ident) return undefined;
        const range = new vscode.Range(document.positionAt(ident.start), document.positionAt(ident.end));

        if (isManifest(document)) {
            const key = this.api.manifestKey(ident.name);
            if (key) {
                const md = new vscode.MarkdownString(`**${key.name}** *(${key.type})*\n\n${key.description}`);
                md.isTrusted = true;
                return new vscode.Hover(md, range);
            }
        }

        if (ident.accessor) {
            const cls = ident.receiver ? this.api.class(ident.receiver) : undefined;
            if (cls) {
                const method = this.api.membersOf(cls.name).methods.find((m) => m.name === ident.name);
                if (method) return new vscode.Hover(methodDoc(cls, method, this.api.fn(method.native), lang), range);
                const prop = this.api.membersOf(cls.name).properties.find((p) => p.name === ident.name);
                if (prop) return new vscode.Hover(propertyDoc(cls, prop, this.api, lang), range);
            }

            const staticCls = ident.receiver ? this.api.staticClass(ident.receiver) : undefined;
            const staticMethod = staticCls?.methods.find((m) => m.name === ident.name);
            if (staticCls && staticMethod) {
                const native = this.api.fn(staticMethod.native);
                if (native) return new vscode.Hover(functionDoc(native, lang), range);
            }

            const candidates = this.api.methodsNamed(ident.name);
            if (candidates.length) {
                const native = this.api.fn(candidates[0].native);
                if (native) {
                    const md = functionDoc(native, lang);
                    md.appendMarkdown(`\n\nReached as \`:${ident.name}()\``);
                    return new vscode.Hover(md, range);
                }
            }
            return undefined;
        }

        const fn = this.api.fn(ident.name);
        if (fn) {
            const md = functionDoc(fn, lang);
            const { side, certain, reason } = this.resources.resolveSide(document.uri.fsPath);
            if (!this.api.isCallableFrom(fn, side)) {
                md.appendMarkdown(
                    `\n\n---\n\n⚠️ This file runs on **${side}** (${reason}${certain ? '' : ', guessed'}) `
                    + `and \`${fn.name}\` only exists on **${fn.side}**.`,
                );
            }
            return new vscode.Hover(md, range);
        }

        const global = this.api.global(ident.name);
        if (global) {
            const md = new vscode.MarkdownString(`\`${global.name}\` *(${global.type})*\n\n${global.description}`);
            return new vscode.Hover(md, range);
        }

        const cls = this.api.class(ident.name);
        if (cls) {
            const { methods, properties } = this.api.membersOf(cls.name);
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**class ${cls.name}**${cls.parent ? ` : ${cls.parent}` : ''}\n\n`);
            md.appendMarkdown(`${methods.length} methods · ${properties.length} properties\n\n`);
            const create = methods.find((m) => m.name === 'create');
            if (create) md.appendCodeblock(`local x = ${cls.name}.create(...)   -- ${create.native}`, 'lua');
            return new vscode.Hover(md, range);
        }

        const staticCls = this.api.staticClass(ident.name);
        if (staticCls) {
            const md = new vscode.MarkdownString(
                `**${staticCls.name}** — MTAX static class\n\n${staticCls.methods.length} methods`,
            );
            return new vscode.Hover(md, range);
        }

        const call = callContextAt(scan.masked, ident.start);
        if (call && this.api.fn(call.name)) return undefined;

        return undefined;
    }
}
