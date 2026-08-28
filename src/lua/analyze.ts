import * as ast from './ast';
import { parse, ParseError } from './parser';
import { Token } from './lexer';

export type BindingKind = 'local' | 'param' | 'global' | 'field' | 'label' | 'self';

export interface Reference {
    start: number;
    end: number;
    write: boolean;
    declaration: boolean;
}

export interface Binding {
    name: string;
    kind: BindingKind;
    path: string;
    declaration: Reference | null;
    references: Reference[];
    signature: string | null;
    isFunction: boolean;
    isTable: boolean;
}

export interface Occurrence {
    start: number;
    end: number;
    name: string;
    kind: BindingKind | 'method' | 'property';
    write: boolean;
    declaration: boolean;
    called: boolean;
    binding: Binding | null;
}

export interface SymbolNode {
    name: string;
    detail: string;
    kind: 'function' | 'method' | 'variable' | 'constant' | 'namespace' | 'field' | 'event';
    start: number;
    end: number;
    selectionStart: number;
    selectionEnd: number;
    children: SymbolNode[];
}

export interface EventString {
    start: number;
    end: number;
    value: string;
    call: string;
    argIndex: number;
}

export interface Analysis {
    chunk: ast.Chunk;
    errors: ParseError[];
    comments: Token[];
    locals: Binding[];
    globals: Map<string, Binding>;
    fields: Map<string, Binding>;
    occurrences: Occurrence[];
    symbols: SymbolNode[];
    strings: EventString[];
}

interface Scope {
    parent: Scope | null;
    bindings: Map<string, Binding>;
    isFunction: boolean;
}

export function analyze(source: string): Analysis {
    const { chunk, errors, comments } = parse(source);
    return analyzeChunk(chunk, errors, comments, source);
}

