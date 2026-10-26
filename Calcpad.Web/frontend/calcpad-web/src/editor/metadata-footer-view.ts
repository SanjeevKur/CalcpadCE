import * as monaco from 'monaco-editor';
import { findMetadataFoldSpan, keepSelectionOutOfSpan, METADATA_FOLDED_TEXT, METADATA_LINE_TEXT } from 'calcpad-frontend';

interface FoldRange {
    startLineNumber: number;
    endLineNumber: number;
    type: string | undefined;
    isCollapsed: boolean;
    source: number;
}
interface FoldingRegionsClass {
    sanitizeAndMerge(rangesA: unknown, rangesB: FoldRange[], maxLineNumber: number | undefined): FoldRange[];
    fromFoldRanges(ranges: FoldRange[]): unknown;
}
interface FoldingModelLike {
    readonly regions: object;
    getRegionAtLine(lineNumber: number): { startLineNumber: number; endLineNumber: number; isCollapsed: boolean } | null;
    removeManualRanges(ranges: { startLineNumber: number; endLineNumber: number }[]): void;
    updatePost(regions: unknown): void;
}
/** Monaco's FoldSource.userDefined: a manual range, kept across its own range recomputes. */
const USER_DEFINED = 1;
interface FoldingContributionLike extends monaco.editor.IEditorContribution {
    getFoldingModel(): Promise<FoldingModelLike | null> | null;
}

type Span = { start: number; end: number };

let stylesAdded = false;
function addStyles(): void {
    if (stylesAdded) return;
    stylesAdded = true;
    const style = document.createElement('style');
    style.textContent = `
.calcpad-metadata-hidden { display: none; }
.calcpad-metadata-placeholder { font-style: italic; opacity: 0.6; }`;
    document.head.appendChild(style);
}

/** Folds an editor's metadata footer behind a placeholder until the user expands it. */
export class MetadataFooterView implements monaco.IDisposable {
    private readonly decorations: monaco.editor.IEditorDecorationsCollection;
    private readonly disposables: monaco.IDisposable[] = [];
    private expanded = false;
    private checkTimer: ReturnType<typeof setTimeout> | undefined;
    // Last footer position a rebuild was tried for, so a range Monaco won't keep isn't retried forever.
    private attempted = '';

    constructor(private readonly editor: monaco.editor.IStandaloneCodeEditor) {
        addStyles();
        this.decorations = editor.createDecorationsCollection();
        this.disposables.push(
            editor.onDidChangeModel(() => {
                this.expanded = false;
                this.update();
            }),
            editor.onDidChangeModelContent(() => this.update()),
            editor.onDidChangeHiddenAreas(() => {
                void this.syncExpanded();
                this.scheduleCheck();
            }),
            editor.onDidChangeCursorSelection(() => this.keepSelectionOut()),
        );
        this.update();
    }

    dispose(): void {
        clearTimeout(this.checkTimer);
        this.decorations.clear();
        for (const d of this.disposables) d.dispose();
    }

    private span(): Span | null {
        const model = this.editor.getModel();
        return model ? findMetadataFoldSpan(i => model.getLineContent(i + 1), model.getLineCount()) : null;
    }

    /** The footer while it is folded, or always when it is one line and can't fold. */
    private hiddenSpan(): Span | null {
        const span = this.span();
        return span && (span.end === span.start || !this.expanded) ? span : null;
    }

    private update(): void {
        this.decorate();
        this.scheduleCheck();
    }

    private folding(): Promise<FoldingModelLike | null> | null | undefined {
        return this.editor.getContribution<FoldingContributionLike>('editor.contrib.folding')?.getFoldingModel();
    }

    // After Monaco's own folding update, which can drop a range whose lines an edit replaced.
    private scheduleCheck(): void {
        clearTimeout(this.checkTimer);
        this.checkTimer = setTimeout(() => void this.ensureFold(), 300);
    }

