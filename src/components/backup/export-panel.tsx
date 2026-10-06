'use client';

import * as React from 'react';
import { AlertTriangle, Download, Loader2, ShieldCheck } from '@/components/ui/icons';
import { BACKUP_MODES, type BackupMode } from '@/lib/backup/format';
import { useBackupStore } from '@/stores/backup-store';
import { usePrivacyStore } from '@/stores/privacy-store';
import { useVaultStore } from '@/stores/vault-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/**
 * Exporting the vault.
 *
 * The mode picker is the honest part of this screen. All three modes produce a
 * complete backup; they differ only in what happens to *locked* content, and the
 * consequence of each is spelled out underneath rather than left to be inferred
 * from a label. Nothing here is a hidden default: the choice is the user's, and
 * it is made with the trade-off in front of them.
 */

const MIN_PASSPHRASE = 8;

export function ExportPanel() {
  const exportVault = useBackupStore((state) => state.exportVault);
  const busy = useBackupStore((state) => state.busy);
  const exportedName = useBackupStore((state) => state.exportName);
  const exportPath = useBackupStore((state) => state.exportPath);
  const message = useBackupStore((state) => state.message);

  const protection = useVaultStore((state) => state.protection);
  const unlocked = usePrivacyStore((state) => state.unlocked);
  const keyringPresent = usePrivacyStore((state) => state.keyringPresent);

  const [mode, setMode] = React.useState<BackupMode>('sealed');
  const [passphrase, setPassphrase] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const lockedCount = protection.folders.size + protection.notes.size + protection.links.size;
  const needsPassphrase = mode === 'encrypted';
  const plaintextNeedsUnlock = mode === 'plaintext' && keyringPresent && !unlocked;

  const run = async () => {
    setError(null);

    if (needsPassphrase) {
      if (passphrase.length < MIN_PASSPHRASE) {
        setError(`Use at least ${MIN_PASSPHRASE} characters. This passphrase is the only way back into the file.`);
        return;
      }
      if (passphrase !== confirmation) {
        setError('The two passphrases do not match.');
        return;
      }
    }

    const ok = await exportVault({ mode, passphrase: needsPassphrase ? passphrase : undefined });

    // The passphrase has done its job; it does not need to sit in a text field
    // for the rest of the session.
    setPassphrase('');
    setConfirmation('');

    if (ok) toast('Backup ready', { tone: 'success' });
    else if (message) toast(message, { tone: 'danger' });
  };

  const chosen = BACKUP_MODES.find((option) => option.id === mode);

  return (
    <div className="mx-4 flex flex-col gap-3">
      <div className="card" role="radiogroup" aria-label="Backup type">
        {BACKUP_MODES.map((option, index) => {
          const active = option.id === mode;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => {
                setMode(option.id);
                setError(null);
              }}
              className={cn(
                'tap flex w-full items-start gap-3 px-4 py-3 text-left',
                index > 0 && 'border-t border-border',
                active ? 'bg-accent-soft' : 'active:bg-surface-2',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
                  active ? 'border-accent' : 'border-border-strong',
                )}
                aria-hidden
              >
                {active ? <span className="h-2.5 w-2.5 rounded-full bg-accent" /> : null}
              </span>
              <span className="min-w-0">
                <span className={cn('block text-row font-medium', active ? 'text-accent' : 'text-fg')}>
                  {option.label}
                </span>
                <span className="mt-0.5 block text-meta leading-relaxed text-muted">{option.description}</span>
              </span>
            </button>
          );
        })}
      </div>

      {needsPassphrase ? (
        <div className="flex flex-col gap-2">
          <Input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            placeholder="Passphrase for this file"
            autoComplete="new-password"
            aria-label="Backup passphrase"
          />
          <Input
            type="password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder="Type it again"
            autoComplete="new-password"
            aria-label="Confirm backup passphrase"
          />
          <p className="px-1 text-meta leading-relaxed text-subtle">
            This passphrase protects the file itself, and nothing else. There is no recovery code: if it is lost,
            the file cannot be opened again — not by you, and not by Stash.
          </p>
        </div>
      ) : null}

      {chosen?.id === 'sealed' && lockedCount > 0 ? (
        <p className="flex items-start gap-2 px-1 text-meta leading-relaxed text-subtle">
          <ShieldCheck size={14} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden />
          {lockedCount} locked item(s) stay encrypted in the file. A vault that still carries a passcode wrap
          travels with it, so a restore can open them; a vault locked with the device prompt alone has no key to
          hand over, and those items can only be opened on the device that wrote this file.
        </p>
      ) : null}

      {chosen?.id === 'plaintext' && lockedCount > 0 ? (
        <p className="flex items-start gap-2 px-1 text-meta leading-relaxed text-danger">
          <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden />
          Everything readable means exactly that: your {lockedCount} locked item(s) are written out in plain text.
          Anyone who gets this file reads all of it.
        </p>
      ) : null}

      {plaintextNeedsUnlock ? (
        <p className="px-1 text-meta leading-relaxed text-danger">
          Unlock Stash first. A fully readable export has to open every locked item, and it will not write a file
          that claims to be readable while hiding parts of it.
        </p>
      ) : null}

      {error ? <p className="px-1 text-meta leading-relaxed text-danger">{error}</p> : null}

      <Button
        variant="primary"
        className="justify-start"
        disabled={busy || plaintextNeedsUnlock}
        onClick={() => void run()}
      >
        {busy ? (
          <Loader2 size={18} strokeWidth={1.9} className="animate-spin" aria-hidden />
        ) : (
          <Download size={18} strokeWidth={1.9} aria-hidden />
        )}
        Export a backup
      </Button>

      {exportedName && !busy ? (
        <p className="px-1 text-meta leading-relaxed text-subtle">
          {exportPath
            ? `Written as ${exportedName} and handed to the share sheet, so you choose where it goes.`
            : `${exportedName} is ready. Stash does not pick a location for you — the system share sheet does.`}
        </p>
      ) : null}
      {message && !busy ? <p className="px-1 text-meta leading-relaxed text-danger">{message}</p> : null}
    </div>
  );
}