export function analyzeChunk(
    chunk: ast.Chunk,
    errors: ParseError[],
    comments: Token[],
    source: string,
): Analysis {
    const locals: Binding[] = [];
    const globals = new Map<string, Binding>();
    const fields = new Map<string, Binding>();
    const occurrences: Occurrence[] = [];
    const symbols: SymbolNode[] = [];
    const strings: EventString[] = [];

    let scope: Scope = { parent: null, bindings: new Map(), isFunction: true };

    const push = (isFunction = false) => { scope = { parent: scope, bindings: new Map(), isFunction }; };
    const pop = () => { if (scope.parent) scope = scope.parent; };

    const resolve = (name: string): Binding | null => {
        for (let s: Scope | null = scope; s; s = s.parent) {
            const found = s.bindings.get(name);
            if (found) return found;
        }
        return null;
    };

    const declareLocal = (
        node: ast.Identifier,
        kind: BindingKind,
        options: { isFunction?: boolean; isTable?: boolean; signature?: string | null } = {},
    ): Binding => {
        const reference: Reference = { start: node.start, end: node.end, write: true, declaration: true };
        const binding: Binding = {
            name: node.name,
            kind,
            path: node.name,
            declaration: reference,
            references: [reference],
            signature: options.signature ?? null,
            isFunction: options.isFunction ?? false,
            isTable: options.isTable ?? false,
        };
        scope.bindings.set(node.name, binding);
        locals.push(binding);
        occurrences.push({
            start: node.start, end: node.end, name: node.name, kind,
            write: true, declaration: true, called: false, binding,
        });
        return binding;
    };

    const useGlobal = (node: ast.Identifier, write: boolean, called: boolean, options: {
        isFunction?: boolean; isTable?: boolean; signature?: string | null;
    } = {}): Binding => {
        let binding = globals.get(node.name);
        if (!binding) {
            binding = {
                name: node.name,
                kind: 'global',
                path: node.name,
                declaration: null,
                references: [],
                signature: null,
                isFunction: false,
                isTable: false,
            };
            globals.set(node.name, binding);
        }
        const reference: Reference = {
            start: node.start, end: node.end, write,
            declaration: write && !binding.declaration,
        };
        if (reference.declaration) binding.declaration = reference;
        if (write) {
            binding.isFunction = binding.isFunction || Boolean(options.isFunction);
            binding.isTable = binding.isTable || Boolean(options.isTable);
            if (options.signature) binding.signature = options.signature;
        }
        binding.references.push(reference);
        occurrences.push({
            start: node.start, end: node.end, name: node.name, kind: 'global',
            write, declaration: reference.declaration, called, binding,
        });
        return binding;
    };

    const useName = (node: ast.Identifier, write: boolean, called: boolean, options: {
        isFunction?: boolean; isTable?: boolean; signature?: string | null;
    } = {}): Binding => {
        const local = resolve(node.name);
        if (!local) return useGlobal(node, write, called, options);

        const reference: Reference = { start: node.start, end: node.end, write, declaration: false };
        local.references.push(reference);
        if (write) {
            local.isFunction = local.isFunction || Boolean(options.isFunction);
            local.isTable = local.isTable || Boolean(options.isTable);
            if (options.signature) local.signature = options.signature;
        }
        occurrences.push({
            start: node.start, end: node.end, name: node.name, kind: local.kind,
            write, declaration: false, called, binding: local,
        });
        return local;
    };

    const useField = (
        node: ast.MemberExpression,
        write: boolean,
        called: boolean,
        options: { isFunction?: boolean; isTable?: boolean; signature?: string | null } = {},
    ): void => {
        const path = ast.memberPath(node);
        const key = path ? path.join('.') : null;
        let binding: Binding | null = null;

        if (key) {
            binding = fields.get(key) ?? null;
            if (!binding) {
                binding = {
                    name: node.identifier.name,
                    kind: 'field',
                    path: key,
                    declaration: null,
                    references: [],
                    signature: null,
                    isFunction: false,
                    isTable: false,
                };
                fields.set(key, binding);
            }
            const reference: Reference = {
                start: node.identifier.start,
                end: node.identifier.end,
                write,
                declaration: write && !binding.declaration,
            };
            if (reference.declaration) binding.declaration = reference;
            if (write) {
                binding.isFunction = binding.isFunction || Boolean(options.isFunction);
                binding.isTable = binding.isTable || Boolean(options.isTable);
                if (options.signature) binding.signature = options.signature;
            }
            binding.references.push(reference);
        }

        occurrences.push({
            start: node.identifier.start,
            end: node.identifier.end,
            name: node.identifier.name,
            kind: node.indexer === ':' ? 'method' : 'property',
            write,
            declaration: Boolean(binding?.declaration
                && binding.declaration.start === node.identifier.start),
            called,
            binding,
        });
    };

    const signatureOf = (func: ast.FunctionExpression): string =>
        `function(${func.params.map((p) => (p.type === 'VarargLiteral' ? '...' : p.name)).join(', ')})`;

    const visitFunction = (func: ast.FunctionExpression): void => {
        push(true);
        if (func.isMethod) {
            scope.bindings.set('self', {
                name: 'self', kind: 'self', path: 'self',
                declaration: null, references: [], signature: null, isFunction: false, isTable: false,
            });
        }
        for (const param of func.params) {
            if (param.type === 'Identifier') declareLocal(param, 'param');
        }
        visitBlock(func.body);
        pop();
    };

    const visitExpression = (node: ast.Expression, called = false): void => {
        switch (node.type) {
            case 'Identifier':
                useName(node, false, called);
                return;
            case 'MemberExpression':
                visitExpression(node.base);
                useField(node, false, called);
                return;
            case 'IndexExpression':
                visitExpression(node.base);
                visitExpression(node.index);
                return;
            case 'CallExpression':
                visitExpression(node.base, true);
                recordStringArguments(node);
                for (const arg of node.args) visitExpression(arg);
                return;
            case 'TableCallExpression':
                visitExpression(node.base, true);
                visitExpression(node.arg);
                return;
            case 'StringCallExpression':
                visitExpression(node.base, true);
                return;
            case 'FunctionExpression':
                visitFunction(node);
                return;
            case 'TableConstructor':
                for (const field of node.fields) {
                    if (field.type === 'TableKey') { visitExpression(field.key); visitExpression(field.value); }
                    else if (field.type === 'TableKeyString') visitExpression(field.value);
                    else visitExpression(field.value);
                }
                return;
            case 'BinaryExpression':
            case 'LogicalExpression':
                visitExpression(node.left);
                visitExpression(node.right);
                return;
            case 'UnaryExpression':
                visitExpression(node.argument);
                return;
            default:
                return;
        }
    };

    const visitTarget = (node: ast.Expression, value: ast.Expression | undefined): void => {
        const options = {
            isFunction: value?.type === 'FunctionExpression',
            isTable: value?.type === 'TableConstructor',
            signature: value?.type === 'FunctionExpression' ? signatureOf(value) : null,
        };
        if (node.type === 'Identifier') { useName(node, true, false, options); return; }
        if (node.type === 'MemberExpression') { visitExpression(node.base); useField(node, true, false, options); return; }
        if (node.type === 'IndexExpression') { visitExpression(node.base); visitExpression(node.index); return; }
        visitExpression(node);
    };

    const recordStringArguments = (call: ast.CallExpression): void => {
        const path = ast.memberPath(call.base);
        const name = path ? path[path.length - 1] : null;
        if (!name) return;
        call.args.forEach((arg, index) => {
            if (arg.type !== 'StringLiteral') return;
            strings.push({
                start: arg.contentStart,
                end: arg.contentEnd,
                value: arg.value,
                call: name,
                argIndex: index,
            });
        });
    };

    const visitBlock = (body: ast.Statement[]): void => {
        for (const statement of body) visitStatement(statement);
    };

    const visitStatement = (statement: ast.Statement): void => {
        switch (statement.type) {
            case 'LocalStatement': {
                for (const expression of statement.init) visitExpression(expression);
                statement.variables.forEach((variable, index) => {
                    const value = statement.init[index];
                    declareLocal(variable, 'local', {
                        isFunction: value?.type === 'FunctionExpression',
                        isTable: value?.type === 'TableConstructor',
                        signature: value?.type === 'FunctionExpression' ? signatureOf(value) : null,
                    });
                });
                return;
            }
            case 'AssignmentStatement':
                for (const expression of statement.init) visitExpression(expression);
                statement.targets.forEach((target, index) => visitTarget(target, statement.init[index]));
                return;
            case 'CallStatement':
                visitExpression(statement.expression);
                return;
            case 'FunctionDeclaration': {
                const signature = signatureOf(statement.func);
                if (statement.isLocal && statement.identifier?.type === 'Identifier') {
                    declareLocal(statement.identifier, 'local', { isFunction: true, signature });
                    visitFunction(statement.func);
                    return;
                }
                if (statement.identifier?.type === 'Identifier') {
                    useName(statement.identifier, true, false, { isFunction: true, signature });
                } else if (statement.identifier?.type === 'MemberExpression') {
                    visitExpression(statement.identifier.base);
                    useField(statement.identifier, true, false, { isFunction: true, signature });
                }
                visitFunction(statement.func);
                return;
            }
            case 'ReturnStatement':
                for (const expression of statement.args) visitExpression(expression);
                return;
            case 'DoStatement':
                push();
                visitBlock(statement.body);
                pop();
                return;
            case 'WhileStatement':
                visitExpression(statement.condition);
                push();
                visitBlock(statement.body);
                pop();
                return;
            case 'RepeatStatement':
                push();
                visitBlock(statement.body);
                visitExpression(statement.condition);
                pop();
                return;
            case 'IfStatement':
                for (const clause of statement.clauses) {
                    if (clause.condition) visitExpression(clause.condition);
                    push();
                    visitBlock(clause.body);
                    pop();
                }
                return;
            case 'NumericForStatement':
                visitExpression(statement.from);
                visitExpression(statement.to);
                if (statement.step) visitExpression(statement.step);
                push();
                declareLocal(statement.variable, 'local');
                visitBlock(statement.body);
                pop();
                return;
            case 'GenericForStatement':
                for (const iterator of statement.iterators) visitExpression(iterator);
                push();
                for (const variable of statement.variables) declareLocal(variable, 'local');
                visitBlock(statement.body);
                pop();
                return;
            case 'LabelStatement':
            case 'GotoStatement':
                occurrences.push({
                    start: statement.label.start,
                    end: statement.label.end,
                    name: statement.label.name,
                    kind: 'label',
                    write: statement.type === 'LabelStatement',
                    declaration: statement.type === 'LabelStatement',
                    called: false,
                    binding: null,
                });
                return;
            default:
                return;
        }
    };

    visitBlock(chunk.body);

    buildSymbols(chunk, symbols, source);

    occurrences.sort((a, b) => a.start - b.start);
    return { chunk, errors, comments, locals, globals, fields, occurrences, symbols, strings };
}

