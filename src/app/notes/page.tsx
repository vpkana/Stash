'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight, FilePlus2, Layers, Lock, MoreHorizontal, NotebookPen, Star } from '@/components/ui/icons';
import type { Note, SavedLink } from '@/db/types';
import { displayUrl, pluralize } from '@/lib/format';
import { openExternal } from '@/lib/open-external';
import { noteChildren, noteDescendantIds } from '@/lib/tree';
import { useLockState } from '@/lib/privacy/access';
import { useRevealLocked } from '@/components/privacy/locked-row';
import { useVaultStore } from '@/stores/vault-store';
import { Button } from '@/components/ui/button';
import { EmptyState, ListSurface, PageHeader, PageTitle, Section } from '@/components/ui/page';
import { toast } from '@/components/ui/toast';
import { NoteEditor } from '@/components/notes/note-editor';
import { SubnoteSheet } from '@/components/notes/subnote-sheet';
import type { RichTextApi } from '@/components/notes/rich-text-editor';
import { NoteRow } from '@/components/notes/note-row';
import { NoteActionsSheet } from '@/components/notes/note-actions-sheet';
import { NoteResources } from '@/components/notes/note-resources';
import { LinkPickerSheet } from '@/components/links/link-picker-sheet';
import { LinkActionsSheet } from '@/components/links/link-actions-sheet';

/**
 * Notes.
 *
 * One route with a `?note=` parameter rather than a route per note, because the
 * tree is unbounded: a path segment per level would produce URLs nobody can read
 * and a navigation stack that grows with nesting. The query keeps the tree a
 * single, browsable surface, and the hardware back button still walks out of
 * nesting naturally.
 *
 * Small screens get breadcrumbs and contextual child lists -- never a permanent
 * desktop-style sidebar.
 */
