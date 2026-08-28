import { lex, Token, TokenKind, LexError } from './lexer';
import * as ast from './ast';

export interface ParseError {
    message: string;
    start: number;
    end: number;
}

export interface ParseResult {
    chunk: ast.Chunk;
    errors: ParseError[];
    comments: Token[];
    tokens: Token[];
}

const BINARY: Record<string, [number, number]> = {
    or: [1, 1],
    and: [2, 2],
    '<': [3, 3], '>': [3, 3], '<=': [3, 3], '>=': [3, 3], '~=': [3, 3], '==': [3, 3],
    '|': [4, 4],
    '~': [5, 5],
    '&': [6, 6],
    '<<': [7, 7], '>>': [7, 7],
    '..': [9, 8],
    '+': [10, 10], '-': [10, 10],
    '*': [11, 11], '/': [11, 11], '//': [11, 11], '%': [11, 11],
    '^': [14, 13],
};
const UNARY_PRIORITY = 12;

const BLOCK_END = new Set(['end', 'else', 'elseif', 'until']);

export function parse(source: string): ParseResult {
    const { tokens, comments, errors: lexErrors } = lex(source);
    const parser = new Parser(tokens, source, lexErrors);
    const chunk = parser.parseChunk();
    return { chunk, errors: parser.errors, comments, tokens };
}

class Parser {
    readonly errors: ParseError[] = [];
    private index = 0;

    constructor(private readonly tokens: Token[], private readonly source: string, lexErrors: LexError[]) {
        for (const e of lexErrors) this.errors.push(e);
    }

    private get token(): Token { return this.tokens[this.index]; }
    private get previousEnd(): number { return this.tokens[Math.max(0, this.index - 1)].end; }

    private peek(offset = 1): Token {
        return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
    }

    private next(): Token {
        const t = this.token;
        if (t.kind !== TokenKind.EOF) this.index++;
        return t;
    }

    private atEnd(): boolean {
        return this.tokens[this.index].kind === TokenKind.EOF;
    }

    private at(text: string): boolean {
        const t = this.token;
        return (t.kind === TokenKind.Punct || t.kind === TokenKind.Keyword) && t.text === text;
    }

    private accept(text: string): Token | null {
        return this.at(text) ? this.next() : null;
    }

    private expect(text: string, what = text): Token | null {
        if (this.at(text)) return this.next();
        this.error(`expected '${what}'`);
        return null;
    }

    private error(message: string, token: Token = this.token): void {
        const last = this.errors[this.errors.length - 1];
        if (last && last.start === token.start) return;
        this.errors.push({ message: `${message} near '${token.text}'`, start: token.start, end: token.end });
    }

    private node<T extends ast.Node>(node: Omit<T, 'start' | 'end'>, start: number, end = this.previousEnd): T {
        return { ...node, start, end } as T;
    }

    parseChunk(): ast.Chunk {
        const body = this.parseBlock();
        if (!this.atEnd()) {
            this.error('unexpected token at the top level');
            while (!this.atEnd()) this.next();
        }
        return { type: 'Chunk', body, start: 0, end: this.source.length };
    }

    private parseBlock(): ast.Statement[] {
        const body: ast.Statement[] = [];
        while (!this.atEnd()) {
            if (this.token.kind === TokenKind.Keyword && BLOCK_END.has(this.token.text)) break;

            const before = this.index;
            const statement = this.parseStatement();
            if (statement) body.push(statement);

            if (this.index === before) {
                this.error('unexpected statement');
                this.next();
            }
            if (statement && (statement.type === 'ReturnStatement')) break;
        }
        return body;
    }