function buildSymbols(chunk: ast.Chunk, out: SymbolNode[], source: string): void {
    collectSymbols(chunk.body, out, source);
}

function collectSymbols(body: ast.Statement[], out: SymbolNode[], source: string, depth = 0): void {
    if (depth > 8) return;
    for (const statement of body) {
        const symbol = symbolFor(statement, source);
        if (symbol) { out.push(symbol); continue; }

        switch (statement.type) {
            case 'DoStatement':
            case 'WhileStatement':
            case 'RepeatStatement':
            case 'NumericForStatement':
            case 'GenericForStatement':
                collectSymbols(statement.body, out, source, depth + 1);
                break;
            case 'IfStatement':
                for (const clause of statement.clauses) collectSymbols(clause.body, out, source, depth + 1);
                break;
            default:
                break;
        }
    }
}

function symbolFor(statement: ast.Statement, source: string): SymbolNode | null {
    if (statement.type === 'FunctionDeclaration' && statement.identifier) {
        const path = ast.memberPath(statement.identifier);
        const name = path ? path.join(statement.func.isMethod ? ':' : '.') : '?';
        const target = statement.identifier.type === 'MemberExpression'
            ? statement.identifier.identifier
            : statement.identifier;
        return {
            name,
            detail: signature(statement.func),
            kind: statement.func.isMethod ? 'method' : 'function',
            start: statement.start,
            end: statement.end,
            selectionStart: target.start,
            selectionEnd: target.end,
            children: functionChildren(statement.func, source),
        };
    }

    if (statement.type === 'LocalStatement' || statement.type === 'AssignmentStatement') {
        const names = statement.type === 'LocalStatement' ? statement.variables : statement.targets;
        const children: SymbolNode[] = [];
        names.forEach((target, index) => {
            const value = statement.init[index];
            const path = target.type === 'Identifier'
                ? [target.name]
                : target.type === 'MemberExpression'
                    ? ast.memberPath(target)
                    : null;
            if (!path) return;
            const name = path.join('.');
            const selection = target.type === 'MemberExpression' ? target.identifier : target;

            if (value?.type === 'FunctionExpression') {
                children.push({
                    name,
                    detail: signature(value),
                    kind: 'function',
                    start: statement.start,
                    end: statement.end,
                    selectionStart: selection.start,
                    selectionEnd: selection.end,
                    children: functionChildren(value, source),
                });
                return;
            }

            if (value?.type === 'TableConstructor') {
                children.push({
                    name,
                    detail: `table (${value.fields.length})`,
                    kind: 'namespace',
                    start: statement.start,
                    end: statement.end,
                    selectionStart: selection.start,
                    selectionEnd: selection.end,
                    children: tableChildren(value, source),
                });
                return;
            }

            children.push({
                name,
                detail: value ? preview(source, value) : '',
                kind: statement.type === 'LocalStatement' ? 'variable' : 'field',
                start: statement.start,
                end: statement.end,
                selectionStart: selection.start,
                selectionEnd: selection.end,
                children: [],
            });
        });

        if (!children.length) return null;
        if (children.length === 1) return children[0];
        return {
            name: children.map((c) => c.name).join(', '),
            detail: '',
            kind: 'variable',
            start: statement.start,
            end: statement.end,
            selectionStart: children[0].selectionStart,
            selectionEnd: children[children.length - 1].selectionEnd,
            children: [],
        };
    }

    return null;
}

