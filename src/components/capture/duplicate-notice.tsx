'use client';

import * as React from 'react';
import { ExternalLink, FolderInput, Plus } from '@/components/ui/icons';
import type { DuplicateMatch } from '@/db/repos/links';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Already-saved notice.
 *
 * Shown inline in the Save Sheet rather than as a blocking modal, because the
 * decision ("I meant a different copy" vs "send me to the original") is part of
 * saving, not an interruption of it. All four resolutions are offered: open the
 * existing copy, save another, move the existing one here, or back out.
 */

export interface DuplicateNoticeProps {
  matches: readonly DuplicateMatch[];
  onOpenExisting: (match: DuplicateMatch) => void;
  onSaveCopy: () => void;
  onMoveExisting: (match: DuplicateMatch) => void;
  onCancel: () => void;
  busy?: boolean;
  className?: string;
}

export function DuplicateNotice({
  matches,
  onOpenExisting,
  onSaveCopy,
  onMoveExisting,
  onCancel,
  busy = false,
  className,
}: DuplicateNoticeProps) {
  const primary = matches[0];
  if (!primary) return null;
  const extra = matches.length - 1;

  return (
    <div className={cn('rounded-xl border border-border bg-surface-2 p-3', className)}>
      <div className="flex items-start gap-2.5">
        <span
          className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-warning/20 text-warning"
          aria-hidden
        >
          <span className="text-meta font-bold">!</span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-row font-semibold text-fg">Already saved</p>
          <p className="mt-0.5 text-body leading-snug text-muted">
            in <span className="font-medium text-fg">{primary.folderPath}</span>
            <span className="text-subtle"> · {formatRelative(primary.link.createdAt)}</span>
          </p>
          {primary.link.title ? (
            <p className="mt-1 line-clamp-2 text-meta text-muted">{primary.link.title}</p>
          ) : null}
          {extra > 0 ? (
            <p className="mt-1 text-meta text-subtle">and {extra} more copies</p>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <NoticeAction
          icon={<ExternalLink size={15} strokeWidth={2} aria-hidden />}
          label="Open existing"
          onClick={() => onOpenExisting(primary)}
          disabled={busy}
          primary
        />
        <NoticeAction
          icon={<FolderInput size={15} strokeWidth={2} aria-hidden />}
          label="Move here"
          onClick={() => onMoveExisting(primary)}
          disabled={busy}
        />
        <NoticeAction
          icon={<Plus size={15} strokeWidth={2} aria-hidden />}
          label="Save another"
          onClick={onSaveCopy}
          disabled={busy}
        />
        <NoticeAction label="Cancel" onClick={onCancel} disabled={busy} />
      </div>
    </div>
  );
}

function NoticeAction({
  icon,
  label,
  onClick,
  disabled,
  primary = false,
}: {
  icon?: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'tap tap-scale flex h-10 items-center justify-center gap-1.5 rounded-lg px-2 text-meta font-medium',
        primary ? 'bg-accent text-accent-fg' : 'border border-border bg-surface text-fg active:bg-surface-3',
        'disabled:opacity-50',
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}
