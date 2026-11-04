'use client';

import * as React from 'react';
import { AlertTriangle, Download, Loader2 } from '@/components/ui/icons';
import { useBackupStore } from '@/stores/backup-store';
import { usePrivacyStore } from '@/stores/privacy-store';
import { useVaultStore } from '@/stores/vault-store';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';
import { ConfirmAuth } from '@/components/privacy/confirm-auth';

/**
 * Exporting the vault.
 *
 * There is one kind of backup now: a complete, readable copy of everything. That
 * is a deliberate narrowing. The old sheet offered three modes, and the default —
 * "locked items stay encrypted" — wrote a file whose locked rows were sealed
 * under a key that never travelled with it (a device keyring has no passcode wrap
 * to hand over). Restoring that file produced rows nothing on the new device could
 * ever decrypt, which read as links that had vanished.
 *
 * So the file is the vault in the clear, and the consequences are stated on the
 * screen that produces it:
 *
 *  - if locking is set up, the device prompt comes first, because this file
 *    exposes exactly what the lock exists to withhold;
 *  - the warning says the file is readable and that a re-import arrives unlocked,
 *    so the locks have to be put back by hand.
 *
 * The import side still accepts every mode an older build could have written.
 * This changes what Stash writes, not what it can read.
 */

export function ExportPanel() {
  const exportVault = useBackupStore((state) => state.exportVault);
  const busy = useBackupStore((state) => state.busy);
  const exportedName = useBackupStore((state) => state.exportName);
  const exportPath = useBackupStore((state) => state.exportPath);
  const message = useBackupStore((state) => state.message);

  const protection = useVaultStore((state) => state.protection);
  const keyringPresent = usePrivacyStore((state) => state.keyringPresent);

  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const lockedCount = protection.folders.size + protection.notes.size + protection.links.size;
  const needsAuth = keyringPresent;

  const close = () => {
    setOpen(false);
    setError(null);
  };

  const run = async () => {
    setError(null);
    const ok = await exportVault({ mode: 'plaintext' });
    if (ok) {
      toast('Backup ready', { tone: 'success' });
      setOpen(false);
    } else {
      setError(message ?? 'The backup could not be created.');
    }
  };

  return (
    <>
      <div className="mx-4 flex flex-col gap-3">
        <Button variant="primary" className="justify-start" onClick={() => setOpen(true)} disabled={busy}>
          {busy ? (
            <Loader2 size={18} strokeWidth={1.9} className="animate-spin" aria-hidden />
          ) : (
            <Download size={18} strokeWidth={1.9} aria-hidden />
          )}
          Export a backup
        </Button>
        <p className="px-1 text-meta leading-relaxed text-subtle">
          A complete, readable copy of this vault, created on this device and handed to the share sheet so you
          choose where it goes.
        </p>

        {exportedName && !busy ? (
          <p className="px-1 text-meta leading-relaxed text-subtle">
            {exportPath
              ? `Written as ${exportedName} and handed to the share sheet, so you choose where it goes.`
              : `${exportedName} is ready. Stash does not pick a location for you — the system share sheet does.`}
          </p>
        ) : null}
        {message && !busy && !open ? <p className="px-1 text-meta leading-relaxed text-danger">{message}</p> : null}
      </div>

      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (next) setOpen(true);
          else if (!busy) close();
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Export a backup</SheetTitle>
            <SheetDescription>
              One complete file: every folder, note and link you have, with nothing left encrypted inside it.
            </SheetDescription>
          </SheetHeader>

          <SheetBody>
            <div className="flex flex-col gap-3 pb-3">
              <div className="rounded-2xl border border-warning/40 bg-surface-2 p-4">
                <p className="flex items-start gap-2 text-meta font-semibold text-fg">
                  <AlertTriangle size={15} strokeWidth={2.2} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                  The exported file contains all the details in unlocked format
                </p>
                <p className="mt-1.5 text-meta leading-relaxed text-muted">
                  Your {lockedCount > 0 ? `${lockedCount} locked item(s) and ` : ''}everything else are written in
                  readable form — links, addresses, notes, titles and folder names. Anyone who gets this file reads
                  all of it, so keep it somewhere you trust.
                </p>
                <p className="mt-1.5 text-meta leading-relaxed text-muted">
                  Because the file is unlocked, importing it again gives you an unlocked vault: you will need to
                  lock those folders, notes and links again afterwards.
                </p>
              </div>

              {needsAuth ? (
                <p className="px-1 text-meta leading-relaxed text-subtle">
                  Locking is set up on this device, so your fingerprint, face, PIN or pattern is asked for before
                  the file is written.
                </p>
              ) : null}

              {error ? <p className="px-1 text-meta leading-relaxed text-danger">{error}</p> : null}
            </div>
          </SheetBody>

          <SheetFooter>
            {needsAuth ? (
              <div className="flex w-full flex-col">
                <ConfirmAuth
                  reason="Export your Stash vault in readable form"
                  confirmLabel="Create the backup"
                  onAuthorized={run}
                  onCancel={close}
                  disabled={busy}
                />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={close} disabled={busy}>
                  Cancel
                </Button>
                <div className="flex-1" />
                <Button variant="primary" disabled={busy} onClick={() => void run()}>
                  {busy ? (
                    <Loader2 size={18} strokeWidth={1.9} className="animate-spin" aria-hidden />
                  ) : (
                    <Download size={18} strokeWidth={1.9} aria-hidden />
                  )}
                  {busy ? 'Preparing…' : 'Create backup'}
                </Button>
              </div>
            )}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
