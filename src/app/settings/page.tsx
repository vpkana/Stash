'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Archive,
  ChevronRight,
  Inbox,
  Monitor,
  Moon,
  Shield,
  Sun,
  Trash2,
  Upload,
} from '@/components/ui/icons';
import { RotateCcw } from '@/components/ui/icons';
import { PrivacySettings } from '@/components/privacy/privacy-settings';
import { ExportPanel } from '@/components/backup/export-panel';
import { ImportFlow } from '@/components/backup/import-flow';
import { pluralize } from '@/lib/format';
import { useVaultStore } from '@/stores/vault-store';
import { useBackupStore } from '@/stores/backup-store';
import { useThemeStore, type ThemeMode } from '@/stores/theme-store';
import { Button } from '@/components/ui/button';
import { LogoTile } from '@/components/ui/logo';
import { PageHeader, PageTitle, Section } from '@/components/ui/page';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/**
 * Settings.
 *
 * Small on purpose. The two things that genuinely matter are stated plainly and
 * nothing else: your data is on this device, and you can take it out whenever
 * you want. Destructive actions live behind an explicit, described choice.
 */
export default function SettingsPage() {
  const folders = useVaultStore((state) => state.folders);
  const links = useVaultStore((state) => state.links);
  const notes = useVaultStore((state) => state.visibleNotes);
  const hidden = useVaultStore((state) => state.hidden);
  const inboxCount = useVaultStore((state) => state.inboxLinks.length);
  // Every count on this screen is a listing, so every one of them is drawn from
  // what this session may actually read. A "1,204 links" total that included
  // protected ones would be a number the user cannot reconcile with anything.
  const unavailableCount = useVaultStore(
    (state) => state.links.filter((link) => link.isUnavailable && !link.isArchived && !state.hidden.links.has(link.id)).length,
  );
  const trashCount = useVaultStore((state) => state.trashGroups.length);
  const loadTrash = useVaultStore((state) => state.loadTrash);
  const refresh = useVaultStore((state) => state.refresh);
  const mode = useThemeStore((state) => state.mode);
  const setMode = useThemeStore((state) => state.setMode);

  const [busy, setBusy] = React.useState(false);
  const [confirmErase, setConfirmErase] = React.useState(false);
  const beginImport = useBackupStore((state) => state.beginImport);

  const readableLinks = links.filter((link) => !hidden.links.has(link.id));
  const readableNotes = notes.filter((note) => !hidden.notes.has(note.id));
  const readableFolders = folders.filter((folder) => !hidden.folders.has(folder.id));
  const activeLinks = readableLinks.filter((link) => !link.isArchived);
  const archived = readableLinks.length - activeLinks.length;
  const withNotes = activeLinks.filter((link) => link.userNote?.trim()).length;
  /*
   * The erase warning counts *everything*, protected content included.
   *
   * This is the one screen where being generous with the number is the honest
   * thing: an understated total on an irreversible action would be a lie about
   * what is about to be destroyed, and the user is the person who owns all of it.
   */
  const eraseCounts = {
    links: links.filter((link) => !link.isArchived).length,
    notes: notes.length,
    folders: folders.length,
  };

  // The trash count is needed here to label the entry point, so it is read when
  // Settings opens rather than only when the Trash screen is visited.
  React.useEffect(() => {
    void loadTrash();
  }, [loadTrash]);

  const handleErase = async () => {
    setBusy(true);
    const { eraseVault } = await import('@/db/repos/vault');
    await eraseVault();
    await refresh();
    setBusy(false);
    setConfirmErase(false);
    toast('Vault erased', { tone: 'success' });
  };

  return (
    <>
      <PageHeader>
        <PageTitle subtitle="Stored only on this device">Settings</PageTitle>
      </PageHeader>

      <Section title="Appearance">
        <div className="card mx-4 p-1">
          <div className="flex gap-1">
            {THEME_OPTIONS.map((option) => {
              const OptionIcon = option.icon;
              const active = mode === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => void setMode(option.id)}
                  aria-pressed={active}
                  className={cn(
                    'tap flex flex-1 flex-col items-center gap-1 rounded-xl py-3 text-meta font-medium',
                    active ? 'bg-accent-soft text-accent' : 'text-muted active:bg-surface-2',
                  )}
                >
                  <OptionIcon size={18} strokeWidth={active ? 2.2 : 1.9} aria-hidden />
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      </Section>

      <PrivacySettings />

      <Section title="Your vault">
        <div className="mx-4 overflow-hidden rounded-control border-border bg-surface border">
          <StatRow label="Saved links" value={pluralize(activeLinks.length, 'link')} />
          <StatRow label="Notes" value={pluralize(readableNotes.length, 'note')} />
          <StatRow label="With your own note" value={pluralize(withNotes, 'link')} />
          <StatRow label="Folders" value={pluralize(readableFolders.length, 'folder')} />
          <StatRow label="In the Inbox" value={pluralize(inboxCount, 'link')} />
          <StatRow label="Marked unavailable" value={pluralize(unavailableCount, 'link')} />
          <StatRow label="Archived" value={pluralize(archived, 'link')} last />
        </div>

        {/*
          Recovery is grouped here rather than buried under the vault numbers,
          because the trash is the answer to "I deleted that by mistake" and that
          question is asked in a hurry.
        */}
        <div className="mx-4 mt-3 flex flex-col gap-2">
          <Link
            href="/inbox"
            className="tap flex items-center gap-3 rounded-2xl border border-hairline bg-surface px-4 py-3.5 active:bg-surface-2"
          >
            <Inbox size={18} strokeWidth={1.9} className="shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-row font-medium text-fg">Inbox</span>
              <span className="block text-meta text-subtle">
                {inboxCount === 0 ? 'Nothing waiting to be organized' : `${inboxCount} to file`}
              </span>
            </span>
            <ChevronRight size={17} strokeWidth={2} className="shrink-0 text-subtle" aria-hidden />
          </Link>
          <Link
            href="/search?filter=archived"
            className="tap flex items-center gap-3 rounded-2xl border border-hairline bg-surface px-4 py-3.5 active:bg-surface-2"
          >
            <Archive size={18} strokeWidth={1.9} className="shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-row font-medium text-fg">Archive</span>
              <span className="block text-meta text-subtle">
                {archived === 0 ? 'Nothing archived' : `${pluralize(archived, 'thing')} kept out of the way`}
              </span>
            </span>
            <ChevronRight size={17} strokeWidth={2} className="shrink-0 text-subtle" aria-hidden />
          </Link>
          <Link
            href="/trash"
            className="tap flex items-center gap-3 rounded-2xl border border-hairline bg-surface px-4 py-3.5 active:bg-surface-2"
          >
            <RotateCcw size={18} strokeWidth={1.9} className="shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-row font-medium text-fg">Trash</span>
              <span className="block text-meta text-subtle">
                {trashCount === 0
                  ? 'Everything you delete can be restored'
                  : `${pluralize(trashCount, 'thing')} you can restore`}
              </span>
            </span>
            <ChevronRight size={17} strokeWidth={2} className="shrink-0 text-subtle" aria-hidden />
          </Link>
        </div>
        <p className="flex items-start gap-2 px-5 pt-2.5 text-meta leading-relaxed text-subtle">
          <Shield size={14} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden />
          Nothing here is uploaded. There is no account and no server, so the vault works exactly the same in
          airplane mode.
        </p>
      </Section>

      <Section title="Backup and restore">
        <ExportPanel />

        <div className="mx-4 mt-4 flex flex-col gap-2">
          <Button variant="surface" className="justify-start" onClick={() => void beginImport()}>
            <Upload size={18} strokeWidth={1.9} aria-hidden />
            Restore from a backup
          </Button>
          <p className="px-1 text-meta leading-relaxed text-subtle">
            Opens the system file picker. The file is checked completely — format, version, structure and every
            reference — before anything in your vault is touched, and you are shown what a restore would change
            before agreeing to it.
          </p>
          <p className="px-1 text-meta leading-relaxed text-subtle">
            &ldquo;Add what is missing&rdquo; never overwrites: an item that is already here is left alone, so importing the
            same file twice cannot duplicate or damage anything. &ldquo;Replace everything&rdquo; clears the vault first and
            writes a safety copy you can restore from.
          </p>
        </div>
      </Section>

      <Section title="Danger zone" className="pb-10">
        <div className="mx-4 rounded-2xl border border-danger/30 bg-danger-soft p-4">
          <p className="text-row font-semibold text-danger">Erase everything</p>
          <p className="mt-1.5 text-meta leading-relaxed text-fg/80">
            Deletes {pluralize(eraseCounts.links, 'link')}, {pluralize(eraseCounts.notes, 'note')} and{' '}
            {pluralize(eraseCounts.folders, 'folder')} from this device, including anything in the trash. Export first
            if you want a copy — this cannot be undone.
          </p>
          <div className="mt-3.5 flex items-center justify-between gap-3">
            <span className="text-meta font-medium text-fg">I understand this is permanent</span>
            <Switch
              checked={confirmErase}
              onCheckedChange={(value) => setConfirmErase(value)}
              aria-label="Confirm permanent erase"
            />
          </div>
          <Button
            variant="danger"
            className="mt-3 w-full"
            disabled={!confirmErase || busy}
            onClick={() => void handleErase()}
          >
            <Trash2 size={18} strokeWidth={2.1} aria-hidden />
            Erase vault
          </Button>
        </div>
      </Section>

      {/* The brand sign-off. The mark appears exactly twice in the app — on the
          launch screen and here — so seeing it again means "this is the bottom of
          everything", which is a nicer end to a settings page than a version
          string on its own. */}
      <div className="flex flex-col items-center gap-2 px-5 pt-2 pb-10">
        <LogoTile size={40} />
        <p className="text-meta text-subtle text-center">Stash v0.1 · offline vault for links and notes</p>
      </div>

      {/* Mounted once for the whole page: the flow is driven by the store, so it
          appears and disappears with the import rather than with a button. */}
      <ImportFlow />
    </>
  );
}

const THEME_OPTIONS: ReadonlyArray<{ id: ThemeMode; label: string; icon: typeof Sun }> = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
];

function StatRow({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center justify-between px-4 py-3 text-row',
        !last && 'border-b border-border',
      )}
    >
      <span className="text-muted">{label}</span>
      <span className="font-medium text-fg">{value}</span>
    </div>
  );
}
