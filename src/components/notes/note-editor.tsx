'use client';

import * as React from 'react';
import {
  Bold,
  Check,
  Code,
  Eye,
  Heading2,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Loader2,
  Lock,
  PencilLine,
  Quote,
  Unlock,
  X,
} from '@/components/ui/icons';
import type { Note } from '@/db/types';
import { autosaveLabel } from '@/lib/autosave';
import {
  continueList,
  insertLink,
  normaliseLinkHref,
  toggleChecklistItem,
  toggleLinePrefix,
  wrapSelection,
  type EditResult,
  type EditSelection,
} from '@/lib/markdown';
import { useAutosave } from '@/hooks/use-autosave';
import { cn } from '@/lib/utils';
import { MarkdownView } from './markdown-view';

/**
 * The note editor.
 *
 * Writing has to feel instant, so the textarea is uncontrolled by anything but
 * local state: no store round-trip per keystroke, no re-render of the tree, no
 * network. Autosave runs behind the typing and reports itself in one quiet line
 * of text -- "Saving…" then "Saved" -- because a modal or a banner for a routine
 * save would be noise.
 *
 * Content is Markdown. That keeps every note portable and means formatting is
 * a text edit rather than a document-model mutation.
 */

export interface NoteDraft {
  title: string;
  content: string;
}

export interface NoteEditorProps {
  note: Note;
  /** Persist the draft. Must resolve once storage has accepted it. */
  save: (draft: NoteDraft) => Promise<void>;
  /**
   * A soft lock: the note opens read-only until it is unlocked. It protects
   * against accidental edits, it is not encryption, and the UI says so.
   */
  readOnly?: boolean;
  onUnlock?: () => void;
}