    private parseStatement(): ast.Statement | null {
        const start = this.token.start;

        if (this.accept(';')) return null;

        if (this.token.kind === TokenKind.Keyword) {
            switch (this.token.text) {
                case 'local': return this.parseLocal();
                case 'if': return this.parseIf();
                case 'while': return this.parseWhile();
                case 'do': {
                    this.next();
                    const body = this.parseBlock();
                    this.expect('end');
                    return this.node<ast.DoStatement>({ type: 'DoStatement', body }, start);
                }
                case 'for': return this.parseFor();
                case 'repeat': return this.parseRepeat();
                case 'function': return this.parseFunctionStatement();
                case 'return': {
                    this.next();
                    const args: ast.Expression[] = [];
                    if (!this.atEnd() && !BLOCK_END.has(this.token.text) && !this.at(';')) {
                        args.push(...this.parseExpressionList());
                    }
                    this.accept(';');
                    return this.node<ast.ReturnStatement>({ type: 'ReturnStatement', args }, start);
                }
                case 'break':
                    this.next();
                    return this.node<ast.BreakStatement>({ type: 'BreakStatement' }, start);
                case 'goto': {
                    this.next();
                    const label = this.parseIdentifier();
                    return this.node<ast.GotoStatement>({ type: 'GotoStatement', label }, start);
                }
                default:
                    return null;
            }
        }

        if (this.at('::')) {
            this.next();
            const label = this.parseIdentifier();
            this.expect('::');
            return this.node<ast.LabelStatement>({ type: 'LabelStatement', label }, start);
        }

        return this.parseExpressionStatement();
    }

    private parseLocal(): ast.Statement {
        const start = this.next().start; // local

        if (this.at('function')) {
            this.next();
            const identifier = this.parseIdentifier();
            const func = this.parseFunctionBody(start, false);
            return this.node<ast.FunctionDeclaration>(
                { type: 'FunctionDeclaration', isLocal: true, identifier, func },
                start,
            );
        }

        const variables: ast.Identifier[] = [];
        const attribs: (string | null)[] = [];
        do {
            variables.push(this.parseIdentifier());
            if (this.accept('<')) {
                const attrib = this.token.kind === TokenKind.Name ? this.next().text : null;
                if (!attrib) this.error('expected an attribute name');
                this.expect('>');
                attribs.push(attrib);
            } else {
                attribs.push(null);
            }
        } while (this.accept(','));

        const init = this.accept('=') ? this.parseExpressionList() : [];
        return this.node<ast.LocalStatement>({ type: 'LocalStatement', variables, attribs, init }, start);
    }

    private parseIf(): ast.Statement {
        const start = this.token.start;
        const clauses: ast.IfClause[] = [];

        this.next(); // if
        let clauseStart = start;
        let condition = this.parseExpression();
        this.expect('then');
        let body = this.parseBlock();
        clauses.push(this.node<ast.IfClause>({ type: 'IfClause', condition, body }, clauseStart));

        while (this.at('elseif')) {
            clauseStart = this.next().start;
            condition = this.parseExpression();
            this.expect('then');
            body = this.parseBlock();
            clauses.push(this.node<ast.IfClause>({ type: 'ElseifClause', condition, body }, clauseStart));
        }

        if (this.at('else')) {
            clauseStart = this.next().start;
            body = this.parseBlock();
            clauses.push(this.node<ast.IfClause>({ type: 'ElseClause', body }, clauseStart));
        }

        this.expect('end');
        return this.node<ast.IfStatement>({ type: 'IfStatement', clauses }, start);
    }

    private parseWhile(): ast.Statement {
        const start = this.next().start;
        const condition = this.parseExpression();
        this.expect('do');
        const body = this.parseBlock();
        this.expect('end');
        return this.node<ast.WhileStatement>({ type: 'WhileStatement', condition, body }, start);
    }

    private parseRepeat(): ast.Statement {
        const start = this.next().start;
        const body = this.parseBlock();
        this.expect('until');
        const condition = this.parseExpression();
        return this.node<ast.RepeatStatement>({ type: 'RepeatStatement', body, condition }, start);
    }

    private parseFor(): ast.Statement {
        const start = this.next().start;
        const first = this.parseIdentifier();

        if (this.accept('=')) {
            const from = this.parseExpression();
            this.expect(',');
            const to = this.parseExpression();
            const step = this.accept(',') ? this.parseExpression() : null;
            this.expect('do');
            const body = this.parseBlock();
            this.expect('end');
            return this.node<ast.NumericForStatement>(
                { type: 'NumericForStatement', variable: first, from, to, step, body } as any,
                start,
            );
        }

        const variables = [first];
        while (this.accept(',')) variables.push(this.parseIdentifier());
        this.expect('in');
        const iterators = this.parseExpressionList();
        this.expect('do');
        const body = this.parseBlock();
        this.expect('end');
        return this.node<ast.GenericForStatement>(
            { type: 'GenericForStatement', variables, iterators, body },
            start,
        );
    }

