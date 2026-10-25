import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { TestApp, invoke, until } from './test-app.mjs';

describe('desktop windows', {skip: process.platform !== 'win32', concurrency: false}, () => {
    test('new windows focus their webview when opened from an existing window or a repeat launch', {timeout: 90000}, async t => {
        const app = new TestApp();
        t.after(() => app.dispose());
        const main = await app.start();

        for (const source of ['command', 'launch', 'command']) {
            await app.focus(main, 'main');
            let opened;
            if (source === 'command') {
                opened = await app.newWindow(main);
            } else {
                await app.relaunch();
                const [label, page] = await until(async () => {
                    const windows = await app.windows();
                    return windows.size === 2 && [...windows].find(([label]) => label !== 'main');
                }, 'repeat launch window ready');
                opened = {label, page};
            }

            await until(() => app.evaluate(opened.page, 'document.hasFocus()'), 'new webview focused');
            assert.equal(await app.evaluate(main, 'document.hasFocus()'), false);
            await app.closeAndWait(opened.page, opened.label);
        }

        await app.stop(main, 'main');
    });

    test('repeat launches open windows; files open tabs in the last-focused window', {timeout: 90000}, async t => {
        const app = new TestApp();
        t.after(() => app.dispose());
        const main = await app.start();
        await app.relaunch();
        const second = await until(async () => {
            const windows = await app.windows();
            return windows.size === 2 && [...windows].find(([label]) => label !== 'main');
        }, 'second launch opens a window');
        const [secondLabel, secondPage] = second;

        const title = await app.evaluate(main, 'document.title');
        assert.equal(await app.evaluate(secondPage, 'document.title'), title);
        assert.equal(await app.evaluate(secondPage, invoke('plugin:window|title')), title);

        const firstFile = app.fixture('first worksheet.cpd');
        await app.focus(secondPage, secondLabel);
        await app.relaunch([firstFile]);
        await app.fileOpen(secondPage, firstFile);
        assert.equal((await app.windows()).size, 2);
        assert.equal(await app.evaluate(main, 'window.calcpadTabs.all.some(tab => tab.filePath)'), false);
        assert.equal(await app.evaluate(secondPage, 'window.calcpadActiveEditor.getValue()'), 'a = 1');
        assert.doesNotMatch(await app.evaluate(secondPage, 'document.title'), /\s\(\d+\)$/);

        const secondFile = app.fixture('second worksheet.CPD', 'b = 2');
        const thirdFile = app.fixture('third worksheet.cpd', 'c = 3');
        await app.focus(main, 'main');
        await app.relaunch([secondFile, thirdFile]);
        await app.fileOpen(main, secondFile);
        await app.fileOpen(main, thirdFile);
        assert.equal((await app.windows()).size, 2);
        assert.equal(await app.evaluate(secondPage, 'window.calcpadTabs.all.filter(tab => tab.filePath).length'), 1);

        await app.closeAndWait(main, 'main');
        const afterClose = app.fixture('after main closes.cpd');
        await app.relaunch([afterClose]);
        await app.fileOpen(secondPage, afterClose);
        assert.equal((await app.windows()).size, 1);
        await app.relaunch();
        const later = await until(async () => {
            const windows = await app.windows();
            return windows.size === 2 && [...windows].find(([label]) => label !== secondLabel);
        }, 'repeat launch after main closed');
        await app.closeAndWait(later[1], later[0]);
        await app.stop(secondPage, secondLabel);
    });

    test('closing windows preserves other buffers and transfers backend recovery and session saving', {timeout: 90000}, async t => {
        const app = new TestApp();
        t.after(() => app.dispose());
        const main = await app.start();
        const second = await app.newWindow(main);
        const third = await app.newWindow(main);
        for (const [page, content] of [[main, 'main = 1'], [second.page, 'secondary = 2'], [third.page, 'third = 3']]) {
            await app.evaluate(page, `window.testPrompts = 0;
                window.calcpadBridge.confirmThreeWay = async () => { window.testPrompts++; return 'no'; };
                window.calcpadActiveEditor.setValue(${JSON.stringify(content)});`);
        }
        await app.evaluate(main, `window.calcpadBridge.confirmThreeWay = async () => { window.testPrompts++; return 'cancel'; };`);
        await app.close(main, 'main');
        await until(async () => await app.evaluate(main, 'window.testPrompts') === 1, 'cancel prompt');
        assert.equal((await app.windows()).size, 3);
        assert.equal(await app.evaluate(second.page, 'window.testPrompts'), 0);
        assert.equal(await app.evaluate(third.page, 'window.testPrompts'), 0);

        await app.evaluate(main, `window.calcpadBridge.confirmThreeWay = async () => 'no';`);
        await app.closeAndWait(main, 'main');
        assert.equal((await app.windows()).size, 2);
        assert.equal(await app.evaluate(second.page, invoke('primary_window')), second.label);
        assert.equal(await app.evaluate(second.page, 'window.calcpadActiveEditor.getValue()'), 'secondary = 2');
        assert.equal(await app.evaluate(third.page, 'window.calcpadActiveEditor.getValue()'), 'third = 3');
        assert.equal(await app.evaluate(second.page, 'window.testPrompts'), 0);
        assert.ok(await app.healthy(second.page));
        await app.crashAndRecover(second.page);
        assert.equal(app.serverProcesses('$servers.Count'), '1');

        const later = await app.newWindow(second.page);
        assert.equal(await app.evaluate(later.page, invoke('primary_window')), second.label);
        assert.ok(await app.healthy(later.page));
        await app.closeAndWait(later.page, later.label);
        await app.closeAndWait(second.page, second.label);
        assert.equal((await app.windows()).size, 1);
        assert.equal(await app.evaluate(third.page, invoke('primary_window')), third.label);
        assert.equal(await app.evaluate(third.page, 'window.testPrompts'), 0);
        await app.crashAndRecover(third.page);

        const file = app.fixture('surviving session.cpd');
        await app.focus(third.page, third.label);
        await app.relaunch([file]);
        await app.fileOpen(third.page, file);
        await app.stop(third.page, third.label);
        assert.equal(app.serverProcesses('$servers.Count'), '0');
        const workspace = JSON.parse(readFileSync(path.join(app.profile, 'workspace.json'), 'utf8'));
        assert.ok(workspace.state.openFiles.includes(file));
    });

    test('main geometry is saved while secondary windows always use defaults', {timeout: 90000}, async t => {
        const app = new TestApp();
        t.after(() => app.dispose());
        let main = await app.start();
        const defaults = await app.geometry(main);
        assert.equal(defaults.maximized, false);
        const position = {x: defaults.position.x + 40, y: defaults.position.y + 40};
        const changed = await app.setGeometry(main, {width: 1000, height: 700}, position);
        await app.stop(main, 'main');

        const stateFile = path.join(app.profile, '.window-state.json');
        const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
        writeFileSync(stateFile, JSON.stringify({...saved, 'main-2': {...saved.main, maximized: true}}));
        main = await app.start();
        assert.deepEqual(await app.geometry(main), changed);

        const second = await app.newWindow(main);
        assert.deepEqual(await app.geometry(second.page), defaults);

        await app.setGeometry(main, {width: 1000, height: 700}, position);
        await app.evaluate(main, invoke('plugin:window|maximize'));
        await until(async () => (await app.geometry(main)).maximized, 'window maximized');
        const third = await app.newWindow(main);
        assert.deepEqual(await app.geometry(third.page), defaults);

        await app.setGeometry(second.page, {width: 1100, height: 750}, position);
        await app.closeAndWait(second.page, second.label);
        const fourth = await app.newWindow(main);
        assert.deepEqual(await app.geometry(fourth.page), defaults);
        await app.closeAndWait(main, 'main');
        await app.closeAndWait(third.page, third.label);
        await app.setGeometry(fourth.page, {width: 1100, height: 750}, position);
        await app.stop(fourth.page, fourth.label);

        main = await app.start();
        assert.deepEqual(await app.geometry(main), changed);
        await app.stop(main, 'main');
    });
});
