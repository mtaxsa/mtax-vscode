export type TemplateId = 'basic' | 'server' | 'client' | 'nui' | 'loadscreen';

export interface TemplateFile {
    path: string;
    content: string;
}

export interface Template {
    id: TemplateId;
    label: string;
    description: string;
    files(name: string, author: string): TemplateFile[];
}

const manifest = (name: string, author: string, body: string) =>
    `resource_name    = "${name}"
resource_version = "1.0.0"
resource_author  = "${author}"

${body}`;

const SERVER_MAIN = `addEventHandler("onResourceStart", resourceRoot, function()
    outputDebugString("resource started")
end)

addCommandHandler("hello", function(player)
    outputChatBox("Hello, " .. getPlayerName(player) .. "!", player, 0, 200, 120)
end)
`;

const CLIENT_MAIN = `addEventHandler("onClientResourceStart", resourceRoot, function()
    outputDebugString("client side ready")
end)
`;

const SHARED_UTIL = `-- Runs on both sides. Anything declared here is visible to the server and
-- to every client, so keep secrets out of it.

function formatMoney(amount)
    return ("$%s"):format(tostring(math.floor(amount or 0)))
end
`;

export const TEMPLATES: Template[] = [
    {
        id: 'basic',
        label: 'Server + client',
        description: 'A server script, a client script and a shared helper.',
        files: (name, author) => [
            {
                path: 'mtaxmanifest.lua',
                content: manifest(name, author, `server_files = {
    "server/main.lua",
}

client_files = {
    "client/main.lua",
}

shared_files = {
    "shared/util.lua",
}
`),
            },
            { path: 'server/main.lua', content: SERVER_MAIN },
            { path: 'client/main.lua', content: CLIENT_MAIN },
            { path: 'shared/util.lua', content: SHARED_UTIL },
        ],
    },
    {
        id: 'server',
        label: 'Server only',
        description: 'One server script. Nothing is sent to the client.',
        files: (name, author) => [
            {
                path: 'mtaxmanifest.lua',
                content: manifest(name, author, `server_files = {
    "server/main.lua",
}
`),
            },
            { path: 'server/main.lua', content: SERVER_MAIN },
        ],
    },
    {
        id: 'client',
        label: 'Client only',
        description: 'One client script, for HUD and rendering work.',
        files: (name, author) => [
            {
                path: 'mtaxmanifest.lua',
                content: manifest(name, author, `client_files = {
    "client/main.lua",
}
`),
            },
            {
                path: 'client/main.lua',
                content: `local screenW, screenH = guiGetScreenSize()

addEventHandler("onClientRender", root, function()
    dxDrawText("${'${resource}'}", screenW - 220, 20, screenW - 20, 40, tocolor(255, 255, 255, 180), 1, "default-bold", "right")
end)
`.replace('${resource}', 'hello from MTAX'),
            },
        ],
    },
    {
        id: 'nui',
        label: 'With a NUI page',
        description: 'Client script plus an HTML interface wired through sendNuiMessage.',
        files: (name, author) => [
            {
                path: 'mtaxmanifest.lua',
                content: manifest(name, author, `server_files = {
    "server/main.lua",
}

client_files = {
    "client/main.lua",
}

files = {
    "ui/index.html",
    "ui/style.css",
    "ui/app.js",
}

ui_page = "ui/index.html"
`),
            },
            { path: 'server/main.lua', content: SERVER_MAIN },
            {
                path: 'client/main.lua',
                content: `local visible = false

local function setVisible(state)
    visible = state
    setNuiFocus(state, state)
    sendNuiMessage({ type = "visibility", visible = state })
end

registerNuiCallback("close", function()
    setVisible(false)
end)

addEventHandler("onClientResourceStart", resourceRoot, function()
    setVisible(false)
end)

bindKey("F2", "down", function()
    setVisible(not visible)
end)
`,
            },
            {
                path: 'ui/index.html',
                content: `<!doctype html>
<html lang="pt-BR">
<head>
    <meta charset="utf-8">
    <title>${'RESOURCE'}</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <div id="panel" hidden>
        <h1>${'RESOURCE'}</h1>
        <button id="close">Fechar</button>
    </div>
    <script src="app.js"></script>
</body>
</html>
`,
            },
            {
                path: 'ui/style.css',
                content: `body {
    margin: 0;
    font-family: system-ui, sans-serif;
    background: transparent;
    color: #fff;
}

#panel {
    position: absolute;
    inset: 50% auto auto 50%;
    transform: translate(-50%, -50%);
    padding: 24px 32px;
    border-radius: 12px;
    background: rgba(20, 16, 32, 0.92);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
}
`,
            },
            {
                path: 'ui/app.js',
                content: `const panel = document.getElementById("panel");

window.addEventListener("message", (event) => {
    const data = event.data;
    if (data.type === "visibility") {
        panel.hidden = !data.visible;
    }
});

document.getElementById("close").addEventListener("click", () => {
    fetch("https://" + window.location.hostname + "/close", {
        method: "POST",
        body: JSON.stringify({}),
    });
});
`,
            },
        ],
    },
    {
        id: 'loadscreen',
        label: 'Loading screen',
        description: 'Downloaded before everything else, dismissed by hand.',
        files: (name, author) => [
            {
                path: 'mtaxmanifest.lua',
                content: manifest(name, author, `client_files = {
    "client/main.lua",
}

files = {
    "ui/index.html",
}

ui_page = "ui/index.html"

loadscreen = true
loadscreen_manual_shutdown = true
`),
            },
            {
                path: 'client/main.lua',
                content: `-- With loadscreen_manual_shutdown the screen stays up until this runs.
setTimer(function()
    shutdownLoadingScreen()
end, 3000, 1)
`,
            },
            {
                path: 'ui/index.html',
                content: `<!doctype html>
<html lang="pt-BR">
<head>
    <meta charset="utf-8">
    <title>Carregando</title>
    <style>
        body { margin: 0; height: 100vh; display: grid; place-items: center;
               background: #12101c; color: #fff; font-family: system-ui, sans-serif; }
        #progress { margin-top: 12px; opacity: 0.7; }
    </style>
</head>
<body>
    <div>
        <h1>MTAX</h1>
        <div id="progress">0 / 0</div>
    </div>
    <script>
        window.addEventListener("message", (event) => {
            const data = event.data;
            if (data.type === "loadProgress") {
                document.getElementById("progress").textContent =
                    (data.total - data.pending) + " / " + data.total;
            }
        });
    </script>
</body>
</html>
`,
            },
        ],
    },
];

export function renderTemplate(template: Template, name: string, author: string): TemplateFile[] {
    return template.files(name, author).map((file) => ({
        path: file.path,
        content: file.content.split('RESOURCE').join(name),
    }));
}
