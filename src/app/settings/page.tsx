'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Check,
  ChevronRight,
  Download,
  Inbox,
  Monitor,
  Moon,
  Share2,
  Shield,
  Sun,
  Trash2,
  Upload,
} from '@/components/ui/icons';
import { ACCENTS } from '@/lib/accent';
import { RotateCcw } from '@/components/ui/icons';
import { PrivacySettings } from '@/components/privacy/privacy-settings';
import { ConfirmAuth } from '@/components/privacy/confirm-auth';
import { ExportPanel } from '@/components/backup/export-panel';
import { ANDROID_DOWNLOAD_URL, ShareGuide } from '@/components/onboarding/share-guide';
import { openExternal } from '@/lib/open-external';
import { ImportFlow } from '@/components/backup/import-flow';
import { pluralize } from '@/lib/format';
import { useVaultStore } from '@/stores/vault-store';
import { useBackupStore } from '@/stores/backup-store';
import { usePrivacyStore } from '@/stores/privacy-store';
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
    (state) => state.links.filter((link) => link.isUnavailable && !state.hidden.links.has(link.id)).length,
  );
  const trashCount = useVaultStore((state) => state.trashGroups.length);
  const loadTrash = useVaultStore((state) => state.loadTrash);
  const refresh = useVaultStore((state) => state.refresh);
  const mode = useThemeStore((state) => state.mode);
  const setMode = useThemeStore((state) => state.setMode);
  const accent = useThemeStore((state) => state.accent);
  const setAccent = useThemeStore((state) => state.setAccent);

  const [busy, setBusy] = React.useState(false);
  const [guideOpen, setGuideOpen] = React.useState(false);
  const [confirmErase, setConfirmErase] = React.useState(false);
  /*
   * Both irreversible entries below are behind a proof of identity before the
   * act, not after it. The acknowledgement switch and the file picker are about
   * *intent*; a passcode or a device prompt is about *authorisation*, and only
   * one of those can stop somebody else holding an unlocked phone.
   */
  const [eraseAuthorising, setEraseAuthorising] = React.useState(false);
  const [importAuthorising, setImportAuthorising] = React.useState(false);
  const beginImport = useBackupStore((state) => state.beginImport);

  const readableLinks = links.filter((link) => !hidden.links.has(link.id));
  const readableNotes = notes.filter((note) => !hidden.notes.has(note.id));
  const readableFolders = folders.filter((folder) => !hidden.folders.has(folder.id));
  const withTitles = readableLinks.filter((link) => link.title?.trim()).length;
  /*
   * The erase warning counts *everything*, protected content included.
   *
   * This is the one screen where being generous with the number is the honest
   * thing: an understated total on an irreversible action would be a lie about
   * what is about to be destroyed, and the user is the person who owns all of it.
   */
  const eraseCounts = {
    links: links.length,
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
    // The privacy session is rebuilt, not just the vault: the erasure removed the
    // keyring and the device key with everything else, so a session still holding
    // the old vault key would be claiming a lock that no longer exists — and the
    // user would be left on a screen that says "Locked" over an empty vault,
    // instead of being asked to set a passcode for the new one.
    await usePrivacyStore.getState().reload();
    await refresh();
    setBusy(false);
    setConfirmErase(false);
    setEraseAuthorising(false);
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

        {/*
          The accent, beside the mode rather than in a sub-screen: it is one
          decision with eight answers, and the page is its own preview — pick a
          swatch and the button above, the tab bar below and the selected row
          all change while you look at them.
        */}
        <div className="card mx-4 mt-2 p-4">
          <p className="text-row font-medium text-fg">Accent colour</p>
          <p className="mt-0.5 text-meta leading-relaxed text-subtle">
            Used for the primary action, the current tab and selections. The app icon stays ink and cream
            whatever you choose.
          </p>
          <div className="mt-3 grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Accent colour">
            {ACCENTS.map((option) => {
              const active = accent === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={option.label}
                  onClick={() => void setAccent(option.id)}
                  className={cn(
                    'tap flex flex-col items-center gap-1.5 rounded-xl px-1 pt-2 pb-1.5 text-meta font-medium',
                    active ? 'bg-accent-soft text-accent' : 'text-muted active:bg-surface-2',
                  )}
                >
                  <span
                    className="flex size-7 items-center justify-center rounded-full ring-1 ring-black/15 ring-inset"
                    style={{ backgroundColor: option.swatch }}
                    aria-hidden
                  >
                    {active ? <Check size={15} strokeWidth={3} className="text-white" /> : null}
                  </span>
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      </Section>

      <PrivacySettings />

      <Section title="Saving from other apps">
        {/*
          The one part of Stash that lives outside Stash. A settings row can be
          honest about that: the guide is worth watching once, and the download
          is for people who want the share sheet and nothing else.
        */}
        <div className="mx-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setGuideOpen(true)}
            className="tap flex items-center gap-3 rounded-2xl border border-hairline bg-surface px-4 py-3.5 text-left active:bg-surface-2"
          >
            <Share2 size={18} strokeWidth={1.9} className="shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-row font-medium text-fg">How sharing works</span>
              <span className="block text-meta text-subtle">The share sheet, step by step — phones only</span>
            </span>
            <ChevronRight size={17} strokeWidth={2} className="shrink-0 text-subtle" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => void openExternal(ANDROID_DOWNLOAD_URL)}
            className="tap flex items-center gap-3 rounded-2xl border border-hairline bg-surface px-4 py-3.5 text-left active:bg-surface-2"
          >
            <Download size={18} strokeWidth={1.9} className="shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-row font-medium text-fg">Get the Android app</span>
              <span className="block text-meta text-subtle">Share into Stash from any app</span>
            </span>
            <ChevronRight size={17} strokeWidth={2} className="shrink-0 text-subtle" aria-hidden />
          </button>
        </div>
      </Section>

      <Section title="Your vault">
        <div className="mx-4 overflow-hidden rounded-control border-border bg-surface border">
          {/*
            Every row here is a count of what is in the vault, so there is no row
            for a state that hides things. "Archived" used to be one, and it read
            as a reassuring label for what was really the answer to "where did my
            link go" — on a screen nobody opens looking for one.
          */}
          <StatRow label="Saved links" value={pluralize(readableLinks.length, 'link')} />
          <StatRow label="Notes" value={pluralize(readableNotes.length, 'note')} />
          <StatRow label="Named by you" value={pluralize(withTitles, 'link')} />
          <StatRow label="Folders" value={pluralize(readableFolders.length, 'folder')} />
          <StatRow label="In the Inbox" value={pluralize(inboxCount, 'link')} />
          <StatRow label="Marked unavailable" value={pluralize(unavailableCount, 'link')} last />
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
          {importAuthorising ? (
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="text-row font-medium text-fg">Confirm it is you</p>
              <ConfirmAuth
                reason="Restore a backup into your Stash vault"
                confirmLabel="Choose a backup file"
                onAuthorized={() => {
                  setImportAuthorising(false);
                  void beginImport();
                }}
                onCancel={() => setImportAuthorising(false)}
                hint={
                  <>
                    Restoring writes into this vault, so it asks first. <span className="font-medium text-fg">Exporting
                    never asks</span> — taking your own data out is always available.
                  </>
                }
              />
            </div>
          ) : (
            <Button variant="surface" className="justify-start" onClick={() => setImportAuthorising(true)}>
              <Upload size={18} strokeWidth={1.9} aria-hidden />
              Restore from a backup
            </Button>
          )}
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
          {eraseAuthorising ? (
            <ConfirmAuth
              reason="Erase your Stash vault"
              confirmLabel="Erase vault"
              tone="danger"
              disabled={!confirmErase}
              onAuthorized={handleErase}
              onCancel={() => setEraseAuthorising(false)}
              hint="Enter your passcode, or confirm with the device prompt, to erase everything on this device."
            />
          ) : (
            <Button
              variant="danger"
              className="mt-3 w-full"
              disabled={!confirmErase || busy}
              onClick={() => setEraseAuthorising(true)}
            >
              <Trash2 size={18} strokeWidth={2.1} aria-hidden />
              Erase vault
            </Button>
          )}
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
      <ShareGuide open={guideOpen} onClose={() => setGuideOpen(false)} />
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