export function NoteEditor({ note, save, readOnly = false, onUnlock }: NoteEditorProps) {
  const [draft, setDraft] = React.useState<NoteDraft>({ title: note.title, content: note.content });
  const [mode, setMode] = React.useState<'edit' | 'preview'>(readOnly ? 'preview' : 'edit');
  const [linkDraft, setLinkDraft] = React.useState<string | null>(null);

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const pendingSelection = React.useRef<EditSelection | null>(null);

  const persisted = React.useMemo(() => ({ title: note.title, content: note.content }), [note.title, note.content]);

  const { status, flush } = useAutosave<NoteDraft>({
    value: draft,
    persisted,
    save,
    isEqual: (a, b) => a.title === b.title && a.content === b.content,
    enabled: !readOnly,
  });

  // Auto-grow: a note is one continuous surface, so the textarea is as tall as
  // its content and the page owns the only scrollbar.
  React.useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.max(element.scrollHeight, 220)}px`;
  }, [draft.content, mode]);

  // Restore the caret after a toolbar edit re-renders the textarea.
  React.useLayoutEffect(() => {
    const target = pendingSelection.current;
    if (!target) return;
    pendingSelection.current = null;
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(target.start, target.end);
  });

  const selection = React.useCallback((): EditSelection => {
    const element = textareaRef.current;
    if (!element) return { start: draft.content.length, end: draft.content.length };
    return { start: element.selectionStart ?? 0, end: element.selectionEnd ?? 0 };
  }, [draft.content.length]);

  const applyEdit = React.useCallback((edit: EditResult) => {
    pendingSelection.current = { start: edit.selectionStart, end: edit.selectionEnd };
    setDraft((current) => ({ ...current, content: edit.text }));
  }, []);

  const wrap = React.useCallback((marker: string) => applyEdit(wrapSelection(draft.content, selection(), marker)), [applyEdit, draft.content, selection]);
  const prefix = React.useCallback((value: string) => applyEdit(toggleLinePrefix(draft.content, selection(), value)), [applyEdit, draft.content, selection]);

  const toggleChecklistLine = React.useCallback(
    (line: number) => {
      setDraft((current) => ({ ...current, content: toggleChecklistItem(current.content, line) }));
    },
    [],
  );

  const commitLink = React.useCallback(() => {
    const href = normaliseLinkHref(linkDraft ?? '');
    if (!href) {
      setLinkDraft(null);
      return;
    }
    applyEdit(insertLink(draft.content, selection(), href));
    setLinkDraft(null);
  }, [applyEdit, draft.content, linkDraft, selection]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    const next = continueList(draft.content, selection());
    if (next.text === draft.content) return;
    // Enter inside a list continues it; on an empty item it ends the list.
    event.preventDefault();
    applyEdit(next);
  };

  const statusText = autosaveLabel(status);
  const dirty = draft.title !== persisted.title || draft.content !== persisted.content;

  return (
    <div className="flex flex-col">
      <input
        value={draft.title}
        onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void flush();
            textareaRef.current?.focus();
          }
        }}
        placeholder="Title"
        aria-label="Note title"
        maxLength={120}
        autoComplete="off"
        readOnly={readOnly}
        enterKeyHint="done"
        className={cn(
          'w-full bg-transparent px-4 pt-1 text-display leading-tight font-semibold tracking-tight text-fg',
          'placeholder:text-subtle focus:outline-none',
        )}
      />

      <div className="flex items-center justify-between gap-2 px-4 pt-1 pb-2">
        <p className="min-w-0 truncate text-meta text-subtle">
          {readOnly
            ? 'Locked · encrypted, reading only'
            : mode === 'preview'
              ? 'Reading'
              : 'Markdown · tap a formatting button to insert'}
        </p>
        <span
          className="flex shrink-0 items-center gap-1.5 text-meta"
          aria-live="polite"
          aria-atomic="true"
        >
          {status === 'saving' || status === 'pending' ? (
            <>
              <Loader2 size={12} strokeWidth={2.4} className="animate-spin text-subtle" aria-hidden />
              <span className="text-subtle">{statusText}</span>
            </>
          ) : status === 'error' ? (
            <span className="text-danger">{statusText}</span>
          ) : status === 'saved' && !dirty ? (
            <>
              <Check size={12} strokeWidth={2.6} className="text-success" aria-hidden />
              <span className="text-subtle">{statusText}</span>
            </>
          ) : (
            <span className="text-subtle">Saved</span>
          )}
        </span>
      </div>

      {mode === 'edit' && !readOnly ? (
        <textarea
          ref={textareaRef}
          value={draft.content}
          onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
          onKeyDown={onKeyDown}
          placeholder="Start writing…"
          aria-label="Note body"
          spellCheck
          autoCapitalize="sentences"
          className={cn(
            'w-full resize-none bg-transparent px-4 pb-6 text-title leading-relaxed text-fg',
            'placeholder:text-subtle focus:outline-none',
          )}
        />
      ) : (
        <div className="px-4 pb-6">
          <MarkdownView
            content={draft.content}
            {...(readOnly ? {} : { onToggleChecklist: toggleChecklistLine })}
          />
        </div>
      )}

      {/* Formatting bar. Fixed above the tab bar so it stays under the thumb and
          rides above the keyboard when it opens. */}
      <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-border bg-surface/95 backdrop-blur-xl">
        {readOnly ? (
          <div className="flex items-center gap-3 px-3 py-2">
            <span className="flex flex-1 items-center gap-2 text-meta text-muted">
              <Lock size={15} strokeWidth={2} aria-hidden />
              {onUnlock
                ? 'Encrypted. Unlock to edit again.'
                : 'Locked by a parent note. Unlock that one to edit this.'}
            </span>
            {onUnlock ? (
              <button
                type="button"
                onClick={onUnlock}
                className="tap flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 text-meta font-semibold text-accent-fg"
              >
                <Unlock size={15} strokeWidth={2.2} aria-hidden />
                Unlock
              </button>
            ) : null}
          </div>
        ) : linkDraft !== null ? (
          <div className="flex items-center gap-2 px-3 py-2">
            <input
              value={linkDraft}
              autoFocus
              onChange={(event) => setLinkDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitLink();
                }
                if (event.key === 'Escape') setLinkDraft(null);
              }}
              placeholder="example.com"
              aria-label="Link address"
              inputMode="url"
              autoComplete="off"
              className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-surface-2 px-3 text-row text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              onClick={commitLink}
              className="tap flex h-10 items-center rounded-xl bg-accent px-3.5 text-body font-semibold text-accent-fg"
            >
              Insert
            </button>
            <button
              type="button"
              onClick={() => setLinkDraft(null)}
              aria-label="Cancel link"
              className="tap tile text-subtle active:bg-surface-2"
            >
              <X size={18} strokeWidth={2} aria-hidden />
            </button>
          </div>
        ) : (
          <div className="scroll-area flex items-center gap-1 overflow-x-auto px-2 py-1.5 no-scrollbar">
            <ToolButton
              label="Bold"
              icon={<Bold size={17} strokeWidth={2.3} aria-hidden />}
              onPress={() => wrap('**')}
              disabled={mode === 'preview'}
            />
            <ToolButton
              label="Italic"
              icon={<Italic size={17} strokeWidth={2.3} aria-hidden />}
              onPress={() => wrap('*')}
              disabled={mode === 'preview'}
            />
            <ToolButton
              label="Inline code"
              icon={<Code size={17} strokeWidth={2.2} aria-hidden />}
              onPress={() => wrap('`')}
              disabled={mode === 'preview'}
            />
            <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />
            <ToolButton
              label="Heading"
              icon={<Heading2 size={17} strokeWidth={2.2} aria-hidden />}
              onPress={() => prefix('## ')}
              disabled={mode === 'preview'}
            />
            <ToolButton
              label="Bulleted list"
              icon={<List size={17} strokeWidth={2.2} aria-hidden />}
              onPress={() => prefix('- ')}
              disabled={mode === 'preview'}
            />
            <ToolButton
              label="Numbered list"
              icon={<ListOrdered size={17} strokeWidth={2.2} aria-hidden />}
              onPress={() => prefix('1. ')}
              disabled={mode === 'preview'}
            />
            <ToolButton
              label="Checklist"
              icon={<ListChecks size={17} strokeWidth={2.2} aria-hidden />}
              onPress={() => prefix('- [ ] ')}
              disabled={mode === 'preview'}
            />
            <ToolButton
              label="Quote"
              icon={<Quote size={17} strokeWidth={2.2} aria-hidden />}
              onPress={() => prefix('> ')}
              disabled={mode === 'preview'}
            />
            <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />
            <ToolButton
              label="Insert link"
              icon={<Link2 size={17} strokeWidth={2.2} aria-hidden />}
              onPress={() => setLinkDraft('')}
              disabled={mode === 'preview'}
            />
            <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />
            <button
              type="button"
              onClick={() => {
                void flush();
                setMode((current) => (current === 'edit' ? 'preview' : 'edit'));
              }}
              className={cn(
                'tap tap-scale flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-meta font-medium',
                mode === 'preview' ? 'bg-accent text-accent-fg' : 'text-muted active:bg-surface-2',
              )}
            >
              {mode === 'preview' ? (
                <>
                  <PencilLine size={15} strokeWidth={2.2} aria-hidden />
                  Edit
                </>
              ) : (
                <>
                  <Eye size={15} strokeWidth={2.2} aria-hidden />
                  Read
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolButton({
  label,
  icon,
  onPress,
  disabled,
}: {
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'tap tap-scale flex size-9 shrink-0 items-center justify-center rounded-xl text-muted',
        'active:bg-surface-2 disabled:opacity-35',
      )}
    >
      {icon}
    </button>
  );
}
