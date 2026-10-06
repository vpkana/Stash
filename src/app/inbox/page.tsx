'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Inbox as InboxIcon, Loader2, FolderInput, Sparkles } from '@/components/ui/icons';
import type { Folder, SavedLink } from '@/db/types';
import { pluralize } from '@/lib/format';
import { openExternal } from '@/lib/open-external';
import { destinationLabel, type DestinationSelection } from '@/lib/destination';
import { useVaultStore, selectInboxLinks } from '@/stores/vault-store';
import { requireFolderAccess } from '@/lib/privacy/access';
import { Button } from '@/components/ui/button';
import { EmptyState, ListSurface, PageHeader, PageTitle, Section } from '@/components/ui/page';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';
import { useBackDismiss } from '@/hooks/use-back-dismiss';
import { LinkRow } from '@/components/links/link-row';
import { LinkActionsSheet } from '@/components/links/link-actions-sheet';
import { FolderDestinationList } from '@/components/capture/folder-destination-list';

/**
 * The Inbox: everything saved in a hurry.
 *
 * Saving must never begin with a decision, so the fastest capture path writes
 * nothing but the link and leaves it here. That only works if emptying the Inbox
 * is genuinely quick, which is what this screen is for — and it is why the bulk
 * action comes first: the common case is a handful of links that all belong in
 * the same place, not nineteen individual judgements.
 *
 * The Inbox is not a folder. It is the absence of one — `folderId === null` — so
 * there is no second place a link can live and no way for a link to be "in the
 * Inbox and something else". Filing something is a move, and moves are
 * reversible.
 */
export default function InboxPage() {
  const router = useRouter();
  const inbox = useVaultStore(selectInboxLinks);
  const folders = useVaultStore((state) => state.folders);
  const markLinkOpened = useVaultStore((state) => state.markLinkOpened);

  const [activeLink, setActiveLink] = React.useState<SavedLink | null>(null);
  const [filingAll, setFilingAll] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const openLink = React.useCallback(
    (link: SavedLink) => {
      void markLinkOpened(link.id);
      void openExternal(link.url);
    },
    [markLinkOpened],
  );

  const fileAll = async (selection: DestinationSelection) => {
    const folderId = selection.kind === 'folder' ? selection.folderId : null;
    // Filing is a write into the destination, so the boundary is checked at the
    // write as well as at the picker. A protected folder that stayed shut leaves
    // the Inbox exactly as it was rather than swallowing the links.
    if (folderId && !(await requireFolderAccess(folderId))) {
      setFilingAll(false);
      toast('That folder stayed locked, so nothing was filed.', { tone: 'danger' });
      return;
    }
    const targets = [...inbox];
    setBusy(true);
    // Sequential on purpose: each move is its own transaction, and a vault with
    // thousands of links in the Inbox should not open thousands of them at once.
    for (const link of targets) {
      await useVaultStore.getState().moveLink(link.id, folderId);
    }
    setBusy(false);
    setFilingAll(false);
    toast(
      targets.length > 0
        ? `Filed ${pluralize(targets.length, 'link')} to ${destinationLabel(selection, folders)}`
        : 'Nothing to file',
      { tone: 'success' },
    );
  };

  return (
    <>
      <PageHeader>
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={() => router.push('/')}
            aria-label="Back to Home"
            className="tap -ml-1.5 flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
          >
            <ArrowLeft size={19} strokeWidth={2} aria-hidden />
          </button>
          <div className="min-w-0 flex-1">
            <PageTitle
              subtitle={
                inbox.length === 0
                  ? 'Nothing waiting to be organized'
                  : `${pluralize(inbox.length, 'link')} waiting to be organized`
              }
            >
              Inbox
            </PageTitle>
          </div>
        </div>

        {inbox.length > 0 ? (
          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="accentSoft"
              size="sm"
              className="flex-1"
              disabled={busy}
              onClick={() => setFilingAll(true)}
            >
              <FolderInput size={16} strokeWidth={2} aria-hidden />
              File all {inbox.length}
            </Button>
          </div>
        ) : null}
      </PageHeader>

      {inbox.length === 0 ? (
        <div className="px-4 pt-4">
          <EmptyState
            icon={<Sparkles size={22} strokeWidth={1.7} />}
            title="Nothing waiting to be organized."
            description="When you save from another app without picking a folder, the link lands here so you can file it later — or never, if it is fine where it is."
            action={
              <Button variant="surface" size="sm" onClick={() => router.push('/search')}>
                Search your vault
              </Button>
            }
          />
        </div>
      ) : (
        <Section title="Saved, not filed">
          <ListSurface>
            {inbox.map((link) => (
              <LinkRow
                key={link.id}
                link={link}
                onOpen={() => openLink(link)}
                onToggleFavorite={() => void useVaultStore.getState().toggleLinkFavorite(link.id)}
                onShowActions={() => setActiveLink(link)}
              />
            ))}
          </ListSurface>
          <p className="flex items-start gap-2 px-5 pt-3 text-meta leading-relaxed text-subtle">
            <InboxIcon size={14} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden />
            Tap ⋯ on a row to file one link, or use File all to move the whole Inbox somewhere at once.
          </p>
        </Section>
      )}

      <div className="h-6" />

      <FileAllSheet
        open={filingAll}
        folders={folders}
        busy={busy}
        onClose={() => setFilingAll(false)}
        onSelect={(selection) => void fileAll(selection)}
      />

      <LinkActionsSheet
        key={activeLink?.id ?? 'no-link'}
        link={activeLink}
        onClose={() => setActiveLink(null)}
      />
    </>
  );
}

function FileAllSheet({
  open,
  folders,
  busy,
  onClose,
  onSelect,
}: {
  open: boolean;
  folders: readonly Folder[];
  busy: boolean;
  onClose: () => void;
  onSelect: (selection: DestinationSelection) => void;
}) {
  useBackDismiss(open, onClose);
  if (!open) return null;

  return (
    <Sheet open onOpenChange={(next) => !next && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>File the whole Inbox</SheetTitle>
          <p className="mt-0.5 text-meta text-subtle">
            Every link without a folder moves to one place. Nothing is deleted, so this can be undone by moving
            things again.
          </p>
        </SheetHeader>
        <SheetBody>
          {busy ? (
            <p className="flex items-center gap-2 px-3 pb-3 text-body text-muted">
              <Loader2 size={16} strokeWidth={2.4} className="animate-spin" aria-hidden />
              Filing…
            </p>
          ) : (
            <FolderDestinationList
              folders={folders}
              selection={{ kind: 'folder', folderId: null }}
              onSelect={onSelect}
              showInbox={false}
              alwaysFilterable={folders.length > 8}
              filterPlaceholder="Find a folder"
            />
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