function functionChildren(func: ast.FunctionExpression, source: string): SymbolNode[] {
    const out: SymbolNode[] = [];
    for (const statement of func.body) {
        if (statement.type === 'FunctionDeclaration'
            || ((statement.type === 'LocalStatement' || statement.type === 'AssignmentStatement')
                && statement.init.some((value) => value.type === 'FunctionExpression'))) {
            const child = symbolFor(statement, source);
            if (child) out.push(child);
        }
    }
    return out;
}

function tableChildren(table: ast.TableConstructor, source: string): SymbolNode[] {
    const out: SymbolNode[] = [];
    for (const field of table.fields) {
        if (field.type !== 'TableKeyString') continue;
        const isFunction = field.value.type === 'FunctionExpression';
        out.push({
            name: field.key.name,
            detail: isFunction
                ? signature(field.value as ast.FunctionExpression)
                : preview(source, field.value),
            kind: isFunction ? 'function' : 'field',
            start: field.start,
            end: field.end,
            selectionStart: field.key.start,
            selectionEnd: field.key.end,
            children: field.value.type === 'TableConstructor' ? tableChildren(field.value, source) : [],
        });
    }
    return out;
}

function signature(func: ast.FunctionExpression): string {
    return `(${func.params.map((p) => (p.type === 'VarargLiteral' ? '...' : p.name)).join(', ')})`;
}

function preview(source: string, node: ast.Node): string {
    const text = source.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
    return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

export function occurrenceAt(analysis: Analysis, offset: number): Occurrence | null {
    let low = 0;
    let high = analysis.occurrences.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const o = analysis.occurrences[mid];
        if (offset < o.start) high = mid - 1;
        else if (offset > o.end) low = mid + 1;
        else return o;
    }
    return null;
}

export function stringAt(analysis: Analysis, offset: number): EventString | null {
    return analysis.strings.find((s) => offset >= s.start && offset <= s.end) ?? null;
}
