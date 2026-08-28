import * as fs from 'fs';
import * as path from 'path';

export type Side = 'client' | 'server' | 'shared';
export type Trust = 'sandboxed' | 'authoritative' | 'bridge';

export interface ApiParam {
    name: string;
    type: string | null;
    optional: boolean;
    default: string | null;
    varargs: boolean;
}

export interface ApiVariant {
    side: Side | null;
    returnType: string | null;
    params: ApiParam[];
    text: string;
}

export interface DocParam {
    name: string;
    type: string | null;
    default: string | null;
    description: string;
}

export interface Localised {
    description: string | null;
    returns?: string | null;
    params?: DocParam[];
    url?: string | null;
}

export interface ApiFunction {
    name: string;
    side: Side;
    trust: Trust;
    signature: string | null;
    variants: ApiVariant[] | null;
    returns: string | null;
    oop: string | null;
    params: DocParam[];
    description: string | null;
    examples: string[];
    url: string | null;
    pt: Localised | null;
}

export interface ApiEvent {
    name: string;
    side: 'client' | 'server';
    description: string;
    params: DocParam[];
    source: string | null;
    cancellable: boolean;
    url: string | null;
    pt: { description: string; params: DocParam[]; source: string | null } | null;
}

export interface OopMethod {
    name: string;
    native: string;
    call: string;
    side: Side;
}

export interface OopProperty {
    name: string;
    getter: string | null;
    setter: string | null;
    value: string;
    side: Side;
}

export interface OopClass {
    name: string;
    parent: string | null;
    methods: OopMethod[];
    properties: OopProperty[];
}

export interface OopStaticClass {
    name: string;
    methods: OopMethod[];
    properties: OopProperty[];
}

export interface SandboxPolicy {
    openLibsClient: string[];
    openLibsServer: string[];
    removedGlobals: string[];
    restrictedOsFields: string[];
}

export interface ManifestKey {
    name: string;
    type: string;
    description: string;
}

export interface ApiGlobal {
    name: string;
    side: Side;
    type: string;
    description: string;
}

export interface ApiSnapshot {
    schema: number;
    luaVersion: string;
    functions: ApiFunction[];
    events: ApiEvent[];
    oop: {
        classes: OopClass[];
        statics: OopStaticClass[];
        elementClasses: { elementType: string; className: string }[];
    };
    policy: SandboxPolicy | null;
    manifestKeys: ManifestKey[];
    protectableExtensions: string[];
    globals: ApiGlobal[];
}

export const LUA_STDLIB = new Set([
    'assert', 'collectgarbage', 'error', 'getmetatable', 'ipairs', 'load', 'loadstring', 'next',
    'pairs', 'pcall', 'print', 'rawequal', 'rawget', 'rawlen', 'rawset', 'select', 'setmetatable',
    'tonumber', 'tostring', 'type', 'unpack', 'xpcall', 'warn',
    '_G', '_VERSION', 'coroutine', 'math', 'os', 'string', 'table', 'utf8',
]);

export class Api {
    readonly snapshot: ApiSnapshot;

    private readonly byName = new Map<string, ApiFunction>();
    private readonly eventsByName = new Map<string, ApiEvent>();
    private readonly classesByName = new Map<string, OopClass>();
    private readonly staticsByName = new Map<string, OopStaticClass>();
    private readonly manifestKeysByName = new Map<string, ManifestKey>();
    private readonly globalsByName = new Map<string, ApiGlobal>();
    private readonly memberIndex = new Map<string, OopMethod[]>();

    constructor(snapshot: ApiSnapshot) {
        this.snapshot = snapshot;
        for (const fn of snapshot.functions) this.byName.set(fn.name, fn);
        for (const ev of snapshot.events) this.eventsByName.set(ev.name, ev);
        for (const cls of snapshot.oop.classes) {
            this.classesByName.set(cls.name, cls);
            for (const m of cls.methods) {
                const list = this.memberIndex.get(m.name) ?? [];
                list.push(m);
                this.memberIndex.set(m.name, list);
            }
        }
        for (const cls of snapshot.oop.statics) this.staticsByName.set(cls.name, cls);
        for (const key of snapshot.manifestKeys) this.manifestKeysByName.set(key.name, key);
        for (const g of snapshot.globals) this.globalsByName.set(g.name, g);
    }

    static load(extensionPath: string): Api {
        const file = path.join(extensionPath, 'data', 'api.json');
        const raw = fs.readFileSync(file, 'utf8');
        return new Api(JSON.parse(raw) as ApiSnapshot);
    }

    get functions(): ApiFunction[] { return this.snapshot.functions; }
    get events(): ApiEvent[] { return this.snapshot.events; }
    get classes(): OopClass[] { return this.snapshot.oop.classes; }
    get statics(): OopStaticClass[] { return this.snapshot.oop.statics; }
    get globals(): ApiGlobal[] { return this.snapshot.globals; }
    get manifestKeys(): ManifestKey[] { return this.snapshot.manifestKeys; }

    fn(name: string): ApiFunction | undefined { return this.byName.get(name); }
    event(name: string): ApiEvent | undefined { return this.eventsByName.get(name); }
    class(name: string): OopClass | undefined { return this.classesByName.get(name); }
    staticClass(name: string): OopStaticClass | undefined { return this.staticsByName.get(name); }
    manifestKey(name: string): ManifestKey | undefined { return this.manifestKeysByName.get(name); }
    global(name: string): ApiGlobal | undefined { return this.globalsByName.get(name); }
    methodsNamed(name: string): OopMethod[] { return this.memberIndex.get(name) ?? []; }

    has(name: string): boolean { return this.byName.has(name); }

    membersOf(className: string): { methods: OopMethod[]; properties: OopProperty[] } {
        const methods: OopMethod[] = [];
        const properties: OopProperty[] = [];
        const seenM = new Set<string>();
        const seenP = new Set<string>();
        let cls = this.classesByName.get(className);
        let guard = 0;
        while (cls && guard++ < 16) {
            for (const m of cls.methods) if (!seenM.has(m.name)) { seenM.add(m.name); methods.push(m); }
            for (const p of cls.properties) if (!seenP.has(p.name)) { seenP.add(p.name); properties.push(p); }
            cls = cls.parent ? this.classesByName.get(cls.parent) : undefined;
        }
        return { methods, properties };
    }

    visibleFrom(side: Side): ApiFunction[] {
        if (side === 'shared') return this.snapshot.functions;
        return this.snapshot.functions.filter((f) => f.side === 'shared' || f.side === side);
    }

    isCallableFrom(fn: ApiFunction, side: Side): boolean {
        if (fn.side === 'shared') return true;
        return fn.side === side;
    }

    eventsFor(side: Side): ApiEvent[] {
        if (side === 'shared') return this.snapshot.events;
        return this.snapshot.events.filter((e) => e.side === side);
    }
}
