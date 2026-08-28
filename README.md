<h1 align="center">MTAX — Lua Modding</h1>

<p align="center">
  <img src="images/icon.png" alt="MTAX" width="128">
</p>

<p align="center">
  <strong>Write Lua 5.4 mods for MTAX without leaving the editor.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-%5E1.85.0-007ACC?logo=visualstudiocode&logoColor=white" alt="VS Code ^1.85.0">
  <img src="https://img.shields.io/badge/Lua-5.4-2C2D72?logo=lua&logoColor=white" alt="Lua 5.4">
  <img src="https://img.shields.io/badge/natives-1059-success" alt="1059 natives">
  <img src="https://img.shields.io/badge/events-172-success" alt="172 events">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
</p>

---

This extension knows the **1,059 native functions**, the **172 events**, the **OOP API**
(26 classes plus 14 static classes), the **sandbox** and the `mtaxmanifest.lua` format —
all extracted straight from the engine source and the wiki, never typed by hand.

## Table of contents

- [Features](#features)
- [Commands](#commands)
- [lua-language-server](#lua-language-server-optional)
- [Configuration](#configuration)
- [Where the data comes from](#where-the-data-comes-from)
- [Developing the extension](#developing-the-extension)
- [License](#license)

---

## Features

### Completion that knows which side the file runs on

As you type in a script, natives show up with their signature, description and example.
The ones that **do not exist** on that side are still offered — flagged with
`⚠ server only` and sorted last — instead of being hidden, because knowing the function
exists on the other side is usually the missing piece of information.

The side comes from the manifest: a file listed in `server_files` is server code, full stop.
With no manifest, the extension infers it from the folder (`server/`, `client/`) and from the
file name (`main_s.lua`, `_c.lua`), and the status bar reads `MTAX server?` — the question mark
telling you it was a guess. Clicking the status bar pins the side by hand.

### Event names where event names belong

Inside the `eventName` argument of `addEventHandler`, `triggerClientEvent`, `triggerServerEvent`
and friends, completion swaps the natives for **events** — along with the parameters the handler
will receive, the `source` element and whether the event can be cancelled. Events the resource
registers itself with `addEvent("...")` join the list.

### Hover and signature help

Hovering shows the signature, parameters with type and default, the return value, the OOP
equivalent and a link to the wiki. While you type the arguments, the current parameter is
highlighted — and when a native has both a server and a client variant (`createVehicle`), the
variant for the current side is the one already selected.

All of it in **English or Portuguese**, following the VS Code display language or the
`mtax.docsLanguage` setting.

### Problems the server would reject

| Problem | Example |
| --- | --- |
| Native from the wrong side | `bindKey` (client) called from a server script |
| Function that does not exist in MTAX | `outputChatBox`, `guiGetText`, `getPlayerMoney` — MTA natives MTAX does not have |
| Typo | `setElemenPosition` → *did you mean `setElementPosition`?* |
| Event from the wrong side | `onClientRender` registered in a server script |
| Sandbox | `require`, `dofile`, `io.open`, `package`, `debug`, `os.execute` |
| Script missing from the manifest | a `.lua` in the folder that no list declares — it will never run |

Every rule carries its own severity and can be turned off. The ones worth fixing
automatically offer a quick fix (`Ctrl+.`).

> Run over 140,000 lines of real server resources, this rule set flagged 38 wrong-side calls,
> 90 non-existent functions, 2 typos and 3 sandbox uses — **without a single false positive**.
> One-sided calls inside a `shared` script are off by default, because a shared script tends to
> branch on `localPlayer` and call both sides on purpose.

### A real `mtaxmanifest.lua`

The manifest is validated with the **same rules the server uses**
(`Server/src/modules/resources/manifest.cpp`):

- relative path, with `/`, no `..`, no `\`, no `:`;
- `.lua` only in `server_files` / `client_files` / `shared_files`, assets only in `files`;
- declared file that does not exist in the folder;
- `ui_page` that is not a page, or that is not listed in `files`;
- `map_files` trying to borrow from another resource;
- `exports` that is not a function name;
- `loadscreen_manual_shutdown` without `loadscreen`;
- `escrow_files` (read by the portal) pointing at a file the build does not protect;
- globals the manifest sandbox does not have (`print`, `os`, `require`…).

On top of that: completion for the keys, **path** completion inside the lists (only `.lua` in a
script list, only assets in `files`), and `Ctrl+click` on a path opens the file — including
cross-resource borrows such as `":other-resource/file.lua"`.

## Commands

| Command | Shortcut | What it does |
| --- | --- | --- |
| `MTAX: New Resource…` | — | Creates the folder with a manifest and scripts. Five layouts: server + client, server only, client only, with NUI, loading screen |
| `MTAX: New Script…` | — | Creates the script **and** declares it in the right manifest list |
| `MTAX: Search the API…` | `Ctrl+Alt+M` | Searches the 1,059 natives; inserts the call or opens the documentation |
| `MTAX: Open documentation…` | `Ctrl+Alt+D` | Opens the wiki page for the symbol under the cursor |
| `MTAX: Convert meta.xml…` | — | Converts a legacy MTA resource to `mtaxmanifest.lua` |
| `MTAX: Set up lua-language-server` | — | Points sumneko at the MTAX definitions |
| `MTAX: Set the side of the current file` | — | Pins client / server / shared when inference gets it wrong |
| `MTAX: Regenerate the API…` | — | Regenerates everything from the local `MTAX-Purple/` and `wiki/` |

On macOS the shortcuts are `Cmd+Alt+M` and `Cmd+Alt+D`.

## lua-language-server (optional)

The extension ships generated **LuaCATS** files (`definitions/`) with the 1,059 natives
annotated, the OOP classes with their inheritance, and `Vector2/3/4` and `Matrix`. If
[sumneko.lua](https://marketplace.visualstudio.com/items?itemName=sumneko.lua) is installed, the
extension offers to point it at those definitions — giving you real type inference layered on top
of everything described above. It also disables `io`, `package` and `debug` in sumneko's
completion, since the MTAX sandbox does not have those libraries.

None of this is required: without sumneko, the extension works on its own.

## Configuration

| Key | Default | What it controls |
| --- | --- | --- |
| `mtax.enable` | `true` | Turns the whole language layer on or off |
| `mtax.docsLanguage` | `auto` | `auto`, `en` or `pt` in hovers and completion |
| `mtax.diagnostics.enable` | `true` | Turns problem reporting on |
| `mtax.diagnostics.wrongSide` | `warning` | Native from one side called from the other |
| `mtax.diagnostics.sharedSideCalls` | `off` | The same, but inside a `shared` script |
| `mtax.diagnostics.unknownNative` | `warning` | Function shaped like a native that does not exist in MTAX |
| `mtax.diagnostics.typos` | `warning` | Name one or two characters away from a real native |
| `mtax.diagnostics.sandbox` | `error` | `require`, `io`, `package`, `os.execute`… |
| `mtax.diagnostics.manifest` | `true` | Validation of `mtaxmanifest.lua` |
| `mtax.diagnostics.deprecatedMeta` | `true` | Points out `meta.xml` files and offers to convert them |
| `mtax.completion.oop` | `true` | Suggest the OOP API alongside the plain natives |
| `mtax.completion.snippets` | `true` | Expand a native into a call with its arguments as tab stops |
| `mtax.luals.autoConfigure` | `ask` | `ask`, `always` or `never` for configuring sumneko |
| `mtax.statusBar` | `true` | Show the file side in the status bar |
| `mtax.author` | `""` | Name written to `resource_author` when scaffolding a resource |
| `mtax.sourceRoot` | `""` | Folder holding `MTAX-Purple/` and `wiki/`, used to regenerate the API |

## Where the data comes from

`data/api.json` and `definitions/*.lua` are **generated**, never edited by hand:

| Source | What comes out of it |
| --- | --- |
| `Shared/src/lua_api/catalog/functions.h` | the 1,059 natives, with side and confidence level |
| `Shared/src/lua_api/oop/oopclasses.h` | OOP classes, methods, properties, inheritance |
| `Shared/src/lua_api/sandbox/policy.h` | open libraries, removed globals, restricted `os` fields |
| `Shared/src/lua_api/prelude/prelude.h` | pure-Lua helpers (`bit*`, `utf*`, `split`, `inspect`, `ref`…) |
| `Server/src/modules/resources/manifest.cpp` | the manifest keys and the validation rules |
| `wiki/src/content/docs/{en,pt}` | descriptions, signatures, parameters, returns, examples and events |

To regenerate after changing the engine or the wiki:

```bash
npm run generate          # searches upwards for MTAX-Purple/ and wiki/
npm run generate -- --root "D:/Projetos MTAX"
```

Or, from inside VS Code, run `MTAX: Regenerate the API from local MTAX sources`.

Current coverage: **1,059 / 1,059** signatures and **1,058 / 1,059** descriptions.

## Developing the extension

```bash
npm install
npm run generate     # data/api.json + definitions/
npm run compile      # bundle into dist/
npm run watch        # rebuild on save
npm test             # 35 tests: scanner, manifest, API and end-to-end activation
npm run package      # produces the .vsix
```

`F5` in VS Code opens a window with the extension loaded.

The tests run against the real bundle with a stub of the VS Code API, so a hang on activation or
a broken provider shows up before packaging.

### Project layout

```
tools/generate-api.mjs     reads engine + wiki, writes data/ and definitions/
src/api/model.ts           loads and indexes the snapshot
src/util/lua.ts            Lua 5.4 scanner (masks comments and strings)
src/manifest/              parsing, path rules, globs, side, resource symbols
src/features/              completion, hover, signature help, diagnostics, quick fixes,
                           links, status bar, commands, scaffolding, luals
```

The scanner produces a *masked* copy of the document — same length, same lines, with comments and
string contents replaced by spaces. Everything else works on that copy, so no rule mistakes
`-- createVehicle(411)` for a call, and the offsets still point into the real document.

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 CMR Services.
