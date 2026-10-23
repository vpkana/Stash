'use client';

import * as React from 'react';
import { Copy, Key, ShieldCheck } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { useSyncStore } from '@/stores/sync-store';

/**
 * The recovery key, in both directions.
 *
 * Creating one is the only moment the key exists in readable form; the app keeps
 * only a wrap of the vault key under it. Adopting one is how a second device —
 * or this device after its keystore was invalidated — can open synced locked
 * content at all. Neither direction is an access-control shortcut: after the key
 * installs the vault key, opening a locked folder still asks the device prompt.
 */

export type RecoveryMode = 'create' | 'adopt';

export function RecoveryDialog({
  open,
  mode,
  onOpenChange,
}: {
  open: boolean;
  mode: RecoveryMode;
  onOpenChange: (open: boolean) => void;
}) {
  const recoverySet = useSyncStore((state) => state.recoverySet);
  const createRecovery = useSyncStore((state) => state.createRecovery);
  const adoptRecovery = useSyncStore((state) => state.adoptRecovery);

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [createdKey, setCreatedKey] = React.useState<string | null>(null);
  const [input, setInput] = React.useState('');
  const descriptionId = React.useId();

  const create = async () => {
    setBusy(true);
    setError(null);
    const result = await createRecovery();
    setBusy(false);
    if (!result.ok || !result.key) {
      setError(result.message ?? 'Could not create a recovery key.');
      return;
    }
    setCreatedKey(result.key);
  };

  const adopt = async () => {
    setBusy(true);
    setError(null);
    const result = await adoptRecovery(input);
    setBusy(false);
    if (!result.ok) {
      setError(result.message ?? 'That recovery key did not work.');
      return;
    }
    onOpenChange(false);
    toast('Recovery key accepted. Locked content can now be opened on this device.', {
      tone: 'success',
    });
  };

  const copy = async () => {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      toast('Recovery key copied. Store it somewhere offline.', { tone: 'success' });
    } catch {
      toast('Could not copy. Write the key down before closing.', { tone: 'danger' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent describedBy={descriptionId}>
        {createdKey ? (
          <>
            <DialogTitle>Your recovery key</DialogTitle>
            <DialogDescription id={descriptionId}>
              This is the only time it is shown. Write it down and keep it somewhere offline — a password
              manager or paper is fine, a screenshot in your camera roll is not.
            </DialogDescription>
            <div className="mt-4 rounded-xl border border-border bg-surface-2 px-3 py-3">
              <p className="font-mono text-title leading-relaxed tracking-wide text-fg break-all">
                {createdKey}
              </p>
            </div>
            <div className="mt-3 flex gap-2">
              <Button variant="surface" className="flex-1" onClick={() => void copy()}>
                <Copy size={17} strokeWidth={1.9} aria-hidden />
                Copy
              </Button>
              <Button variant="primary" className="flex-1" onClick={() => onOpenChange(false)}>
                I have saved it
              </Button>
            </div>
            <p className="mt-2 px-0.5 text-meta leading-relaxed text-subtle">
              Stash keeps only an encrypted copy of your vault key locked by this one. If you lose it, locked
              content on a new device cannot be opened — there is no reset.
            </p>
          </>
        ) : mode === 'create' ? (
          <>
            <DialogTitle>{recoverySet ? 'Create a new recovery key' : 'Set up a recovery key'}</DialogTitle>
            <DialogDescription id={descriptionId}>
              A recovery key lets you open locked content on another device, or on this one after its secure
              storage is reset. It does not unlock anything by itself: after you use it, opening a locked folder
              still asks for your device unlock.
            </DialogDescription>
            {recoverySet ? (
              <p className="mt-3 rounded-xl border border-warning/30 bg-surface-2 px-3 py-2.5 text-meta leading-relaxed text-fg/85">
                This replaces the existing recovery key. The old one stops working immediately, so keep both
                until the new one is written down.
              </p>
            ) : null}
            <div className="mt-3 flex flex-col gap-2">
              <Button variant="primary" className="w-full" disabled={busy} onClick={() => void create()}>
                <Key size={18} strokeWidth={1.9} aria-hidden />
                {busy ? 'Creating…' : recoverySet ? 'Create a new key' : 'Create my recovery key'}
              </Button>
              <p className="px-0.5 text-meta leading-relaxed text-subtle">
                This needs the vault key in memory, so unlock a locked folder first if the button reports that
                it cannot continue.
              </p>
              {error ? (
                <p className="px-0.5 text-meta leading-relaxed text-danger" role="status">
                  {error}
                </p>
              ) : null}
              <Button variant="ghost" className="w-full" disabled={busy} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogTitle>Use a recovery key</DialogTitle>
            <DialogDescription id={descriptionId}>
              Enter the key you saved when you set up locked content. It installs the vault key on this device so
              synced locked items can be opened — Google sign-in alone never unlocks them.
            </DialogDescription>
            <div className="mt-4 flex flex-col gap-2">
              <Label htmlFor="recovery-key">Recovery key</Label>
              <Input
                id="recovery-key"
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                  setError(null);
                }}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                className="font-mono text-body"
              />
              <Button
                variant="primary"
                className="w-full"
                disabled={busy || input.trim().length === 0}
                onClick={() => void adopt()}
              >
                <ShieldCheck size={18} strokeWidth={1.9} aria-hidden />
                {busy ? 'Checking…' : 'Use this key'}
              </Button>
              {error ? (
                <p className="px-0.5 text-meta leading-relaxed text-danger" role="status">
                  {error}
                </p>
              ) : null}
              <Button variant="ghost" className="w-full" disabled={busy} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
