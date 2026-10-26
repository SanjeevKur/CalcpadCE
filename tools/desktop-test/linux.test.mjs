import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LinuxTestApp, until, invoke } from './linux-test-app.mjs';

describe('Linux GTK document tabs', {skip: process.platform !== 'linux', concurrency: false}, () => {
    async function start(t) {
        const app = new LinuxTestApp();
        let main;
        t.after(async () => {
            try { if (t.error && main) await app.diagnostics(main); }
            finally { await app.dispose(); }
        });
        main = await app.start();
        await app.geometry(main, 50, 60);
        await app.evaluate(main, `window.testErrors = [];
            window.addEventListener('unhandledrejection', event => window.testErrors.push(String(event.reason)));
            window.calcpadBridge.confirmThreeWay = async () => 'no';`);
        return {app, main};
    }

    test('reorders tabs with native pointer movement below the GTK menu', {timeout: 60000}, async t => {
        const {app, main} = await start(t);
        const ids = await app.evaluate(main, `(() => {
            const tabs = window.calcpadTabs;
            const scratch = tabs.activeId;
            const ids = ['A', 'B', 'C'].map(title => tabs.newUntitled(title + ' = 1', title));
            tabs.close(scratch);
            tabs.activate(ids[0]);
            window.calcpadActiveEditor.executeEdits('test', [{range: {startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 6}, text: '2'}]);
            return ids;
        })()`);
        await app.drag(main, ids[0], main, `[data-tab-id="${ids[2]}"]`);
        await until(async () => (await app.evaluate(main, 'window.calcpadTabs.all.map(tab => tab.title).join()')) === 'B,A,C', 'GTK tabs reordered');
        assert.equal(await app.evaluate(main, 'window.calcpadTabs.activeId'), ids[0]);
        await app.evaluate(main, 'window.calcpadActiveEditor.getModel().undo()');
        assert.equal(await app.evaluate(main, 'window.calcpadActiveEditor.getValue()'), 'A = 1');
        assert.equal(await app.evaluate(main, 'window.calcpadTabs.isDirty()'), false);
        assert.deepEqual(await app.evaluate(main, 'window.testErrors'), []);
    });

    test('Escape cancels a drag', {
        timeout: 60000,
        skip: process.env.CALCPAD_TEST_BACKEND === 'wayland' && 'Sway consumes keyboard input during native drags',
    }, async t => {
        const {app, main} = await start(t);
        const ids = await app.evaluate(main, `['A', 'B'].map(title => window.calcpadTabs.newUntitled('', title))`);
        const before = await app.evaluate(main, 'window.calcpadTabs.all');
        await app.drag(main, ids[1], main, `[data-tab-id="${ids[0]}"]`, {cancel: true});
        assert.deepEqual(await app.evaluate(main, 'window.calcpadTabs.all'), before);
    });

    test('dropping outside preserves the tabs', {timeout: 60000}, async t => {
        const {app, main} = await start(t);
        const id = await app.evaluate(main, `window.calcpadTabs.newUntitled('', 'Outside')`);
        const before = await app.evaluate(main, 'window.calcpadTabs.all');
        await app.drag(main, id, main, '.tab-new', {outside: true});
        assert.deepEqual(await app.evaluate(main, 'window.calcpadTabs.all'), before);
    });

    test('moves an unsaved tab between native GTK windows', {timeout: 60000}, async t => {
        const {app, main} = await start(t);
        const second = await app.newWindow(main);
        const scale = await app.evaluate(main, 'devicePixelRatio');
        await app.geometry(second.handle, 1450 * scale, 100);
        const original = await app.evaluate(main, `(() => {
            window.calcpadActiveEditor.setValue('a = 1\\nb = 2');
            window.calcpadActiveEditor.setPosition({lineNumber: 2, column: 3});
            return window.calcpadTabs.activeTab;
        })()`);
        await app.drag(main, original.id, second.handle, '.tab-new');
        await until(async () => await app.evaluate(second.handle, 'window.calcpadActiveEditor.getValue()') === 'a = 1\nb = 2', 'GTK document received');
        await until(async () => !(await app.evaluate(main, 'window.calcpadTabs.all')).some(tab => tab.id === original.id), 'source removed');
        assert.equal(await app.evaluate(second.handle, 'window.calcpadTabs.isDirty()'), true);
        assert.deepEqual(await app.evaluate(second.handle, 'window.calcpadActiveEditor.getPosition()'), {lineNumber: 2, column: 3});
        assert.equal(await app.evaluate(second.handle, 'window.calcpadTabs.activeTab.title'), original.title);
        await until(() => app.evaluate(second.handle, `(async () => (await ${invoke('draft_list')}).some(draft => draft.filePath === null))()`), 'destination recovery draft');
    });

    test('targets the front window when GTK windows overlap', {timeout: 60000}, async t => {
        const {app, main} = await start(t);
        const second = await app.newWindow(main);
        const scale = await app.evaluate(main, 'devicePixelRatio');
        await app.geometry(second.handle, 500 * scale, 100);
        const original = await app.evaluate(main, `(() => {
            window.calcpadActiveEditor.setValue('overlap = 1');
            return window.calcpadTabs.activeTab;
        })()`);
        await app.drag(main, original.id, second.handle, '.tab-new', {raiseDestination: true});
        await until(async () => await app.evaluate(second.handle, 'window.calcpadActiveEditor.getValue()') === 'overlap = 1', 'front GTK window receives document');
        await until(async () => !(await app.evaluate(main, 'window.calcpadTabs.all')).some(tab => tab.id === original.id), 'covered source tab removed');
    });

    test('moves tabs between split groups without losing undo history', {timeout: 60000}, async t => {
        const {app, main} = await start(t);
        const original = await app.evaluate(main, 'window.calcpadTabs.activeId');
        await app.evaluate(main, invoke('plugin:event|emit_to', {
            target: {kind: 'WebviewWindow', label: 'main'}, event: 'menu-click', payload: {id: 'split-editor'},
        }));
        const linked = await until(() => app.evaluate(main,
            `document.querySelector('[data-tab-group="g1"] [data-tab-id]')?.dataset.tabId`), 'split GTK group ready');
        await app.evaluate(main, `document.querySelector('[data-tab-id="${original}"]').dispatchEvent(new MouseEvent('mousedown', {button: 0, bubbles: true}))`);
        await until(async () => await app.evaluate(main, 'window.calcpadTabs.activeId') === original, 'source GTK group active');
        const moved = await app.evaluate(main, `(() => {
            const id = window.calcpadTabs.newUntitled('', 'Moved');
            window.calcpadActiveEditor.executeEdits('test', [{range: {startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1}, text: 'moved = 1'}]);
            window.testMovedModel = window.calcpadActiveEditor.getModel();
            return id;
        })()`);
        await app.drag(main, moved, main, `[data-tab-id="${linked}"]`);
        await until(() => app.evaluate(main, `document.querySelector('[data-tab-group="g1"] .tab-title')?.textContent === 'Moved'`), 'tab moved to split GTK group');
        assert.equal(await app.evaluate(main, 'window.calcpadActiveEditor.getModel() === window.testMovedModel'), true);
        await app.evaluate(main, 'window.calcpadActiveEditor.getModel().undo()');
        assert.equal(await app.evaluate(main, 'window.calcpadActiveEditor.getValue()'), '');
    });
});
