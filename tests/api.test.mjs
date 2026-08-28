import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Api } from '../out/api/model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = Api.load(ROOT);

test('the snapshot carries the whole catalog', () => {
    assert.ok(api.functions.length > 1000, `only ${api.functions.length} natives`);
    assert.ok(api.events.length > 150, `only ${api.events.length} events`);
    assert.ok(api.classes.length > 20);
    assert.equal(api.snapshot.luaVersion, '5.4');
});

test('every native has a side, a trust level and a signature', () => {
    const sides = new Set(['client', 'server', 'shared']);
    const trusts = new Set(['sandboxed', 'authoritative', 'bridge']);
    const missing = [];
    for (const fn of api.functions) {
        assert.ok(sides.has(fn.side), `${fn.name} has side ${fn.side}`);
        assert.ok(trusts.has(fn.trust), `${fn.name} has trust ${fn.trust}`);
        if (!fn.variants?.length) missing.push(fn.name);
    }
    assert.deepEqual(missing, [], 'natives without a parsed signature');
});

test('side visibility matches the engine rules', () => {
    const createElement = api.fn('createElement');
    assert.equal(createElement.side, 'shared');
    assert.ok(api.isCallableFrom(createElement, 'client'));
    assert.ok(api.isCallableFrom(createElement, 'server'));

    const kickPlayer = api.fn('kickPlayer');
    assert.equal(kickPlayer.side, 'server');
    assert.ok(api.isCallableFrom(kickPlayer, 'server'));
    assert.ok(!api.isCallableFrom(kickPlayer, 'client'));
    assert.ok(!api.isCallableFrom(kickPlayer, 'shared'), 'a shared script also runs on the client');

    const getLocalPlayer = api.fn('getLocalPlayer');
    assert.equal(getLocalPlayer.side, 'client');
    assert.ok(!api.isCallableFrom(getLocalPlayer, 'server'));
});

test('signatures parse into ordered parameters', () => {
    const createVehicle = api.fn('createVehicle');
    const server = createVehicle.variants.find((v) => v.side === 'server');
    assert.equal(server.returnType, 'vehicle');
    assert.deepEqual(server.params.slice(0, 4).map((p) => p.name), ['model', 'x', 'y', 'z']);
    assert.equal(server.params[0].optional, false);
    assert.equal(server.params.find((p) => p.name === 'rx').optional, true);
    assert.equal(server.params.find((p) => p.name === 'rx').default, '0');

    const client = createVehicle.variants.find((v) => v.side === 'client');
    assert.equal(client.params[1].optional, true, 'the client takes the position optionally');
});

test('event name arguments are discoverable from the signature', () => {
    for (const [name, index] of [['addEventHandler', 0], ['triggerClientEvent', 1], ['triggerServerEvent', 0]]) {
        const params = api.fn(name).variants[0].params;
        const at = params.findIndex((p) => /^eventName$/i.test(p.name));
        assert.equal(at, index, `${name} takes eventName at ${at}, expected ${index}`);
    }
});

test('OOP members resolve through the inheritance chain', () => {
    const { methods, properties } = api.membersOf('Player');
    assert.ok(methods.some((m) => m.name === 'getName'), 'Player:getName');
    assert.ok(methods.some((m) => m.native === 'setElementPosition'), 'inherited from Element');
    assert.ok(properties.some((p) => p.name === 'position'));

    const vehicle = api.class('Vehicle');
    assert.equal(vehicle.parent, 'Element');
});

test('every OOP method points at a real native', () => {
    const dangling = [];
    for (const cls of [...api.classes, ...api.statics]) {
        for (const m of cls.methods) if (!api.fn(m.native)) dangling.push(`${cls.name}:${m.name} -> ${m.native}`);
        for (const p of cls.properties ?? []) {
            if (p.getter && !api.fn(p.getter)) dangling.push(`${cls.name}.${p.name} getter -> ${p.getter}`);
            if (p.setter && !api.fn(p.setter)) dangling.push(`${cls.name}.${p.name} setter -> ${p.setter}`);
        }
    }
    assert.deepEqual(dangling, []);
});

test('the sandbox policy came through', () => {
    const policy = api.snapshot.policy;
    assert.ok(policy.removedGlobals.includes('require'));
    assert.ok(policy.restrictedOsFields.includes('execute'));
    assert.ok(!policy.openLibsClient.includes('io'));
    // loadfile is removed as a Lua global but reintroduced as a native
    assert.ok(policy.removedGlobals.includes('loadfile'));
    assert.ok(api.has('loadfile'));
});

test('events know their side and keep their parameters', () => {
    const join = api.event('onPlayerJoin');
    assert.equal(join.side, 'server');

    const render = api.event('onClientRender');
    assert.equal(render.side, 'client');

    const withParams = api.events.filter((e) => e.params.length);
    assert.ok(withParams.length > 80, `only ${withParams.length} events have documented parameters`);
});

test('manifest keys cover what the server reads', () => {
    const names = api.manifestKeys.map((k) => k.name);
    for (const key of [
        'resource_name', 'resource_version', 'resource_author', 'resource_info',
        'server_files', 'client_files', 'shared_files', 'files', 'map_files',
        'ui_page', 'loadscreen', 'loadscreen_manual_shutdown', 'exports',
    ]) {
        assert.ok(names.includes(key), `${key} is missing`);
    }
});