function NotesView() {
  const params = useSearchParams();
  const router = useRouter();
  const noteId = params.get('note');

  const notes = useVaultStore((state) => state.notes);
  const visibleNotes = useVaultStore((state) => state.visibleNotes);
  const links = useVaultStore((state) => state.links);
  const noteLinks = useVaultStore((state) => state.noteLinks);
  // What may not be *read* right now. Inherited locks count: a subnote of a locked
  // note is protected too, so it must open read-only even though its own flag is
  // false — and it must open read-only only until its boundary is crossed.
  const protectedNoteIds = useVaultStore((state) => state.hidden.notes);
  const hiddenLinks = useVaultStore((state) => state.hidden.links);

  const [activeNote, setActiveNote] = React.useState<Note | null>(null);
  const [activeLink, setActiveLink] = React.useState<SavedLink | null>(null);
  const [picking, setPicking] = React.useState(false);
  /**
   * The Note button opens a decision, not a note.
   *
   * Pressing it used to create an untitled subnote on the spot and drop a
   * reference to it into the sentence being written — a name nobody chose, and a
   * note to go and rename. This is the sheet where the name (or the existing note
   * that should live here) is chosen first; nothing exists until then.
   */
  const [addingSubnote, setAddingSubnote] = React.useState(false);
  /**
   * The open editor's insertion API.
   *
   * Held here because *this* screen is what turns a pick into an attachment and a
   * subnote into a row; the editor is what knows where the caret was when the user
   * asked. Neither half can do it alone, so the handle lives in the middle.
   */
  const editorApi = React.useRef<RichTextApi | null>(null);

  const current = React.useMemo(
    () => (noteId ? notes.find((note) => note.id === noteId) ?? null : null),
    [notes, noteId],
  );

  // Derived once per render pass rather than per row: a list rebuilt inside a
  // selector would make every store update look like a change.
  const { childCounts, linkCounts, trail, subnotes, resources } = React.useMemo(() => {
    const childCounts = new Map<string, number>();
    for (const note of visibleNotes) {
      if (!note.parentNoteId) continue;
      childCounts.set(note.parentNoteId, (childCounts.get(note.parentNoteId) ?? 0) + 1);
    }

    // Counted from the same withheld set the lists use: a "3 links" badge on a
    // note, where those links are locked, would be a count of something the user
    // cannot see.
    const linkCounts = new Map<string, number>();
    for (const row of noteLinks) {
      if (hiddenLinks.has(row.linkId)) continue;
      linkCounts.set(row.noteId, (linkCounts.get(row.noteId) ?? 0) + 1);
    }

    const trail: Note[] = [];
    const subnotes: Note[] = [];
    const resources: SavedLink[] = [];

    if (current) {
      const byId = new Map(notes.map((note) => [note.id, note]));
      const guard = new Set<string>();
      let cursor: Note | undefined = current;
      while (cursor && !guard.has(cursor.id)) {
        guard.add(cursor.id);
        trail.unshift(cursor);
        cursor = cursor.parentNoteId ? byId.get(cursor.parentNoteId) : undefined;
      }

      subnotes.push(...noteChildren(visibleNotes, current.id));

      const linkById = new Map(links.map((link) => [link.id, link]));
      resources.push(
        ...noteLinks
          .filter((row) => row.noteId === current.id)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((row) => linkById.get(row.linkId))
          .filter((link): link is SavedLink => Boolean(link) && !hiddenLinks.has(link!.id)),
      );
    }

    return { childCounts, linkCounts, trail, subnotes, resources };
  }, [current, links, noteLinks, notes, visibleNotes, hiddenLinks]);

  /**
   * What could become a subnote of the note being read.
   *
   * Everything readable except the note itself, what is already below it (a note
   * cannot contain its own ancestor) and the subnotes it already has — those are
   * listed on the screen already, and offering them again would be offering a
   * move to the place they already are.
   */
  const nestCandidates = React.useMemo(() => {
    if (!current) return [];
    const blocked = new Set(noteDescendantIds(notes, current.id));
    blocked.add(current.id);
    for (const subnote of subnotes) blocked.add(subnote.id);
    return visibleNotes
      .filter((note) => !blocked.has(note.id))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [current, notes, subnotes, visibleNotes]);

  // `current` is present but unreadable: see the editor branch below. Asked of
  // the central access check rather than of the ciphertext, so a deep link into a
  // note the session has not unlocked never reaches the editor.
  const accessed = useLockState('note', current?.id ?? null);
  const sealed = Boolean(current) && accessed.locked;
  const { reveal, busy: revealing } = useRevealLocked();

  const rootNotes = React.useMemo(() => noteChildren(visibleNotes, null), [visibleNotes]);
  const favoriteNotes = React.useMemo(
    () => visibleNotes.filter((note) => note.isFavorite).slice(0, 4),
    [visibleNotes],
  );

  const openNote = React.useCallback(
    (id: string) => {
      router.push(`/notes?note=${id}`);
    },
    [router],
  );

  const createNote = React.useCallback(
    async (parentNoteId: string | null) => {
      const result = await useVaultStore.getState().createNote({
        title: parentNoteId ? 'New subnote' : 'New note',
        content: '',
        parentNoteId,
      });
      if (!result.ok) {
        toast(result.message, { tone: 'danger' });
        return;
      }
      openNote(result.note.id);
    },
    [openNote],
  );

  /**
   * A subnote made *from the body*, once it has a name.
   *
   * Deliberately not the same as the New-note button: this one does not navigate
   * away. The whole point of the Note button beside the title is that the user is
   * writing a sentence and wants to point at a subnote from *here*, so the
   * reference lands at the caret and the caret stays in the note being written.
   */
  const createSubnoteAtCaret = React.useCallback(
    async (parentId: string, title: string) => {
      const result = await useVaultStore.getState().createNote({
        title,
        content: '',
        parentNoteId: parentId,
      });
      if (!result.ok) {
        toast(result.message, { tone: 'danger' });
        return;
      }
      setAddingSubnote(false);
      editorApi.current?.insertNoteReference(result.note.id, result.note.title);
      toast('Subnote added here');
    },
    [],
  );

  /**
   * A note that already exists, moved under this one.
   *
   * The other half of the same decision: a subnote is a *relationship*, and the
   * note for it may already have been written. Moving it rather than copying is
   * the only version that keeps one note in one place, and it is undoable by
   * moving it back.
   */
  const nestSubnoteAtCaret = React.useCallback(
    async (parentId: string, note: Note) => {
      const result = await useVaultStore.getState().moveNote(note.id, parentId);
      if (!result.ok) {
        toast(result.reason, { tone: 'danger' });
        return;
      }
      setAddingSubnote(false);
      editorApi.current?.insertNoteReference(note.id, note.title);
      toast('Note nested here');
    },
    [],
  );

  const openLink = React.useCallback((link: SavedLink) => {
    void useVaultStore.getState().markLinkOpened(link.id);
    void openExternal(link.url);
  }, []);

  // ---------------------------------------------------------------------------
  // Note detail
  // ---------------------------------------------------------------------------
  if (noteId) {
    if (!current) {
      return (
        <>
          <PageHeader>
            <PageTitle subtitle="It may have been deleted">Note not found</PageTitle>
          </PageHeader>
          <EmptyState
            icon={<NotebookPen size={22} strokeWidth={1.7} />}
            title="This note is gone"
            description="It was deleted, moved out of view, or the link is stale."
            action={
              <Button variant="accentSoft" size="sm" onClick={() => router.push('/notes')}>
                Back to notes
              </Button>
            }
          />
        </>
      );
    }

    const parentId = current.parentNoteId;
    const descendantCount = noteDescendantIds(notes, current.id).length;

    return (
      <>
        <PageHeader className="pb-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => (parentId ? openNote(parentId) : router.push('/notes'))}
              aria-label={parentId ? 'Go to parent note' : 'Back to all notes'}
              className="tap -ml-1.5 flex size-9 shrink-0 items-center justify-center rounded-full text-accent active:bg-surface-2"
            >
              <ChevronLeft size={20} strokeWidth={2.2} aria-hidden />
            </button>

            <nav aria-label="Breadcrumb" className="scroll-area flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-meta text-subtle no-scrollbar">
              <button
                type="button"
                onClick={() => router.push('/notes')}
                className="tap shrink-0 rounded px-1 py-0.5 active:bg-surface-2"
              >
                Notes
              </button>
              {trail.slice(0, -1).map((note) => (
                <React.Fragment key={note.id}>
                  <ChevronRight size={12} strokeWidth={2.2} className="shrink-0 text-subtle" aria-hidden />
                  <button
                    type="button"
                    onClick={() => openNote(note.id)}
                    className="tap max-w-[8rem] shrink-0 truncate rounded px-1 py-0.5 active:bg-surface-2"
                  >
                    {note.title}
                  </button>
                </React.Fragment>
              ))}
              <ChevronRight size={12} strokeWidth={2.2} className="shrink-0 text-subtle" aria-hidden />
              <span className="max-w-[9rem] shrink-0 truncate px-1 py-0.5 font-medium text-muted">
                {current.title}
              </span>
            </nav>

            <button
              type="button"
              onClick={() => setActiveNote(current)}
              aria-label="Note actions"
              className="tap flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
            >
              <MoreHorizontal size={19} strokeWidth={2} aria-hidden />
            </button>
          </div>

          <p className="mt-1 flex items-center gap-2 pl-8 text-meta text-subtle">
            <span>{pluralize(descendantCount, 'note')} below</span>
            {current.isFavorite ? (
              <Star size={12} strokeWidth={2.4} className="fill-warning text-warning" aria-label="Favorite" />
            ) : null}
          </p>
        </PageHeader>

        {/*
          * A note that is still ciphertext — reached by a stale link, or by an
          * import that brought content this device holds no key for — must not
          * open as an empty editor. An empty editor looks like a note that lost
          * its text, and typing into it is a write path against a row whose
          * contents were never read. So it gets the same answer the row gave:
          * the lock, and the prompt.
          */}
        {sealed ? (
          <div className="px-4 py-6">
            <div className="card mx-4 flex flex-col items-start gap-3 px-4 py-5">
              <span className="flex items-center gap-2 text-row font-semibold text-fg">
                <Lock size={17} strokeWidth={2} className="text-accent" aria-hidden />
                This note is locked
              </span>
              <p className="text-meta leading-relaxed text-muted">
                Its title and body are encrypted on disk and are not readable until the vault is unlocked.
              </p>
              <Button
                variant="accentSoft"
                size="sm"
                disabled={revealing}
                onClick={() => void reveal('note', current.id, () => undefined)}
              >
                {revealing ? 'Asking…' : 'Unlock to read it'}
              </Button>
            </div>
          </div>
        ) : (
          <NoteEditor
            key={current.id}
            note={current}
            readOnly={protectedNoteIds.has(current.id)}
            {...(current.isLocked
              ? { onUnlock: () => void useVaultStore.getState().toggleNoteLocked(current.id, false) }
              : {})}
            onAddSubnote={() => setAddingSubnote(true)}
            onAttachLink={() => setPicking(true)}
            onApiReady={(api) => {
              editorApi.current = api;
            }}
            onOpenReference={openNote}
            subnoteCount={subnotes.length}
            linkCount={resources.length}
            save={async (draft) => {
              await useVaultStore.getState().saveNoteDraft(current.id, draft);
            }}
          />
        )}

        {/*
          * Only when there is something in it.
          *
          * "No subnotes yet" is a sentence about the absence of content, printed
          * under every note that has none — which is most of them, and which the
          * user already knows. The Note button beside the title is the signpost;
          * an empty section is just noise between the text and the bottom of the
          * screen.
          */}
        {subnotes.length > 0 ? (
          <Section title="Subnotes" className="pt-2">
            <ListSurface>
              {subnotes.map((subnote) => (
                <NoteRow
                  key={subnote.id}
                  note={subnote}
                  childCount={noteChildren(visibleNotes, subnote.id).length}
                  linkCount={linkCounts.get(subnote.id) ?? 0}
                  onOpen={() => openNote(subnote.id)}
                  onShowActions={() => setActiveNote(subnote)}
                  onToggleFavorite={() => void useVaultStore.getState().toggleNoteFavorite(subnote.id)}
                />
              ))}
            </ListSurface>
          </Section>
        ) : null}

        <NoteResources
          links={resources}
          readOnly={protectedNoteIds.has(current.id)}
          onOpenLink={openLink}
          onDetach={(linkId) => {
            void useVaultStore.getState().detachLink(current.id, linkId);
            toast('Detached. The link is still saved.');
          }}
        />

        {/* The editor already reserves room for its own fixed formatting bar. */}
        <div className="h-4" />

        <NoteActionsSheet
          key={activeNote?.id ?? 'no-note'}
          note={activeNote}
          onClose={() => setActiveNote(null)}
          onOpenNote={openNote}
          onDeleted={(deletedId) => {
            if (deletedId === noteId) router.push('/notes');
          }}
        />

        <SubnoteSheet
          open={addingSubnote}
          onClose={() => setAddingSubnote(false)}
          parentTitle={current.title}
          candidates={nestCandidates}
          onCreate={(title) => void createSubnoteAtCaret(current.id, title)}
          onNest={(note) => void nestSubnoteAtCaret(current.id, note)}
        />

        <LinkPickerSheet
          open={picking}
          onClose={() => setPicking(false)}
          attachedIds={resources.map((link) => link.id)}
          lockedCount={hiddenLinks.size}
          onPickAddress={(url) => {
            setPicking(false);
            // Nothing is saved: the address is written into this note, and the
            // editor turns it into a link if it landed on a selection.
            editorApi.current?.insertAddress(url);
            toast('Address added to this note');
          }}
          onPick={(link) => {
            setPicking(false);
            void useVaultStore.getState().attachLink(current.id, link.id).then((ok) => {
              if (!ok) {
                toast('Could not attach that link', { tone: 'danger' });
                return;
              }
              // The reference goes where the caret was when the button was pressed,
              // not at the end: the picker moved focus, so the editor remembered
              // the position before it opened.
              editorApi.current?.insertLink(link.url, link.title?.trim() || displayUrl(link.url));
              toast('Link attached');
            });
          }}
        />

        <LinkActionsSheet
          key={activeLink?.id ?? 'no-link'}
          link={activeLink}
          onClose={() => setActiveLink(null)}
        />
      </>
    );
  }

  // ---------------------------------------------------------------------------
  // Notes index
  // ---------------------------------------------------------------------------
  const isEmpty = visibleNotes.length === 0;

  return (
    <>
      <PageHeader>
        {/*
          * No "New note" button in the header.
          *
          * There is already exactly one primary action in the app and it is on
          * every screen; a second button doing the same thing two centimetres
          * away is not a shortcut, it is a question about which one is different.
          * The label it carries says what it makes: a top-level note here, a
          * subnote when you are inside one.
          */}
        <PageTitle
          subtitle={
            isEmpty
              ? 'Nothing written yet'
              : `${pluralize(rootNotes.length, 'note')} at the top level · ${pluralize(visibleNotes.length, 'note')} in all`
          }
        >
          Notes
        </PageTitle>
      </PageHeader>

      {isEmpty ? (
        <div className="px-4">
          <EmptyState
            icon={<NotebookPen size={22} strokeWidth={1.7} />}
            title="Start with a thought."
            description="A note is your own words next to the things you saved. Write one line now and break it into subnotes as it grows — nothing here needs a title, a folder or a network."
            action={
              <Button variant="accentSoft" size="sm" onClick={() => void createNote(null)}>
                <FilePlus2 size={16} strokeWidth={2} aria-hidden />
                New note
              </Button>
            }
          />
        </div>
      ) : (
        <>
          {favoriteNotes.length > 0 ? (
            <Section title="Favorites">
              <ListSurface>
                {favoriteNotes.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    childCount={childCounts.get(note.id) ?? 0}
                    linkCount={linkCounts.get(note.id) ?? 0}
                    onOpen={() => openNote(note.id)}
                    onShowActions={() => setActiveNote(note)}
                    onToggleFavorite={() => void useVaultStore.getState().toggleNoteFavorite(note.id)}
                  />
                ))}
              </ListSurface>
            </Section>
          ) : null}

          {/*
            * One hierarchy, listed once.
            *
            * This screen used to show Favorites, then "Recently edited", then
            * "All notes" — three overlapping lists answering three questions and
            * making the *one* thing that matters (the shape of the tree) the last
            * of them. Recency is still one tap away in Search → Recent, which is
            * where a recency listing belongs; here, what you see is the tree, from
            * its roots, exactly as Explorer shows a drive.
            */}
          <Section title="Top-level notes" className="pb-6">
            {rootNotes.length > 0 ? (
              <ListSurface>
                {rootNotes.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    childCount={childCounts.get(note.id) ?? 0}
                    linkCount={linkCounts.get(note.id) ?? 0}
                    onOpen={() => openNote(note.id)}
                    onShowActions={() => setActiveNote(note)}
                    onToggleFavorite={() => void useVaultStore.getState().toggleNoteFavorite(note.id)}
                  />
                ))}
              </ListSurface>
            ) : (
              <div className="px-4">
                <EmptyState
                  icon={<Layers size={20} strokeWidth={1.8} />}
                  title="Everything is nested"
                  description="You have no top-level notes. Open a note and add a sibling by moving one to the top level."
                />
              </div>
            )}
          </Section>
        </>
      )}

      <NoteActionsSheet
        key={activeNote?.id ?? 'no-note'}
        note={activeNote}
        onClose={() => setActiveNote(null)}
        onOpenNote={openNote}
      />
    </>
  );
}

export default function NotesPage() {
  return (
    <React.Suspense fallback={<div className="h-dvh bg-bg" />}>
      <NotesView />
    </React.Suspense>
  );
}
