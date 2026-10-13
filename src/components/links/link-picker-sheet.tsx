'use client';

import * as React from 'react';
import { Check, Link2, Lock, Search } from '@/components/ui/icons';
import type { SavedLink } from '@/db/types';
import { displayUrl } from '@/lib/format';
import { normaliseLinkHref } from '@/lib/markdown';
import { lockRootOf } from '@/lib/privacy/protection';
import { folderPathLabel } from '@/lib/tree';
import { useBackDismiss } from '@/hooks/use-back-dismiss';
import { usePrivacyStore } from '@/stores/privacy-store';
import { useVaultStore } from '@/stores/vault-store';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { ConfirmAuth } from '@/components/privacy/confirm-auth';

/**
 * Pick a link to reference from a note — or write an address into it.
 *
 * Two things can be attached, and the difference matters:
 *
 *  1. a link that is already in the vault, which is *linked* (the note points at
 *     the one canonical record, so its title and folder stay in step); and
 *  2. an address that belongs to this note alone, which is only *written down* —
 *     nothing is saved, nothing is de-duplicated, and no folder is asked for.
 *
 * The second exists because the first cannot cover it: a URL mentioned once in one
 * note is not a thing to file. It is offered at the top of the sheet the moment
 * what has been typed *is* an address, so the intent is unambiguous — you get the
 * address row only while the search box holds one.
 *
 * ## Locked links
 *
 * A locked link's title and address are ciphertext, so this list cannot show them
 * or match them by name — that is the point of the lock, and a picker is not a
 * place to weaken it. What it *can* say is that they are there, which is what the
 * locked row does: one row, named "Locked", with the honest description of what
 * attaching one means. Tapping it asks for the same proof any locked item asks
 * for, opens the boundaries those links live in for this session, and — if exactly
 * one link then answers the search — attaches it, because that is plainly what the
 * user was asking for.
 */

export interface LinkPickerSheetProps {
  open: boolean;
  onClose: () => void;
  onPick: (link: SavedLink) => void;
  /**
   * Use an address that is not in the vault.
   *
   * Optional: without it the sheet is a pure vault listing again, which is what
   * callers that only ever attach saved links want.
   */
  onPickAddress?: (url: string) => void;
  /** Already attached, shown as selected and disabled. */
  attachedIds?: readonly string[];
  /** Links the session cannot read yet. The locked row is hidden when this is 0. */
  lockedCount?: number;
  title?: string;
}

const RESULT_LIMIT = 120;

