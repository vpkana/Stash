'use client';

import * as React from 'react';
import { CheckCircle2, FileJson, Info, Loader2, ShieldAlert } from '@/components/ui/icons';
import { useBackupStore } from '@/stores/backup-store';
import { planTotal } from '@/lib/backup/merge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useBackDismiss } from '@/hooks/use-back-dismiss';
import { cn } from '@/lib/utils';

/**
 * Restoring a backup.
 *
 * One sheet for the whole flow, driven entirely by the store's stage, because the
 * stages are the safety property: this component never decides what happens, it
 * only shows what the flow has already established. Any step that could touch the
 * database asks first, and every number the user is asked to agree to has been
 * computed from the file they actually chose.
 */

export function ImportFlow() {
  const stage = useBackupStore((state) => state.stage);
  const reset = useBackupStore((state) => state.reset);
  const open = stage !== 'idle';

  useBackDismiss(open, reset);

  return (
    <Sheet open={open} onOpenChange={(next) => !next && reset()}>
      <SheetContent showHandle={false} aria-describedby={undefined}>
        {stage === 'reading' ? <ReadingView /> : null}
        {stage === 'passphrase' ? <PassphraseView /> : null}
        {stage === 'review' ? <ReviewView /> : null}
        {stage === 'applying' ? <ApplyingView /> : null}
        {stage === 'done' ? <DoneView onClose={reset} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function ReadingView() {
  return (
    <>
      <SheetHeader>
        <SheetTitle>Checking the backup</SheetTitle>
      </SheetHeader>
      <div className="flex flex-col items-center gap-3 px-6 pb-14">
        <Loader2 size={26} strokeWidth={2} className="animate-spin text-accent" aria-hidden />
        <p className="text-body text-muted">Reading and validating the file…</p>
      </div>
    </>
  );
}

function ApplyingView() {
  return (
    <>
      <SheetHeader>
        <SheetTitle>Restoring</SheetTitle>
      </SheetHeader>
      <div className="flex flex-col items-center gap-3 px-6 pb-14">
        <Loader2 size={26} strokeWidth={2} className="animate-spin text-accent" aria-hidden />
        <p className="max-w-xs text-center text-meta leading-relaxed text-subtle">
          This is one database transaction. If anything fails it rolls back whole, and your current data is left
          exactly as it was.
        </p>
      </div>
    </>
  );
}

function PassphraseView() {
  const pending = useBackupStore((state) => state.pending);
  const pendingMessage = useBackupStore((state) => state.message);
  const busy = useBackupStore((state) => state.busy);
  const submitPassphrase = useBackupStore((state) => state.submitPassphrase);
  const reset = useBackupStore((state) => state.reset);

  const [passphrase, setPassphrase] = React.useState('');

  if (!pending) return null;

  return (
    <>
      <SheetHeader>
        <SheetTitle>This backup is encrypted</SheetTitle>
        <p className="mt-1 text-body text-muted">
          {pending.fileName} is protected by its own passphrase — it says nothing about the vault on this device.
        </p>
      </SheetHeader>

      <SheetBody className="px-5">
        <div className="flex flex-col gap-2 pb-2">
          <Input
            type="password"
            value={passphrase}
            autoFocus
            autoComplete="current-password"
            onChange={(event) => setPassphrase(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && passphrase.length > 0) void submitPassphrase(passphrase);
            }}
            placeholder="Backup passphrase"
            aria-label="Backup passphrase"
          />
          {pendingMessage ? <p className="text-meta leading-relaxed text-danger">{pendingMessage}</p> : null}
          <Notice tone="neutral">
            Nothing has been written yet. The file is only read once the passphrase opens it.
          </Notice>
        </div>
      </SheetBody>

      <SheetFooter>
        <div className="flex gap-2">
          <Button variant="quiet" className="flex-1" onClick={reset}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            disabled={busy || passphrase.length === 0}
            onClick={() => void submitPassphrase(passphrase)}
          >
            {busy ? <Loader2 size={18} className="animate-spin" aria-hidden /> : null}
            Open backup
          </Button>
        </div>
      </SheetFooter>
    </>
  );
}

function ReviewView() {
  const draft = useBackupStore((state) => state.draft);
  const plan = useBackupStore((state) => state.plan);
  const mode = useBackupStore((state) => state.mode);
  const busy = useBackupStore((state) => state.busy);
  const message = useBackupStore((state) => state.message);
  const setMode = useBackupStore((state) => state.setMode);
  const confirmImport = useBackupStore((state) => state.confirmImport);
  const reset = useBackupStore((state) => state.reset);

  const [acknowledged, setAcknowledged] = React.useState(false);

  if (!draft) return null;
  const report = draft.report;

  const replace = mode === 'replace';
  const ready = Boolean(plan) && !busy && (!replace || acknowledged);

  return (
    <>
      <SheetHeader>
        <SheetTitle>Restore from backup</SheetTitle>
        <p className="mt-1 flex items-center gap-1.5 text-meta text-muted">
          <FileJson size={13} strokeWidth={2} aria-hidden />
          {draft.fileName} · {formatBytes(draft.bytes)}
          {report.exportedAt ? ` · ${formatDate(report.exportedAt)}` : ''}
        </p>
      </SheetHeader>

      <SheetBody className="px-4">
        <div className="flex flex-col gap-3 pb-2">
          <div className="grid grid-cols-3 gap-2">
            <CountCell label="Folders" value={report.summary.folders} />
            <CountCell label="Links" value={report.summary.links} />
            <CountCell label="Notes" value={report.summary.notes} />
            <CountCell label="Tags" value={report.summary.tags} />
            <CountCell label="Favorites" value={report.summary.favorites} />
            <CountCell label="Locked" value={report.summary.sealedItems} />
          </div>

          {report.migratedFrom ? (
            <Notice tone="neutral">
              Written by an older version ({report.migratedFrom}) and read as a current backup, with the same
              checks applied.
            </Notice>
          ) : null}

          {report.warnings.map((warning) => (
            <Notice key={warning} tone="warn">
              {warning}
            </Notice>
          ))}

          {report.repairs.length > 0 ? (
            <div className="rounded-xl border border-hairline bg-surface-2 p-3">
              <p className="flex items-center gap-1.5 text-meta font-semibold text-fg">
                <Info size={13} strokeWidth={2.2} aria-hidden />
                Adjustments that will be made
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {report.repairs.map((repair) => (
                  <li key={repair} className="text-meta leading-relaxed text-muted">
                    {repair}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-meta leading-relaxed text-subtle">
                Nothing is deleted by these adjustments — a row that pointed outside the backup is made reachable.
              </p>
            </div>
          ) : null}

          {report.orphanedCiphertext ? (
            <Notice tone="warn">
              This backup has no key for its locked items, so those items will be restored locked and stay
              unreadable here. Nothing else about them is affected.
            </Notice>
          ) : null}

          {/* Mode -------------------------------------------------------- */}
          <div className="card">
            <ModeRow
              active={mode === 'merge'}
              onClick={() => void setMode('merge')}
              title="Add what is missing"
              description="Items already here are left untouched. Importing the same file twice changes nothing."
            />
            <ModeRow
              active={replace}
              onClick={() => void setMode('replace')}
              title="Replace everything"
              description="Clears this device and restores the backup exactly. A safety copy is taken first."
              last
            />
          </div>

          {plan ? (
            <div className="rounded-xl border border-hairline bg-surface-2 p-3">
              <p className="text-meta font-semibold text-fg">
                {replace ? 'This will replace your vault with' : 'This will add'}{' '}
                {planTotal(plan) === 0 ? 'nothing' : `${planTotal(plan)} item(s)`}
              </p>
              <ul className="mt-1.5 flex flex-col gap-0.5 text-meta text-muted">
                <li>{plan.counts.folders} folder(s), {plan.counts.links} link(s), {plan.counts.notes} note(s)</li>
                <li>{plan.counts.tags} tag(s), {plan.counts.linkTags + plan.counts.noteLinks} reference(s)</li>
              </ul>
              {plan.skipped.folders + plan.skipped.links + plan.skipped.notes + plan.skipped.tags > 0 ? (
                <p className="mt-1.5 text-meta leading-relaxed text-subtle">
                  {plan.skipped.folders + plan.skipped.links + plan.skipped.notes + plan.skipped.tags} item(s)
                  already exist here and are skipped rather than overwritten.
                </p>
              ) : null}
              {plan.messages.map((planMessage) => (
                <p key={planMessage} className="mt-1.5 text-meta leading-relaxed text-subtle">
                  {planMessage}
                </p>
              ))}
            </div>
          ) : null}

          {plan?.replacesKeyring ? (
            <Notice tone="danger">
              <span className="flex items-start gap-2">
                <ShieldAlert size={14} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden />
                This backup brings its own key, from a vault that still used a passcode. After restoring, this
                device&apos;s lock will no longer open the vault — the passcode from the device that wrote this file
                will. Unlock with it straight afterwards.
              </span>
            </Notice>
          ) : null}

          {plan?.keyring === 'adopt' && !plan.replacesKeyring ? (
            <Notice tone="neutral">
              The backup’s key will be installed, so its locked items open with the passcode from the device that
              wrote the file. Nothing writes a passcode any more, so this only happens for a backup taken by an
              older build.
            </Notice>
          ) : null}

          {replace ? (
            <div className="rounded-xl border border-danger/30 bg-danger-soft p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-meta font-medium text-fg">
                  Replace everything on this device
                </span>
                <Switch
                  checked={acknowledged}
                  onCheckedChange={setAcknowledged}
                  aria-label="Confirm replace"
                />
              </div>
              <p className="mt-1.5 text-meta leading-relaxed text-fg/80">
                A safety copy of your current data is written before anything is cleared, so this is reversible.
              </p>
            </div>
          ) : null}

          {message ? <Notice tone="danger">{message}</Notice> : null}
        </div>
      </SheetBody>

      <SheetFooter>
        <div className="flex gap-2">
          <Button variant="quiet" className="flex-1" onClick={reset} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={replace ? 'danger' : 'primary'}
            className="flex-1"
            disabled={!ready}
            onClick={() => void confirmImport()}
          >
            {busy ? <Loader2 size={18} className="animate-spin" aria-hidden /> : null}
            {replace ? 'Replace vault' : 'Add to vault'}
          </Button>
        </div>
      </SheetFooter>
    </>
  );
}

function DoneView({ onClose }: { onClose: () => void }) {
  const result = useBackupStore((state) => state.result);
  const message = useBackupStore((state) => state.message);
  const details = useBackupStore((state) => state.details);

  const failed = !result;

  return (
    <>
      <SheetHeader>
        <SheetTitle>{failed ? 'That file could not be restored' : 'Backup restored'}</SheetTitle>
      </SheetHeader>

      <SheetBody className="px-4">
        <div className="flex flex-col gap-3 pb-2">
          {failed ? (
            <>
              <Notice tone="danger">{message ?? 'The backup was refused.'}</Notice>
              {details.length > 0 ? (
                <div className="rounded-xl border border-hairline bg-surface-2 p-3">
                  <p className="text-meta font-semibold text-fg">What is wrong with it</p>
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {details.map((detail) => (
                      <li key={detail} className="text-meta leading-relaxed text-muted">
                        {detail}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <p className="px-1 text-meta leading-relaxed text-subtle">
                Your vault was not touched. Validation happens before anything is written, so a file that fails
                these checks leaves the database exactly as it was.
              </p>
            </>
          ) : (
            <>
              <p className="flex items-center gap-2 text-body text-fg">
                <CheckCircle2 size={18} strokeWidth={2} className="text-success" aria-hidden />
                {result.mode === 'replace' ? 'Replaced from the backup.' : 'Added from the backup.'}
              </p>
              <div className="grid grid-cols-3 gap-2">
                <CountCell label="Folders" value={result.folders} />
                <CountCell label="Links" value={result.links} />
                <CountCell label="Notes" value={result.notes} />
                <CountCell label="Tags" value={result.tags} />
                <CountCell label="Tag links" value={result.linkTags} />
                <CountCell label="Note refs" value={result.noteLinks} />
              </div>

              {result.keyringReplaced ? (
                <Notice tone="warn">
                  The backup’s key replaced the one on this device, so the vault has been locked. Unlock with the
                  passcode from the device that wrote this file — the only case in which Stash asks for one.
                </Notice>
              ) : null}

              {result.emergencyPath ? (
                <Notice tone="neutral">
                  Your previous data was copied first. If this was a mistake, that copy is at{' '}
                  <span className="font-mono text-label break-all">{result.emergencyPath}</span> and can be
                  restored the same way you restored this one.
                </Notice>
              ) : result.mode === 'replace' ? (
                <Notice tone="warn">
                  The safety copy could not be written to storage. It is still in memory for this session, so if
                  this was a mistake, restore your previous backup now rather than closing the app.
                </Notice>
              ) : null}
            </>
          )}
        </div>
      </SheetBody>

      <SheetFooter>
        <Button variant="surface" className="w-full" onClick={onClose}>
          Done
        </Button>
      </SheetFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Small presentational pieces, kept local because they are used nowhere else.
// ---------------------------------------------------------------------------

function ModeRow({
  active,
  onClick,
  title,
  description,
  last = false,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  description: string;
  last?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'tap flex w-full items-start gap-3 px-4 py-3 text-left',
        !last && 'border-b border-border',
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
        <span className={cn('block text-row font-medium', active ? 'text-accent' : 'text-fg')}>{title}</span>
        <span className="mt-0.5 block text-meta leading-relaxed text-muted">{description}</span>
      </span>
    </button>
  );
}

function CountCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-hairline bg-surface-2 px-3 py-2">
      <p className="text-title font-semibold text-fg">{value}</p>
      <p className="text-label text-subtle">{label}</p>
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: 'neutral' | 'warn' | 'danger';
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border p-3 text-meta leading-relaxed',
        tone === 'neutral' && 'border-border bg-surface-2 text-muted',
        tone === 'warn' && 'border-warning/40 bg-surface-2 text-fg/85',
        tone === 'danger' && 'border-danger/30 bg-danger-soft text-fg/85',
      )}
    >
      {children}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