    /** Rebuilds the fold when it isn't exactly over the footer, keeping it open or closed as it was. */
    private async ensureFold(): Promise<void> {
        const model = this.editor.getModel();
        const span = this.span();
        if (!model || !span || span.end <= span.start) return;
        const region = (await this.folding())?.getRegionAtLine(span.start + 1);
        if (this.editor.getModel() !== model) return;
        if (region && region.startLineNumber === span.start + 1 && region.endLineNumber === span.end + 1) {
            this.attempted = '';
            return;
        }
        const attempt = `${model.id}:${model.getVersionId()}:${span.start}:${span.end}`;
        if (attempt === this.attempted) return;
        this.attempted = attempt;
        await this.fold(span);
    }

    /** Puts one manual range exactly over the footer, via the folding model so the selection isn't touched. */
    private async fold(span: Span): Promise<void> {
        const model = this.editor.getModel();
        const folding = await this.folding();
        if (!model || !folding || this.editor.getModel() !== model) return;
        const lineCount = model.getLineCount();
        folding.removeManualRanges([{ startLineNumber: span.start + 1, endLineNumber: lineCount }]);
        const regions = folding.regions.constructor as unknown as FoldingRegionsClass;
        const merged = regions.sanitizeAndMerge(folding.regions, [{
            startLineNumber: span.start + 1,
            endLineNumber: span.end + 1,
            type: undefined,
            isCollapsed: !this.expanded,
            source: USER_DEFINED,
        }], lineCount);
        folding.updatePost(regions.fromFoldRanges(merged));
        await this.syncExpanded();
    }

    /** Follows the fold as the user opens and closes it. */
    private async syncExpanded(): Promise<void> {
        const span = this.span();
        if (!span || span.end === span.start) return;
        const region = (await this.folding())?.getRegionAtLine(span.start + 2);
        // No fold over the footer (yet) says nothing about whether the user opened it.
        if (!region || region.startLineNumber !== span.start + 1) return;
        const expanded = !region.isCollapsed;
        if (expanded === this.expanded) return;
        this.expanded = expanded;
        this.decorate();
    }

    private decorate(): void {
        const model = this.editor.getModel();
        const span = this.hiddenSpan();
        if (!model || !span) {
            this.decorations.clear();
            return;
        }
        const text = span.end > span.start ? METADATA_FOLDED_TEXT : METADATA_LINE_TEXT;
        const decorations: monaco.editor.IModelDeltaDecoration[] = [];
        for (let line = span.start + 1; line <= span.end + 1; line++) {
            decorations.push({
                range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
                options: {
                    inlineClassName: 'calcpad-metadata-hidden',
                    showIfCollapsed: true,
                    before: line === span.start + 1 ? { content: text, inlineClassName: 'calcpad-metadata-placeholder' } : undefined,
                },
            });
        }
        this.decorations.set(decorations);
    }

    // Ctrl+End and Ctrl+A reach into the hidden comments; typing or deleting there would edit them unseen.
    private keepSelectionOut(): void {
        const span = this.hiddenSpan();
        const model = this.editor.getModel();
        const selections = this.editor.getSelections();
        if (!span || !model || !selections) return;
        const toPos = (line: number, column: number) => ({ line: line - 1, character: column - 1 });
        let changed = false;
        const next = selections.map(sel => {
            const fixed = keepSelectionOutOfSpan(
                toPos(sel.selectionStartLineNumber, sel.selectionStartColumn),
                toPos(sel.positionLineNumber, sel.positionColumn),
                span, model.getLineCount(), i => model.getLineMaxColumn(i + 1) - 1);
            if (!fixed) return sel;
            changed = true;
            return new monaco.Selection(fixed.anchor.line + 1, fixed.anchor.character + 1, fixed.active.line + 1, fixed.active.character + 1);
        });
        if (changed) this.editor.setSelections(next);
    }
}
