import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export const invoke = (command, args = {}) =>
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`;

export async function until(check, description) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        const result = await check();
        if (result) return result;
        await pause(100);
    }
    throw new Error(`Timed out: ${description}`);
}

async function unusedPort() {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

export class TestApp {
    directory = fileURLToPath(new URL('.work/window-tests/', import.meta.url));
    profile = path.resolve(process.env.APPDATA, 'org.calcpad-ce.window-tests');
    executable = path.join(this.directory, 'app/calcpad-window-tests.exe');
    runner = null;
    launches = 0;

    constructor() {
        if (path.dirname(this.profile) !== path.resolve(process.env.APPDATA)
            || path.basename(this.profile) !== 'org.calcpad-ce.window-tests') {
            throw new Error('Unexpected test profile path');
        }
        rmSync(this.profile, {recursive: true, force: true});
        mkdirSync(this.profile, {recursive: true});
    }

    async start(args = []) {
        this.port = await unusedPort();
        this.endpoint = `http://127.0.0.1:${this.port}`;
        this.runner = this.launch(args);
        this.exited = once(this.runner, 'exit');
        await until(async () => {
            try { return (await fetch(`${this.endpoint}/json`)).ok; }
            catch { return false; }
        }, 'debug port');
        const main = await this.window('main');
        await pause(300);
        return main;
    }

    launch(args) {
        return spawn(path.join(this.directory, 'helpers/deskrun.exe'), [
            'CalcpadWindowTests', '180', '--log', path.join(this.directory, `launch-${this.launches++}.log`),
            '--', this.executable, ...args,
        ], {cwd: path.dirname(this.executable), windowsHide: true, stdio: 'ignore', env: {
            ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${this.port}`,
        }});
    }

    async relaunch(args = []) {
        const runner = this.launch(args);
        const [code] = await once(runner, 'exit');
        if (code !== 0) throw new Error(`Repeat launch exited with ${code}`);
    }

    async evaluate(page, expression) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await once(socket, 'open');
        try {
            return await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Evaluation timed out')), 10000);
                socket.onmessage = event => {
                    const result = JSON.parse(event.data);
                    if (result.id !== 1) return;
                    clearTimeout(timeout);
                    if (result.error || result.result.exceptionDetails) {
                        reject(new Error(JSON.stringify(result.error ?? result.result.exceptionDetails)));
                    } else resolve(result.result.result.value);
                };
                socket.send(JSON.stringify({id: 1, method: 'Runtime.evaluate', params: {
                    expression, awaitPromise: true, returnByValue: true,
                }}));
            });
        } finally { socket.close(); }
    }

    async windows() {
        const pages = (await (await fetch(`${this.endpoint}/json`)).json()).filter(page => page.type === 'page');
        const result = new Map();
        for (const page of pages) {
            const state = await this.evaluate(page,
                `({label: window.__TAURI_INTERNALS__?.metadata.currentWindow.label, ready: !!window.calcpadTabs})`);
            if (state.ready) result.set(state.label, page);
        }
        return result;
    }

    window(label) {
        return until(async () => (await this.windows()).get(label), `${label} ready`);
    }

    async newWindow(page) {
        const label = await this.evaluate(page, invoke('new_window'));
        const opened = await this.window(label);
        await pause(300);
        return {label, page: opened};
    }

    async close(page, label) {
        await this.evaluate(page,
            `setTimeout(() => { void ${invoke('plugin:window|close', {label})}; }, 50); 'closing'`);
    }

    async closeAndWait(page, label) {
        await this.close(page, label);
        await until(async () => !(await this.windows()).has(label), `${label} closed`);
    }

    async stop(page, label) {
        await this.close(page, label);
        const [code] = await this.exited;
        if (code !== 0) throw new Error(`Application exited with ${code}`);
        this.runner = null;
    }

    geometry(page) {
        return this.evaluate(page, `(async () => ({
            position: await ${invoke('plugin:window|outer_position')},
            size: await ${invoke('plugin:window|inner_size')},
            maximized: await ${invoke('plugin:window|is_maximized')},
        }))()`);
    }

    async setGeometry(page, logicalSize, position) {
        await this.evaluate(page, invoke('plugin:window|set_size', {value: {Logical: logicalSize}}));
        await this.evaluate(page, invoke('plugin:window|set_position', {value: {Physical: position}}));
        await pause(100);
        return this.geometry(page);
    }

    async focus(page, label) {
        const title = `Calcpad window test focus: ${label}`;
        await this.evaluate(page, invoke('plugin:window|set_title', {label, value: title}));
        execFileSync(path.join(this.directory, 'helpers/deskrun.exe'), ['CalcpadWindowTests', 'notify-focus', title], {windowsHide: true});
        await pause(100);
    }

    fixture(name, content = 'a = 1') {
        const file = path.join(this.directory, name);
        writeFileSync(file, content);
        return file;
    }

    fileOpen(page, file) {
        return until(async () => this.evaluate(page,
            `window.calcpadTabs.all.some(tab => tab.filePath?.toLowerCase() === ${JSON.stringify(file.toLowerCase())})`),
        `${path.basename(file)} open`);
    }

    async healthy(page) {
        return this.evaluate(page, `(async () => {
            const url = await ${invoke('server_url')};
            if (!url) return false;
            const token = await ${invoke('server_token')};
            return (await fetch(url + '/api/calcpad/health', {headers: {'X-Calcpad-Token': token}})).ok;
        })()`);
    }

    serverProcesses(action) {
        const executable = path.join(this.directory, 'app/Calcpad.Server.exe').replaceAll("'", "''");
        return execFileSync('powershell', ['-NoProfile', '-Command',
            `$servers = @(Get-CimInstance Win32_Process -Filter "Name='Calcpad.Server.exe'" | Where-Object { $_.ExecutablePath -eq '${executable}' }); ${action}`,
        ], {encoding: 'utf8'}).trim();
    }

    async crashAndRecover(page) {
        const oldUrl = await this.evaluate(page, invoke('server_url'));
        this.serverProcesses("if ($servers.Count -ne 1) { throw 'Expected one test backend' }; Stop-Process -Id $servers[0].ProcessId -Force");
        await until(async () => {
            const url = await this.evaluate(page, invoke('server_url'));
            return url && url !== oldUrl && await this.healthy(page);
        }, 'backend recovered');
    }

    dispose() {
        const executable = this.executable.replaceAll("'", "''");
        execFileSync('powershell', ['-NoProfile', '-Command',
            `Get-CimInstance Win32_Process -Filter "Name='calcpad-window-tests.exe'" | Where-Object { $_.ExecutablePath -eq '${executable}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
        ], {encoding: 'utf8'});
        this.runner?.kill();
    }
}