    /** `function a.b.c:d() end` */
    private parseFunctionStatement(): ast.Statement {
        const start = this.next().start;
        let identifier: ast.Expression = this.parseIdentifier();
        let isMethod = false;

        while (this.at('.') || this.at(':')) {
            const indexer = this.next().text as '.' | ':';
            const name = this.parseIdentifier();
            identifier = this.node<ast.MemberExpression>(
                { type: 'MemberExpression', indexer, base: identifier, identifier: name },
                identifier.start,
            );
            if (indexer === ':') { isMethod = true; break; }
        }

        const func = this.parseFunctionBody(start, isMethod);
        func.name = identifier;
        return this.node<ast.FunctionDeclaration>(
            { type: 'FunctionDeclaration', isLocal: false, identifier, func },
            start,
        );
    }

    private parseFunctionBody(start: number, isMethod: boolean): ast.FunctionExpression {
        const params: (ast.Identifier | ast.VarargLiteral)[] = [];
        this.expect('(');
        if (!this.at(')')) {
            do {
                if (this.at('...')) {
                    const t = this.next();
                    params.push({ type: 'VarargLiteral', start: t.start, end: t.end });
                    break;
                }
                params.push(this.parseIdentifier());
            } while (this.accept(','));
        }
        this.expect(')');
        const body = this.parseBlock();
        this.expect('end');
        return this.node<ast.FunctionExpression>(
            { type: 'FunctionExpression', params, body, isMethod, name: null },
            start,
        );
    }

    private parseExpressionStatement(): ast.Statement | null {
        const start = this.token.start;
        const first = this.parseSuffixedExpression();

        if (this.at('=') || this.at(',')) {
            const targets = [first];
            while (this.accept(',')) targets.push(this.parseSuffixedExpression());
            this.expect('=');
            const init = this.parseExpressionList();
            for (const target of targets) {
                if (target.type !== 'Identifier' && target.type !== 'MemberExpression' && target.type !== 'IndexExpression') {
                    this.error('cannot assign to this expression');
                    break;
                }
            }
            return this.node<ast.AssignmentStatement>({ type: 'AssignmentStatement', targets, init }, start);
        }

        if (first.type === 'CallExpression' || first.type === 'TableCallExpression' || first.type === 'StringCallExpression') {
            return this.node<ast.CallStatement>({ type: 'CallStatement', expression: first }, start);
        }

        this.error('expected a call or an assignment');
        return this.node<ast.CallStatement>({ type: 'CallStatement', expression: first }, start);
    }

    private parseExpressionList(): ast.Expression[] {
        const list = [this.parseExpression()];
        while (this.accept(',')) list.push(this.parseExpression());
        return list;
    }

    parseExpression(limit = 0): ast.Expression {
        const start = this.token.start;
        let left: ast.Expression;

        if (this.at('not') || this.at('-') || this.at('#') || this.at('~')) {
            const operator = this.next().text;
            const argument = this.parseExpression(UNARY_PRIORITY);
            left = this.node<ast.UnaryExpression>({ type: 'UnaryExpression', operator, argument }, start);
        } else {
            left = this.parseSimpleExpression();
        }

        while (true) {
            const t = this.token;
            if (t.kind !== TokenKind.Punct && t.kind !== TokenKind.Keyword) break;
            const power = BINARY[t.text];
            if (!power || power[0] <= limit) break;
            this.next();
            const right = this.parseExpression(power[1]);
            const type = t.text === 'and' || t.text === 'or' ? 'LogicalExpression' : 'BinaryExpression';
            left = this.node<ast.BinaryExpression>(
                { type, operator: t.text, left, right },
                left.start,
            );
        }

        return left;
    }

    private parseSimpleExpression(): ast.Expression {
        const t = this.token;

        if (t.kind === TokenKind.Number) {
            this.next();
            return { type: 'NumericLiteral', raw: t.text, start: t.start, end: t.end };
        }
        if (t.kind === TokenKind.String) {
            this.next();
            return this.stringLiteral(t);
        }
        if (t.kind === TokenKind.Keyword) {
            if (t.text === 'nil') { this.next(); return { type: 'NilLiteral', start: t.start, end: t.end }; }
            if (t.text === 'true' || t.text === 'false') {
                this.next();
                return { type: 'BooleanLiteral', value: t.text === 'true', start: t.start, end: t.end };
            }
            if (t.text === 'function') {
                const start = this.next().start;
                return this.parseFunctionBody(start, false);
            }
        }
        if (this.at('...')) {
            this.next();
            return { type: 'VarargLiteral', start: t.start, end: t.end };
        }
        if (this.at('{')) return this.parseTable();

        return this.parseSuffixedExpression();
    }

