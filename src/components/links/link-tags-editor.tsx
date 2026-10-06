'use client';

import * as React from 'react';
import { Check, Plus, Tag as TagIcon, X } from '@/components/ui/icons';
import { normalizeTagName } from '@/db/repos/tags';
import { useVaultStore, selectTagUsage, selectTagsForLink } from '@/stores/vault-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Tags on one link.
 *
 * Free-form on purpose. There is no tag manager to keep tidy, no colour to
 * assign and no hierarchy: a tag exists as soon as someone types it and
 * disappears when nothing carries it any more, which is what keeps the feature
 * from becoming a second filing system competing with folders.
 *
 * The suggestions are the tags already in use, ordered by how many links carry
 * them, so the tenth time you tag something "programming" you tap it instead of
 * spelling it again. That ordering is also the entire editing experience: no
 * renaming, no merging, no deleting from here.
 */
export function LinkTagsEditor({ linkId }: { linkId: string }) {
  const current = useVaultStore((state) => selectTagsForLink(state, linkId));
  const usage = useVaultStore((state) => selectTagUsage(state));

  // Draft state so the chips respond to a tap immediately and the write happens
  // once, on Save, rather than on every character typed.
  const [draft, setDraft] = React.useState<string[]>(current);
  const [entry, setEntry] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const dirty = React.useMemo(() => {
    if (draft.length !== current.length) return true;
    const sorted = [...draft].sort();
    return sorted.some((name, index) => name !== [...current].sort()[index]);
  }, [draft, current]);

  const suggestions = usage.filter((tag) => !draft.includes(tag.name)).slice(0, 8);

  const add = (raw: string) => {
    const name = normalizeTagName(raw);
    if (name.length === 0) return;
    setEntry('');
    setDraft((previous) => (previous.includes(name) ? previous : [...previous, name]));
  };

  const save = async () => {
    setBusy(true);
    await useVaultStore.getState().setTags(linkId, draft);
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2 px-3.5 py-3">
      <p className="flex items-center gap-1.5 text-label font-medium text-subtle">
        <TagIcon size={12} strokeWidth={2.2} aria-hidden />
        Tags
      </p>

      {draft.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {draft.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pr-1 pl-2 text-meta font-medium text-accent"
            >
              {name}
              <button
                type="button"
                onClick={() => setDraft((previous) => previous.filter((tag) => tag !== name))}
                aria-label={`Remove tag ${name}`}
                className="tap flex size-5 items-center justify-center rounded-full active:bg-accent/15"
              >
                <X size={12} strokeWidth={2.6} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-meta text-muted">No tags yet.</p>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={entry}
          onChange={(event) => setEntry(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            add(entry);
          }}
          placeholder="Add a tag"
          aria-label="Add a tag"
          autoComplete="off"
          autoCapitalize="none"
          enterKeyHint="done"
          maxLength={40}
          className="bg-surface"
        />
        <Button
          variant="surface"
          size="icon"
          aria-label="Add tag"
          disabled={entry.trim().length === 0}
          onClick={() => add(entry)}
        >
          <Plus size={18} strokeWidth={2.2} aria-hidden />
        </Button>
      </div>

      {suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((tag) => (
            <button
              key={tag.name}
              type="button"
              onClick={() => add(tag.name)}
              className={cn(
                'tap rounded-full border border-border bg-surface px-2.5 py-1 text-meta text-muted',
                'active:bg-surface-3',
              )}
            >
              {tag.name}
              <span className="ml-1 text-label text-subtle">{tag.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {dirty ? (
        <Button variant="accentSoft" size="sm" onClick={() => void save()} disabled={busy}>
          <Check size={16} strokeWidth={2.4} aria-hidden />
          Save tags
        </Button>
      ) : null}
    </div>
  );
}

/**
 * A link's tags, as read-only chips.
 *
 * Used by list rows. Renders nothing when there are no tags, so an untagged
 * vault looks exactly as it did before tags existed.
 */
export function LinkTagChips({ names, className }: { names: readonly string[]; className?: string }) {
  if (names.length === 0) return null;
  return (
    <span className={cn('flex flex-wrap items-center gap-1', className)}>
      {names.map((name) => (
        <span
          key={name}
          className="rounded-md bg-surface-2 px-1.5 py-0.5 text-label font-medium text-muted"
        >
          {name}
        </span>
      ))}
    </span>
  );
}
