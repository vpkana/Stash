'use client';

import * as React from 'react';
import { AlertTriangle, Lock, ShieldCheck } from '@/components/ui/icons';
import { usePrivacyStore } from '@/stores/privacy-store';
import { Button } from '@/components/ui/button';

/**
 * The message shown when Stash has taken its locks off a device that cannot
 * enforce them.
 *
 * ## The rule it reports
 *
 * Every app open asks the operating system whether this device has a screen lock
 * at all — fingerprint, face, PIN, pattern or password, as opposed to only a
 * swipe. When the answer is no, a Stash lock has nothing behind it: the prompt
 * that opens a locked folder is the system's, and a device with no screen lock
 * has no prompt to give. The lock would not protect the content, it would only
 * hide it, and the hiding would survive every attempt to undo it — which is
 * precisely the trap this feature is supposed to be the opposite of.
 *
 * So the locks come off, their content is unsealed first so that nothing is
 * stranded as ciphertext nobody can read, and this dialog says so. It is a
 * statement of what the app just did rather than a question, because the answer
 * is not the user's to give: either the device has a screen lock, or a Stash lock
 * cannot be enforced.
 *
 * ## The case where it does nothing
 *
 * When the content cannot be unsealed — a vault still locked by the passcode of
 * an older build, with no device key to open it — removing the locks would delete
 * the record that protects content it cannot unlock. That is the one situation
 * where the app keeps the locks, and the dialog says that instead: nothing is
 * lost, and the one-time passcode prompt is how it gets resolved.
 */
export function NoScreenLockNotice() {
  const notice = usePrivacyStore((state) => state.noScreenLockNotice);
  const dismiss = usePrivacyStore((state) => state.dismissNoScreenLockNotice);
  const keyringPresent = usePrivacyStore((state) => state.keyringPresent);

  if (!notice) return null;

  const { locksCleared, opened, unreadable } = notice;
  const cleared = locksCleared.folders + locksCleared.notes + locksCleared.links;
  const released = opened.folders + opened.notes + opened.links;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Locks removed"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-overlay px-6 py-10 pt-safe pb-safe"
    >
      <div className="w-full max-w-sm rounded-2xl border border-hairline bg-surface p-5 shadow-raised">
        {notice.outcome === 'removed' ? (
          <>
            <span className="flex size-11 items-center justify-center rounded-2xl bg-warning/15 text-warning">
              <Lock size={22} strokeWidth={1.9} aria-hidden />
            </span>
            <h1 className="text-title mt-3 font-semibold tracking-tight text-fg">Locks removed</h1>
            <p className="text-body mt-1.5 leading-relaxed text-muted">
              Removed all the locks in every directories and files since no screen lock has been enabled by
              the user for this device.
            </p>
            <p className="text-meta mt-3 leading-relaxed text-subtle">
              Stash locks a folder by asking your device to verify you — the same prompt a banking app uses.
              This device has no fingerprint, face, PIN, pattern or password to ask for, so a lock here would
              hide content without protecting it, and could not be undone. Nothing was deleted:
              {released > 0
                ? ` ${released} encrypted ${released === 1 ? 'item was' : 'items were'} returned to your vault in full.`
                : ' everything is exactly where it was.'}
              {cleared > 0 ? ` ${cleared} ${cleared === 1 ? 'lock was' : 'locks were'} cleared.` : ''}
            </p>
            <p className="text-meta mt-3 leading-relaxed text-subtle">
              Set a screen lock in your device settings and you can lock folders again from any folder, note
              or link.
            </p>
          </>
        ) : (
          <>
            <span className="flex size-11 items-center justify-center rounded-2xl bg-danger-soft text-danger">
              <AlertTriangle size={22} strokeWidth={1.9} aria-hidden />
            </span>
            <h1 className="text-title mt-3 font-semibold tracking-tight text-fg">
              This device has no screen lock
            </h1>
            <p className="text-body mt-1.5 leading-relaxed text-muted">
              Stash locks an item by asking your device to verify you, and this device has no fingerprint,
              face, PIN, pattern or password to ask for. Your locks were kept anyway —{' '}
              {unreadable} encrypted {unreadable === 1 ? 'item' : 'items'} cannot be opened here, and removing
              the locks would have deleted the only record protecting them.
            </p>
            <p className="text-meta mt-3 flex items-start gap-2 leading-relaxed text-subtle">
              <ShieldCheck size={14} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden />
              Nothing has been lost. Open a locked item and enter the passcode this vault was locked with,
              once. On a device that can ask for an unlock, that moves the vault to your device lock; on this
              one, where nothing can, it returns your content and takes the locks off.
            </p>
          </>
        )}

        <Button variant="primary" size="lg" className="mt-4 w-full" onClick={dismiss}>
          <ShieldCheck size={19} strokeWidth={1.9} aria-hidden />
          {notice.outcome === 'blocked' && keyringPresent ? 'Open a locked item' : 'Got it'}
        </Button>
      </div>
    </div>
  );
}