    private stringLiteral(t: Token): ast.StringLiteral {
        const openLength = t.long ? t.text.indexOf('[', 1) + 1 : 1;
        const closeLength = t.long ? openLength : 1;
        return {
            type: 'StringLiteral',
            value: t.value ?? '',
            start: t.start,
            end: t.end,
            contentStart: t.start + openLength,
            contentEnd: Math.max(t.start + openLength, t.end - closeLength),
        };
    }

    private parsePrimaryExpression(): ast.Expression {
        if (this.at('(')) {
            const start = this.next().start;
            const inner = this.parseExpression();
            this.expect(')');
            return { ...inner, start, end: this.previousEnd };
        }
        if (this.token.kind === TokenKind.Name) return this.parseIdentifier();

        this.error('expected an expression');
        const t = this.token;
        return { type: 'NilLiteral', start: t.start, end: t.start };
    }

    private parseSuffixedExpression(): ast.Expression {
        let base = this.parsePrimaryExpression();

        while (true) {
            const t = this.token;

            if (this.at('.') || this.at(':')) {
                const indexer = this.next().text as '.' | ':';
                const identifier = this.parseIdentifier();
                base = this.node<ast.MemberExpression>(
                    { type: 'MemberExpression', indexer, base, identifier },
                    base.start,
                );

                if (indexer === ':') {
                    base = this.parseCallArguments(base);
                }
                continue;
            }

            if (this.at('[')) {
                this.next();
                const index = this.parseExpression();
                this.expect(']');
                base = this.node<ast.IndexExpression>({ type: 'IndexExpression', base, index }, base.start);
                continue;
            }

            if (this.at('(') || this.at('{') || t.kind === TokenKind.String) {
                base = this.parseCallArguments(base);
                continue;
            }

            break;
        }

        return base;
    }

    private parseCallArguments(base: ast.Expression): ast.Expression {
        const t = this.token;

        if (this.at('(')) {
            this.next();
            const args: ast.Expression[] = [];
            if (!this.at(')')) args.push(...this.parseExpressionList());
            this.expect(')');
            return this.node<ast.CallExpression>({ type: 'CallExpression', base, args }, base.start);
        }

        if (this.at('{')) {
            const arg = this.parseTable();
            return this.node<ast.TableCallExpression>({ type: 'TableCallExpression', base, arg }, base.start);
        }

        if (t.kind === TokenKind.String) {
            this.next();
            const arg = this.stringLiteral(t);
            return this.node<ast.StringCallExpression>({ type: 'StringCallExpression', base, arg }, base.start);
        }

        this.error('expected call arguments');
        return base;
    }

    private parseTable(): ast.TableConstructor {
        const start = this.expect('{')?.start ?? this.token.start;
        const fields: ast.TableField[] = [];

        while (!this.at('}') && !this.atEnd()) {
            const fieldStart = this.token.start;

            if (this.at('[')) {
                this.next();
                const key = this.parseExpression();
                this.expect(']');
                this.expect('=');
                const value = this.parseExpression();
                fields.push(this.node<ast.TableKey>({ type: 'TableKey', key, value }, fieldStart));
            } else if (this.token.kind === TokenKind.Name && this.peek().kind === TokenKind.Punct && this.peek().text === '=') {
                const key = this.parseIdentifier();
                this.next(); // =
                const value = this.parseExpression();
                fields.push(this.node<ast.TableKeyString>({ type: 'TableKeyString', key, value }, fieldStart));
            } else {
                const value = this.parseExpression();
                fields.push(this.node<ast.TableValue>({ type: 'TableValue', value }, fieldStart));
            }

            if (!this.accept(',') && !this.accept(';')) break;
        }

        this.expect('}');
        return this.node<ast.TableConstructor>({ type: 'TableConstructor', fields }, start);
    }

    private parseIdentifier(): ast.Identifier {
        const t = this.token;
        if (t.kind !== TokenKind.Name) {
            this.error('expected a name');
            return { type: 'Identifier', name: '', start: t.start, end: t.start };
        }
        this.next();
        return { type: 'Identifier', name: t.text, start: t.start, end: t.end };
    }
}
