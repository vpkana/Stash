'use client';

import * as React from 'react';
import { ArrowLeft, Check, CornerDownRight, FolderPlus, Plus } from '@/components/ui/icons';
import type { Folder } from '@/db/types';
import { folderPathLabel } from '@/lib/tree';
import { useVaultStore } from '@/stores/vault-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { FOLDER_ICON_CHOICES, Icon } from '@/components/ui/icon';
import { INBOX_DESTINATION, folderDestination, type DestinationSelection } from '@/lib/destination';
import { FolderDestinationList } from './folder-destination-list';

/**
 * Folder creation inside the Save Sheet.
 *
 * Creating a destination must never cost the user their place in the capture
 * flow -- no navigating to Settings and back, no losing the link they were
 * saving. Name, optional icon, optional parent, done: the new folder is
 * selected as the destination the moment it exists.
 */

export interface CreateFolderInlineProps {
  folders: readonly Folder[];
  /** Parent preselected from the current destination. */
  defaultParentId: string | null;
  onCancel: () => void;
  onCreated: (folder: Folder) => void;
}

export function CreateFolderInline({ folders, defaultParentId, onCancel, onCreated }: CreateFolderInlineProps) {
  const createFolder = useVaultStore((state) => state.createFolder);
  const [name, setName] = React.useState('');
  const [icon, setIcon] = React.useState<string>('folder');
  const [parentId, setParentId] = React.useState<string | null>(defaultParentId);
  const [choosingParent, setChoosingParent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [duplicateFolder, setDuplicateFolder] = React.useState<Folder | null>(null);
  const [busy, setBusy] = React.useState(false);

  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (choosingParent) return;
    // Focus after the parent picker closes too, so the flow continues naturally.
    const timer = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => window.clearTimeout(timer);
  }, [choosingParent]);

  const parentLabel = parentId ? folderPathLabel(folders, parentId) : 'Top level';

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('Give the folder a name.');
      return;
    }
    setBusy(true);
    setError(null);
    setDuplicateFolder(null);
    const result = await createFolder({ name: trimmed, parentId, icon });
    setBusy(false);

    if (result.ok) {
      onCreated(result.folder);
      return;
    }
    if (result.reason === 'duplicate') {
      setDuplicateFolder(result.existing);
      setError(`“${result.existing.name}” already exists here.`);
      return;
    }
    setError(result.message);
  };

  if (choosingParent) {
    const selection: DestinationSelection = parentId ? folderDestination(parentId) : INBOX_DESTINATION;
    return (
      <div className="flex flex-col">
        <div className="flex items-center gap-2 px-3 pb-1">
          <button
            type="button"
            onClick={() => setChoosingParent(false)}
            className="tap flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-body font-medium text-accent active:bg-accent-soft"
          >
            <ArrowLeft size={16} strokeWidth={2.1} aria-hidden />
            Back
          </button>
          <p className="text-body text-muted">Choose a parent folder</p>
        </div>
        <FolderDestinationList
          folders={folders}
          selection={selection}
          onSelect={(next) => {
            setParentId(next.kind === 'folder' ? next.folderId : null);
            setChoosingParent(false);
          }}
          showInbox
          filterPlaceholder="Find a parent folder"
          className="px-1"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-3 pt-1">
      <div className="flex items-center gap-2">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Icon name={icon} size={18} strokeWidth={1.9} />
        </span>
        <Input
          ref={inputRef}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
            setDuplicateFolder(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="Folder name"
          aria-label="New folder name"
          enterKeyHint="done"
          autoComplete="off"
          maxLength={80}
        />
      </div>

      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 no-scrollbar" role="radiogroup" aria-label="Folder icon">
        {FOLDER_ICON_CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={icon === choice}
            aria-label={choice}
            onClick={() => setIcon(choice)}
            className={cn(
              'tap flex size-9 shrink-0 items-center justify-center rounded-xl border',
              icon === choice
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-border bg-surface-2 text-subtle',
            )}
          >
            <Icon name={choice} size={16} strokeWidth={1.9} />
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setChoosingParent(true)}
        className="tap flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-left active:bg-surface-3"
      >
        <CornerDownRight size={16} strokeWidth={1.9} className="shrink-0 text-subtle" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-meta text-subtle">Inside</span>
          <span className="block truncate text-row font-medium text-fg">{parentLabel}</span>
        </span>
        <span className="shrink-0 text-meta font-medium text-accent">Change</span>
      </button>

      {error ? (
        <div className="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2">
          <p className="min-w-0 flex-1 text-meta leading-snug text-danger">{error}</p>
          {duplicateFolder ? (
            <button
              type="button"
              onClick={() => onCreated(duplicateFolder)}
              className="tap shrink-0 rounded-lg px-2 py-1 text-meta font-semibold text-danger active:opacity-80"
            >
              Use it
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-2 pb-1">
        <Button variant="ghost" onClick={onCancel} className="flex-1">
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void submit()} disabled={busy} className="flex-[1.6]">
          {busy ? <Check size={18} strokeWidth={2.4} aria-hidden /> : <Plus size={18} strokeWidth={2.4} aria-hidden />}
          Create &amp; select
        </Button>
      </div>

      <p className="flex items-center gap-1.5 pb-1 text-meta text-subtle">
        <FolderPlus size={13} strokeWidth={2} aria-hidden />
        The link saves into this folder right away.
      </p>
    </div>
  );
}