export function LinkPickerSheet({
  open,
  onClose,
  onPick,
  onPickAddress,
  attachedIds,
  lockedCount = 0,
  title = 'Attach a link',
}: LinkPickerSheetProps) {
  const links = useVaultStore((state) => state.links);
  const folders = useVaultStore((state) => state.folders);
  const hidden = useVaultStore((state) => state.hidden);
  const protection = useVaultStore((state) => state.protection);
  const grantAll = usePrivacyStore((state) => state.grantAll);

  const [query, setQuery] = React.useState('');
  const [unlocking, setUnlocking] = React.useState(false);
  /**
   * Set once the boundaries are open: the next single match is the answer.
   *
   * A ref, not state, and deliberately: nothing about *this* render depends on it
   * — it is a note to the effect below that the links this sheet lists are about
   * to change. Turning it into state would re-render the sheet once to say
   * nothing, which is the render the lint rule about effects exists to prevent.
   */
  const attachWhenClear = React.useRef(false);

  const attached = React.useMemo(() => new Set(attachedIds ?? []), [attachedIds]);

  // The query is cleared on close rather than in an effect on open: resetting
  // state during the close handler keeps it off the render path entirely.
  const close = React.useCallback(() => {
    setQuery('');
    setUnlocking(false);
    attachWhenClear.current = false;
    onClose();
  }, [onClose]);
  useBackDismiss(open, close);

  const tokens = React.useMemo(
    () => query.toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );

  const address = React.useMemo(
    () => (onPickAddress ? normaliseLinkHref(query) : null),
    [onPickAddress, query],
  );

  const results = React.useMemo(() => {
    // A picker is a listing, and a listing never offers protected content. A link
    // the session cannot read is not something to attach: attaching it would put
    // a reference to private content inside an ordinary note. It is not hidden
    // from the *user* either — the locked row below says it exists.
    const active = links.filter((link) => !hidden.links.has(link.id));
    const filtered =
      tokens.length === 0
        ? active
        : active.filter((link) => {
            const haystack = `${link.title ?? ''} ${link.url} ${link.source ?? ''} ${link.userNote ?? ''}`.toLowerCase();
            return tokens.every((token) => haystack.includes(token));
          });
    return filtered.sort((a, b) => b.createdAt - a.createdAt).slice(0, RESULT_LIMIT);
  }, [links, tokens, hidden]);

  /*
   * The boundaries the unreadable links live in.
   *
   * Taken from the lock graph rather than guessed: each withheld link is asked
   * which lock covers it, so opening the row grants exactly the folders those
   * links are inside — not the whole vault. It is the same access opening each
   * folder in turn would produce, and it ends with the session like any other.
   */
  const lockedRoots = React.useMemo(() => {
    const roots = new Set<string>();
    for (const id of hidden.links) {
      const root = lockRootOf(protection, 'link', id);
      if (root) roots.add(root);
    }
    return [...roots];
  }, [hidden, protection]);

  // Once the boundaries are open the withheld links are readable, so the search
  // is re-run against real titles. Exactly one match means the user's query named
  // one link and the only reason it was not offered was the lock — so it is
  // attached, which is what they were asking for when they typed its name. More
  // than one match is a search, not a choice, so the list simply stays open.
  React.useEffect(() => {
    if (!attachWhenClear.current || results.length === 0) return;
    attachWhenClear.current = false;
    if (results.length === 1) onPick(results[0]!);
  }, [onPick, results]);

  return (
    <Sheet open={open} onOpenChange={(next) => !next && close()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <p className="mt-0.5 text-meta text-subtle">
            Links already in your vault, or an address you only want in this note.
          </p>
        </SheetHeader>

        <div className="px-3 pb-2">
          <div className="relative">
            <Search
              size={16}
              strokeWidth={2}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle"
              aria-hidden
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search your links, or paste an address"
              aria-label="Search your links or paste an address"
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
              className={cn(
                'h-11 w-full rounded-xl border border-border bg-surface-2 pr-3 pl-9 text-row text-fg',
                'placeholder:text-subtle focus:border-accent focus:bg-surface focus:outline-none',
              )}
            />
          </div>
        </div>

        <SheetBody>
          {address ? (
            <button
              type="button"
              onClick={() => {
                onPickAddress?.(address);
                close();
              }}
              className="tap flex w-full items-center gap-3 border-b border-hairline px-3 py-3 text-left active:bg-surface-2"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
                <Link2 size={17} strokeWidth={2} aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-row block truncate font-medium text-fg">{address}</span>
                <span className="text-meta mt-0.5 block text-subtle">
                  Not saved to your vault — inserted in this note only.
                </span>
              </span>
            </button>
          ) : null}

          {results.length === 0 ? (
            address ? null : (
              <div className="flex flex-col items-center gap-1.5 px-8 py-10 text-center">
                <Link2 size={20} strokeWidth={1.7} className="text-subtle" aria-hidden />
                <p className="text-body text-muted">
                  {links.length === 0 ? 'No saved links yet' : 'No link matches that'}
                </p>
                <p className="text-meta text-subtle">
                  Save it from another app first, or paste its address above to write it into this note.
                </p>
              </div>
            )
          ) : (
            <ul className="flex flex-col divide-y divide-hairline">
              {results.map((link) => {
                const isAttached = attached.has(link.id);
                return (
                  <li key={link.id}>
                    <button
                      type="button"
                      disabled={isAttached}
                      onClick={() => onPick(link)}
                      className={cn(
                        'tap flex w-full items-start px-3 py-3 text-left active:bg-surface-2',
                        isAttached && 'opacity-45',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        {/*
                          * The name gets the room it needs. It used to be one
                          * truncated line, which meant a link could be the only
                          * answer to a search and still be unreadable — matched by
                          * a word that was not on screen. Two lines, wrapping, and
                          * the matched words picked out.
                          */}
                        <span className="text-row block break-words font-medium text-fg">
                          <Highlighted text={link.title?.trim() || displayUrl(link.url, 64)} tokens={tokens} />
                        </span>
                        <span className="text-meta mt-0.5 block break-all text-subtle">
                          {folderPathLabel(folders, link.folderId)} · {displayUrl(link.url, 64)}
                        </span>
                      </span>
                      {isAttached ? (
                        <Check size={17} strokeWidth={2.4} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {lockedCount > 0 ? (
            <div className="border-t border-hairline">
              {unlocking ? (
                <div className="px-3 py-3">
                  <p className="flex items-center gap-2 text-row font-medium text-fg">
                    <Lock size={16} strokeWidth={2} className="shrink-0 text-accent" aria-hidden />
                    Locked links
                  </p>
                  <ConfirmAuth
                    reason="Open your locked links so one can be attached"
                    confirmLabel="Unlock links"
                    hint={
                      <>
                        Their names and addresses are encrypted, so they cannot be listed or searched until this
                        vault is opened.
                      </>
                    }
                    onAuthorized={() => {
                      grantAll(lockedRoots);
                      setUnlocking(false);
                      attachWhenClear.current = true;
                    }}
                    onCancel={() => setUnlocking(false)}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setUnlocking(true)}
                  className="tap flex w-full items-start gap-3 px-3 py-3 text-left active:bg-surface-2"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-subtle">
                    <Lock size={16} strokeWidth={1.9} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-row block font-medium text-fg">Locked</span>
                    <span className="text-meta mt-0.5 block leading-relaxed text-subtle">
                      {lockedCount === 1 ? '1 locked link' : `${lockedCount} locked links`} · Note: once the locked
                      link is attached, it can be accessed through the note without the lock.
                    </span>
                  </span>
                </button>
              )}
            </div>
          ) : null}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The typed words, picked out of the name.
 *
 * A search result that matches on a word it does not show is a result the user
 * has to take on faith. This is the smallest answer to that: the tokens that were
 * typed are emphasised where they appear, so "found it because of this word" is
 * visible rather than inferred.
 */
function Highlighted({ text, tokens }: { text: string; tokens: readonly string[] }) {
  if (tokens.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'ig');
  const parts = text.split(pattern);
  const lowered = tokens.map((token) => token.toLowerCase());
  return (
    <>
      {parts.map((part, index) =>
        lowered.includes(part.toLowerCase()) ? (
          <span key={`${part}-${index}`} className="text-accent">
            {part}
          </span>
        ) : (
          <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
