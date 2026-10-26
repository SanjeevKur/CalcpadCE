import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { TestApp, invoke, until } from './test-app.mjs';

async function dragTab(app, source, tabId, target, beforeId, {cancel = false, outside = false} = {}) {
    await app.setGeometry(source, {width: 1400, height: 700}, {x: 10, y: 10});
    if (target !== source) await app.setGeometry(target, {width: 1400, height: 700}, {x: 10, y: 10});
    const point = await app.evaluate(source, `(() => {
        const rect = document.querySelector('[data-tab-id="${tabId}"]').getBoundingClientRect();
        return {x: rect.left + 20, y: rect.top + rect.height / 2};
    })()`);
    const destination = outside ? null : await app.evaluate(target, `(() => {
        const element = ${beforeId ? `document.querySelector('[data-tab-id="${beforeId}"]')` : "document.querySelector('.tab-new')"};
        const rect = element.getBoundingClientRect();
        return {windowId: window.__TAURI_INTERNALS__.metadata.currentWindow.label,
            x: rect.left + 12, y: rect.top + rect.height / 2};
    })()`);
    // Native hit testing is simulated; pointer capture, DOM events and inter-window delivery are real.
    await app.evaluate(source, invoke('test_set_tab_drag_target', {target: destination}));
    await app.cdp(source, 'Input.dispatchMouseEvent', {type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1});
    await app.cdp(source, 'Input.dispatchMouseEvent', {type: 'mouseMoved', x: point.x + 10, y: point.y, button: 'left', buttons: 1});
    if (cancel) await app.cdp(source, 'Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
    await app.cdp(source, 'Input.dispatchMouseEvent', {type: 'mouseReleased', x: point.x + 10, y: point.y, button: 'left', buttons: 0, clickCount: 1});
}

describe('desktop windows', {skip: process.platform !== 'win32', concurrency: false}, () => {
    test('document tabs reorder without losing undo history and cancelled drags leave them in place', {timeout: 90000}, async t => {
        const app = new TestApp();
        t.after(() => app.dispose());
        const main = await app.start();
        const ids = await app.evaluate(main, `(() => {
            const tabs = window.calcpadTabs;
            const scratch = tabs.activeId;
            const ids = ['A', 'B', 'C'].map(title => tabs.newUntitled(title + ' = 1', title));
            tabs.close(scratch);
            tabs.activate(ids[0]);
            window.calcpadActiveEditor.executeEdits('test', [{range: {startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 6}, text: '2'}]);
            return ids;
        })()`);
        await dragTab(app, main, ids[0], main, ids[2]);
        await until(async () => (await app.evaluate(main, 'window.calcpadTabs.all.map(tab => tab.title).join()')) === 'B,A,C', 'tabs reordered');
        assert.equal(await app.evaluate(main, 'window.calcpadTabs.activeId'), ids[0]);
        assert.equal(await app.evaluate(main, 'window.calcpadTabs.isDirty()'), true);
        await app.evaluate(main, 'window.calcpadActiveEditor.getModel().undo()');
        assert.equal(await app.evaluate(main, 'window.calcpadActiveEditor.getValue()'), 'A = 1');
        assert.equal(await app.evaluate(main, 'window.calcpadTabs.isDirty()'), false);

        await dragTab(app, main, ids[0], main, ids[1], {cancel: true});
        await dragTab(app, main, ids[0], main, null, {outside: true});
        assert.deepEqual(await app.evaluate(main, 'window.calcpadTabs.all.map(tab => tab.title)'), ['B', 'A', 'C']);
        await dragTab(app, main, ids[1], main, null);
        await until(async () => (await app.evaluate(main, 'window.calcpadTabs.all.map(tab => tab.title).join()')) === 'A,C,B', 'tab moved to end');
        await app.stop(main, 'main');
    });

    test('tabs move between windows with unsaved content, paths, cursor positions and recovery drafts', {timeout: 90000}, async t => {
        const app = new TestApp();
        t.after(() => app.dispose());
        const main = await app.start();
        const second = await app.newWindow(main);
        const original = await app.evaluate(main, `(() => {
            window.testPrompts = 0;
            window.calcpadBridge.confirmThreeWay = async () => { window.testPrompts++; return 'cancel'; };
            window.calcpadActiveEditor.setValue('a = 1\\nb = 2');
            window.calcpadActiveEditor.setPosition({lineNumber: 2, column: 3});
            return window.calcpadTabs.activeTab;
        })()`);
        await dragTab(app, main, original.id, second.page, null);
        await until(async () => await app.evaluate(second.page, 'window.calcpadActiveEditor.getValue()') === 'a = 1\nb = 2', 'unsaved document received');
        await until(async () => !(await app.evaluate(main, 'window.calcpadTabs.all')).some(tab => tab.id === original.id), 'source tab removed');
        assert.equal(await app.evaluate(second.page, 'window.calcpadTabs.count'), 1);
        assert.equal(await app.evaluate(second.page, 'window.calcpadTabs.isDirty()'), true);
        assert.equal(await app.evaluate(second.page, 'window.calcpadTabs.activeTab.title'), original.title);
        assert.deepEqual(await app.evaluate(second.page, 'window.calcpadActiveEditor.getPosition()'), {lineNumber: 2, column: 3});
        assert.equal(await app.evaluate(main, 'window.testPrompts'), 0);
        await until(() => app.evaluate(second.page, `(async () => (await ${invoke('draft_list')}).some(draft => draft.filePath === null))()`), 'destination autosave');

        const file = app.fixture('dragged worksheet.cpd', 'saved = 1');
        await app.focus(main, 'main');
        await app.relaunch([file]);
        await app.fileOpen(main, file);
        const fileTab = await app.evaluate(main, 'window.calcpadTabs.activeTab');
        await dragTab(app, main, fileTab.id, second.page, null);
        await app.fileOpen(second.page, file);
        await until(async () => !(await app.evaluate(main, 'window.calcpadTabs.all')).some(tab => tab.filePath === file), 'saved source removed');
        assert.equal(await app.evaluate(second.page, 'window.calcpadTabs.isDirty()'), false);
        assert.equal(readFileSync(file, 'utf8'), 'saved = 1');
        await app.evaluate(second.page, `window.calcpadBridge.confirmThreeWay = async () => 'no';`);
        await app.closeAndWait(main, 'main');
        await app.stop(second.page, second.label);
    });

    test('tabs move between split groups while retaining their document model', {timeout: 90000}, async t => {
        const app = new TestApp();
        t.after(() => app.dispose());
        const main = await app.start();
        const original = await app.evaluate(main, 'window.calcpadTabs.activeId');
        await app.evaluate(main, invoke('plugin:event|emit_to', {
            target: {kind: 'WebviewWindow', label: 'main'}, event: 'menu-click', payload: {id: 'split-editor'},
        }));
        const linked = await until(() => app.evaluate(main,
            `document.querySelector('[data-tab-group="g1"] [data-tab-id]')?.dataset.tabId`), 'split group ready');
        await app.evaluate(main, `document.querySelector('[data-tab-id="${original}"]').dispatchEvent(new MouseEvent('mousedown', {button: 0, bubbles: true}))`);
        await until(async () => await app.evaluate(main, 'window.calcpadTabs.activeId') === original, 'source group active');
        const moved = await app.evaluate(main, `(() => {
            const id = window.calcpadTabs.newUntitled('', 'Moved');
            window.calcpadActiveEditor.executeEdits('test', [{range: {startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1}, text: 'moved = 1'}]);
            window.testMovedModel = window.calcpadActiveEditor.getModel();
            return id;
        })()`);
        await dragTab(app, main, moved, main, linked);
        await until(() => app.evaluate(main, `document.querySelector('[data-tab-group="g1"] .tab-title')?.textContent === 'Moved'`), 'tab moved to split group');
        assert.equal(await app.evaluate(main, 'window.calcpadActiveEditor.getModel() === window.testMovedModel'), true);
        assert.equal(await app.evaluate(main, `document.querySelector('[data-tab-id="${moved}"]') === null`), true);
        await app.evaluate(main, 'window.calcpadActiveEditor.getModel().undo()');
        assert.equal(await app.evaluate(main, 'window.calcpadActiveEditor.getValue()'), '');
        await app.stop(main, 'main');
    });

    test('dropping a tab onto a different open version preserves both documents', {timeout: 90000}, async t => {
        const app = new TestApp();
        t.after(() => app.dispose());
        const main = await app.start();
        const second = await app.newWindow(main);
        const file = app.fixture('conflicting worksheet.cpd', 'saved = 1');
        for (const [page, label] of [[main, 'main'], [second.page, second.label]]) {
            await app.focus(page, label);
            await app.relaunch([file]);
            await app.fileOpen(page, file);
        }
        await app.evaluate(main, "window.calcpadActiveEditor.setValue('source = 2')");
        await app.evaluate(second.page, "window.calcpadActiveEditor.setValue('destination = 3')");
        const tabId = await app.evaluate(main, 'window.calcpadTabs.activeId');
        await dragTab(app, main, tabId, second.page, null);
        await until(() => app.evaluate(second.page, "document.body.textContent.includes('already has a different version open')"), 'conflict reported');
        assert.equal(await app.evaluate(main, 'window.calcpadActiveEditor.getValue()'), 'source = 2');
        assert.equal(await app.evaluate(second.page, 'window.calcpadActiveEditor.getValue()'), 'destination = 3');
        for (const page of [main, second.page]) await app.evaluate(page, "window.calcpadBridge.confirmThreeWay = async () => 'no'");
        await app.closeAndWait(main, 'main');
        await app.stop(second.page, second.label);
    });

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
        const changedSize = {width: 560, height: 340};
        const secondarySize = {width: 600, height: 360};
        const changed = await app.setGeometry(main, changedSize, position);
        assert.notDeepEqual(changed.size, defaults.size);
        assert.notDeepEqual(changed.position, defaults.position);
        await app.stop(main, 'main');

        const stateFile = path.join(app.profile, '.window-state.json');
        const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
        writeFileSync(stateFile, JSON.stringify({...saved, 'main-2': {...saved.main, maximized: true}}));
        main = await app.start();
        assert.deepEqual(await app.geometry(main), changed);

        const second = await app.newWindow(main);
        assert.deepEqual(await app.geometry(second.page), defaults);

        await app.setGeometry(main, changedSize, position);
        await app.evaluate(main, invoke('plugin:window|maximize'));
        await until(async () => (await app.geometry(main)).maximized, 'window maximized');
        const third = await app.newWindow(main);
        assert.deepEqual(await app.geometry(third.page), defaults);

        await app.setGeometry(second.page, secondarySize, position);
        await app.closeAndWait(second.page, second.label);
        const fourth = await app.newWindow(main);
        assert.deepEqual(await app.geometry(fourth.page), defaults);
        await app.closeAndWait(main, 'main');
        await app.closeAndWait(third.page, third.label);
        await app.setGeometry(fourth.page, secondarySize, position);
        await app.stop(fourth.page, fourth.label);

        main = await app.start();
        assert.deepEqual(await app.geometry(main), changed);
        await app.stop(main, 'main');
    });
});
