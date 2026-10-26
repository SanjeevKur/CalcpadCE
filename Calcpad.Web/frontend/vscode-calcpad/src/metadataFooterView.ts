import * as vscode from 'vscode';
import { findMetadataFoldSpan, keepSelectionOutOfSpan, METADATA_FOLDED_TEXT, METADATA_LINE_TEXT } from 'calcpad-frontend';

type Span = { start: number; end: number };

/** Folds a document's metadata footer behind a placeholder until the user expands it. */
export class MetadataFooterView implements vscode.Disposable {
    // VS Code can't hide a line, so the folded footer's text is collapsed behind a placeholder.
    private readonly decoration = vscode.window.createTextEditorDecorationType({ textDecoration: 'none; display: none;' });
    // Footer height each document's fold was built for; the range follows other edits by itself.
    private readonly foldedHeight = new Map<string, number>();
    private readonly expanded = new Set<string>();
    // Whether each document being saved had its fold open; fold work waits until the save is done.
    private readonly savingExpanded = new Map<string, boolean>();
    private busyUntil = 0;
    private readonly disposables: vscode.Disposable[];

    constructor() {
        this.disposables = [
            this.decoration,
            vscode.window.onDidChangeVisibleTextEditors(editors => this.refresh(editors)),
            vscode.window.onDidChangeActiveTextEditor(editor => { if (editor) this.refresh([editor]); }),
            vscode.window.onDidChangeTextEditorVisibleRanges(e => this.syncExpanded(e.textEditor)),
            vscode.window.onDidChangeTextEditorSelection(e => this.keepSelectionOut(e.textEditor)),
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.contentChanges.length) this.refresh(vscode.window.visibleTextEditors.filter(ed => ed.document === e.document));
            }),
            vscode.workspace.onWillSaveTextDocument(e => {
                if (e.document.languageId !== 'calcpad') return;
                this.savingExpanded.set(e.document.uri.toString(), this.expanded.has(e.document.uri.toString()));
                // A failed save never reports back.
                setTimeout(() => this.afterSave(e.document), 5000);
            }),
            vscode.workspace.onDidSaveTextDocument(document => this.afterSave(document)),
            vscode.workspace.onDidCloseTextDocument(document => {
                this.foldedHeight.delete(document.uri.toString());
                this.expanded.delete(document.uri.toString());
            }),
        ];
        this.refresh();
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
    }

    refresh(editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors): void {
        for (const editor of editors) {
            if (editor.document.languageId !== 'calcpad') continue;
            this.decorate(editor);
            if (editor === vscode.window.activeTextEditor) void this.fold(editor);
        }
    }

    private afterSave(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        const wasExpanded = this.savingExpanded.get(key);
        if (wasExpanded === undefined) return;
        this.savingExpanded.delete(key);
        if (wasExpanded) this.expanded.add(key);
        else this.expanded.delete(key);
        // Rebuilt only when the save moved the footer (the anchor was added back); a plain save leaves the fold alone.
        this.refresh(vscode.window.visibleTextEditors.filter(editor => editor.document === document));
    }

    private span(document: vscode.TextDocument): Span | null {
        return findMetadataFoldSpan(i => document.lineAt(i).text, document.lineCount);
    }

    /** The footer while it is folded, or always when it is one line and can't fold. */
    private hiddenSpan(document: vscode.TextDocument): Span | null {
        const span = this.span(document);
        return span && (span.end === span.start || !this.expanded.has(document.uri.toString())) ? span : null;
    }

    private decorate(editor: vscode.TextEditor): void {
        const document = editor.document;
        const span = this.hiddenSpan(document);
        const options: vscode.DecorationOptions[] = [];
        for (let line = span?.start ?? 0; span && line <= span.end; line++) {
            options.push({
                range: document.lineAt(line).range,
                renderOptions: line === span.start
                    ? { before: { contentText: span.end > span.start ? METADATA_FOLDED_TEXT : METADATA_LINE_TEXT, color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic' } }
                    : undefined,
            });
        }
        editor.setDecorations(this.decoration, options);
    }

    /** Builds the fold with VS Code's manual folding, so its own folding ranges are left alone. */
    private async fold(editor: vscode.TextEditor): Promise<void> {
        const document = editor.document;
        const key = document.uri.toString();
        const span = this.span(document);
        const height = span && span.end > span.start ? span.end - span.start : 0;
        if (!span || !height) {
            this.foldedHeight.delete(key);
            return;
        }
        if (this.savingExpanded.has(key) || this.foldedHeight.get(key) === height) return;
        this.foldedHeight.set(key, height);

        const saved = editor.selections;
        const wasExpanded = this.expanded.has(key);
        const select = (start: number, end: number) =>
            editor.selection = new vscode.Selection(start, 0, end, document.lineAt(end).text.length);
        this.busyUntil = Date.now() + 1000;
        try {
            select(span.start, document.lineCount - 1);
            await vscode.commands.executeCommand('editor.removeManualFoldingRanges');
            select(span.start, span.end);
            await vscode.commands.executeCommand('editor.createFoldingRangeFromSelection');
            // Rebuilding an open fold (e.g. the anchor was restored) shouldn't close it.
            if (wasExpanded)
                await vscode.commands.executeCommand('editor.unfold', { selectionLines: [span.start] });
        } finally {
            editor.selections = saved;
            this.busyUntil = Date.now() + 100;
        }
    }

    /** Visible ranges skip folded lines, which is the only way to tell the user opened the fold. */
    private syncExpanded(editor: vscode.TextEditor): void {
        const document = editor.document;
        const span = document.languageId === 'calcpad' ? this.span(document) : null;
        if (!span || span.end === span.start || this.savingExpanded.has(document.uri.toString())) return;
        const visible = (line: number) => editor.visibleRanges.some(r => r.start.line <= line && line <= r.end.line);
        if (!visible(span.start)) return;
        const key = document.uri.toString();
        const expanded = visible(span.start + 1);
        if (expanded === this.expanded.has(key)) return;
        if (expanded) this.expanded.add(key);
        else this.expanded.delete(key);
        this.decorate(editor);
    }

    // Ctrl+End and Ctrl+A reach into the hidden comments; typing or deleting there would edit them unseen.
    private keepSelectionOut(editor: vscode.TextEditor): void {
        const document = editor.document;
        if (Date.now() < this.busyUntil || document.languageId !== 'calcpad') return;
        const span = this.hiddenSpan(document);
        if (!span) return;
        let changed = false;
        const next = editor.selections.map(sel => {
            const fixed = keepSelectionOutOfSpan(sel.anchor, sel.active, span, document.lineCount, i => document.lineAt(i).text.length);
            if (!fixed) return sel;
            changed = true;
            return new vscode.Selection(fixed.anchor.line, fixed.anchor.character, fixed.active.line, fixed.active.character);
        });
        if (changed) editor.selections = next;
    }
}
