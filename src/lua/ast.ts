export interface Node {
    type: string;
    start: number;
    end: number;
}

export interface Identifier extends Node {
    type: 'Identifier';
    name: string;
}

export interface NumericLiteral extends Node { type: 'NumericLiteral'; raw: string; }
export interface StringLiteral extends Node {
    type: 'StringLiteral';
    value: string;
    contentStart: number;
    contentEnd: number;
}
export interface BooleanLiteral extends Node { type: 'BooleanLiteral'; value: boolean; }
export interface NilLiteral extends Node { type: 'NilLiteral'; }
export interface VarargLiteral extends Node { type: 'VarargLiteral'; }

export interface TableKey extends Node { type: 'TableKey'; key: Expression; value: Expression; }
export interface TableKeyString extends Node { type: 'TableKeyString'; key: Identifier; value: Expression; }
export interface TableValue extends Node { type: 'TableValue'; value: Expression; }
export type TableField = TableKey | TableKeyString | TableValue;

export interface TableConstructor extends Node { type: 'TableConstructor'; fields: TableField[]; }

export interface BinaryExpression extends Node {
    type: 'BinaryExpression' | 'LogicalExpression';
    operator: string;
    left: Expression;
    right: Expression;
}
export interface UnaryExpression extends Node { type: 'UnaryExpression'; operator: string; argument: Expression; }

export interface MemberExpression extends Node {
    type: 'MemberExpression';
    indexer: '.' | ':';
    base: Expression;
    identifier: Identifier;
}
export interface IndexExpression extends Node { type: 'IndexExpression'; base: Expression; index: Expression; }

export interface CallExpression extends Node { type: 'CallExpression'; base: Expression; args: Expression[]; }
export interface TableCallExpression extends Node { type: 'TableCallExpression'; base: Expression; arg: Expression; }
export interface StringCallExpression extends Node { type: 'StringCallExpression'; base: Expression; arg: Expression; }
export type AnyCallExpression = CallExpression | TableCallExpression | StringCallExpression;

export interface FunctionExpression extends Node {
    type: 'FunctionExpression';
    params: (Identifier | VarargLiteral)[];
    body: Statement[];
    name?: Expression | null;
    isMethod?: boolean;
}

export type Expression =
    | Identifier | NumericLiteral | StringLiteral | BooleanLiteral | NilLiteral | VarargLiteral
    | TableConstructor | BinaryExpression | UnaryExpression | MemberExpression | IndexExpression
    | CallExpression | TableCallExpression | StringCallExpression | FunctionExpression;

export interface LocalStatement extends Node {
    type: 'LocalStatement';
    variables: Identifier[];
    attribs: (string | null)[];
    init: Expression[];
}
export interface AssignmentStatement extends Node {
    type: 'AssignmentStatement';
    targets: Expression[];
    init: Expression[];
}
export interface CallStatement extends Node { type: 'CallStatement'; expression: Expression; }
export interface FunctionDeclaration extends Node {
    type: 'FunctionDeclaration';
    isLocal: boolean;
    identifier: Expression | null;
    func: FunctionExpression;
}
export interface ReturnStatement extends Node { type: 'ReturnStatement'; args: Expression[]; }
export interface BreakStatement extends Node { type: 'BreakStatement'; }
export interface GotoStatement extends Node { type: 'GotoStatement'; label: Identifier; }
export interface LabelStatement extends Node { type: 'LabelStatement'; label: Identifier; }
export interface DoStatement extends Node { type: 'DoStatement'; body: Statement[]; }
export interface WhileStatement extends Node { type: 'WhileStatement'; condition: Expression; body: Statement[]; }
export interface RepeatStatement extends Node { type: 'RepeatStatement'; body: Statement[]; condition: Expression; }
export interface IfClause extends Node { type: 'IfClause' | 'ElseifClause' | 'ElseClause'; condition?: Expression; body: Statement[]; }
export interface IfStatement extends Node { type: 'IfStatement'; clauses: IfClause[]; }
export interface NumericForStatement extends Node {
    type: 'NumericForStatement';
    variable: Identifier;
    start: number;
    end: number;
    from: Expression;
    to: Expression;
    step: Expression | null;
    body: Statement[];
}
export interface GenericForStatement extends Node {
    type: 'GenericForStatement';
    variables: Identifier[];
    iterators: Expression[];
    body: Statement[];
}

export type Statement =
    | LocalStatement | AssignmentStatement | CallStatement | FunctionDeclaration | ReturnStatement
    | BreakStatement | GotoStatement | LabelStatement | DoStatement | WhileStatement | RepeatStatement
    | IfStatement | NumericForStatement | GenericForStatement;

export interface Chunk extends Node {
    type: 'Chunk';
    body: Statement[];
}

export function memberPath(node: Expression): string[] | null {
    if (node.type === 'Identifier') return [node.name];
    if (node.type === 'MemberExpression') {
        const base = memberPath(node.base);
        return base ? [...base, node.identifier.name] : null;
    }
    return null;
}
