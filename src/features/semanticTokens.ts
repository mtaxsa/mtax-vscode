import * as vscode from 'vscode';

import { Api, LUA_STDLIB, Side } from '../api/model';
import { LuaIndex } from '../lua/index';
import { ResourceIndex } from '../manifest/resource';
import { Occurrence } from '../lua/analyze';

const TYPES = [
    'function', 'method', 'property', 'variable', 'parameter',
    'class', 'namespace', 'event', 'label',
] as const;

const MODIFIERS = [
    'declaration', 'readonly', 'defaultLibrary', 'modification', 'deprecated',
] as const;

export const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(
    [...TYPES],
    [...MODIFIERS],
);

const STD_NAMESPACES = new Set(['math', 'string', 'table', 'os', 'coroutine', 'utf8', 'debug', 'io', 'package', '_G']);

export class MtaxSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    private readonly disposables: vscode.Disposable[] = [];

    readonly onDidChangeSemanticTokens = this.emitter.event;

    constructor(
        private readonly api: Api,
        private readonly lua: LuaIndex,
        private readonly resources: ResourceIndex,
    ) {
        this.disposables.push(
            this.resources.onDidChange(() => this.emitter.fire()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('mtax')) this.emitter.fire();
            }),
        );
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.emitter.dispose();
    }

    provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens | undefined {
        if (!vscode.workspace.getConfiguration('mtax').get<boolean>('enable', true)) return undefined;
        if (!vscode.workspace.getConfiguration('mtax').get<boolean>('semanticHighlighting', true)) return undefined;

        const analysis = this.lua.forDocument(document);
        const { side } = this.resources.resolveSide(document.uri.fsPath);
        const builder = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);

        for (const occurrence of analysis.occurrences) {
            const token = this.classify(occurrence, side);
            if (!token) continue;
            const position = document.positionAt(occurrence.start);
            const length = occurrence.end - occurrence.start;
            if (length <= 0) continue;
            builder.push(position.line, position.character, length, ...token);
        }

        for (const literal of analysis.strings) {
            const known = this.api.event(literal.value);
            const custom = !known && /^on[A-Z]/.test(literal.value);
            if (!known && !custom) continue;
            const position = document.positionAt(literal.start);
            const length = literal.end - literal.start;
            if (length <= 0) continue;
            builder.push(
                position.line,
                position.character,
                length,
                index('event'),
                known ? bits('defaultLibrary', 'readonly') : 0,
            );
        }

        return builder.build();
    }

    private classify(occurrence: Occurrence, side: Side): [number, number] | null {
        const { name, kind, binding } = occurrence;
        const flags: (typeof MODIFIERS)[number][] = [];
        if (occurrence.declaration) flags.push('declaration');
        if (occurrence.write && !occurrence.declaration) flags.push('modification');

        switch (kind) {
            case 'param':
                return [index('parameter'), bits(...flags)];

            case 'self':
                return [index('variable'), bits('readonly', 'defaultLibrary')];

            case 'label':
                return [index('label'), bits(...flags)];

            case 'local':
                return [
                    index(binding?.isFunction ? 'function' : 'variable'),
                    bits(...flags),
                ];

            case 'method':
                return [
                    index('method'),
                    bits(...flags, ...(this.api.methodsNamed(name).length ? (['defaultLibrary'] as const) : [])),
                ];

            case 'property': {
                const isApiProperty = this.api.classes.some((c) => c.properties.some((p) => p.name === name));
                return [index('property'), bits(...flags, ...(isApiProperty ? (['defaultLibrary'] as const) : []))];
            }

            case 'global': {
                const fn = this.api.fn(name);
                if (fn) {
                    const wrongSide = !this.api.isCallableFrom(fn, side);
                    return [index('function'), bits('defaultLibrary', ...(wrongSide ? (['deprecated'] as const) : []))];
                }

                const global = this.api.global(name);
                if (global) return [index('variable'), bits('defaultLibrary', 'readonly')];

                if (this.api.class(name) || this.api.staticClass(name) || isBundledType(name)) {
                    return [index('class'), bits('defaultLibrary')];
                }

                if (LUA_STDLIB.has(name)) {
                    return [
                        index(STD_NAMESPACES.has(name) ? 'namespace' : 'function'),
                        bits('defaultLibrary'),
                    ];
                }

                return [index(binding?.isFunction ? 'function' : 'variable'), bits(...flags)];
            }

            default:
                return null;
        }
    }
}

function isBundledType(name: string): boolean {
    return name === 'Vector2' || name === 'Vector3' || name === 'Vector4' || name === 'Matrix';
}

function index(type: (typeof TYPES)[number]): number {
    return TYPES.indexOf(type);
}

function bits(...modifiers: readonly (typeof MODIFIERS)[number][]): number {
    let mask = 0;
    for (const modifier of modifiers) mask |= 1 << MODIFIERS.indexOf(modifier);
    return mask;
}
