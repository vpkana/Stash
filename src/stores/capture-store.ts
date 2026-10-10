'use client';

import { create } from 'zustand';
import type { SavedLink } from '@/db/types';
import type { DuplicateMatch } from '@/db/repos/links';
import { domainOf } from '@/lib/url/extract';
import { isHttpUrl } from '@/lib/url/normalize';
import {
  INBOX_DESTINATION,
  destinationFolderId,
  destinationIsFavorite,
  folderDestination,
  type DestinationSelection,
} from '@/lib/destination';
import { parseShareToDraft } from '@/lib/share/parse';
import { labelForDomain, type IncomingShare } from '@/lib/share/types';
import { canAccessFolder, requireFolderAccess } from '@/lib/privacy/access';
import { useVaultStore } from './vault-store';

/**
 * The capture flow.
 *
 * This is the app's most important interaction, so it is modelled as an
 * explicit state machine rather than a pile of local component state:
 *
 *   idle -> open -> (duplicate resolution) -> saving -> done
 *
 * Two entry points arrive here: a share from another Android app (already
 * normalized by the native bridge) and a manual add. Both converge on the same
 * draft, so the sheet never needs to know where the link came from.
 */

export type CaptureMode = 'share' | 'manual';
export type CaptureStatus = 'idle' | 'open' | 'saving';

export interface CaptureDraft {
  url: string;
  title: string;
  note: string;
  /** Verbatim shared text, kept for provenance and shown as context. */
  rawText: string;
  domain: string;
  sourceLabel?: string;
  sourcePackage?: string;
  appLabel?: string;
  /** Other links found in the same shared text. */
  otherUrls: string[];
  receivedAt: number;
}

export type SaveFailureReason = 'invalid-url' | 'duplicate' | 'unavailable' | 'locked';

export interface SaveOutcome {
  ok: boolean;
  reason?: SaveFailureReason;
  link?: SavedLink;
  savedCount?: number;
}

interface CaptureState {
  status: CaptureStatus;
  mode: CaptureMode;
  draft: CaptureDraft | null;
  /** Populated when a share arrived that contained no usable link. */
  unreadable: IncomingShare | null;

  destination: DestinationSelection;
  /**
   * True when the destination was inferred from where the user already was —
   * inside a folder, or on the Inbox — rather than guessed from history or
   * chosen by hand.
   *
   * It changes nothing about where the link goes; it changes what the sheet
   * *asks*. A destination the user arrived with is a fact to state, and the full
   * destination tree underneath it is a question they already answered by walking
   * into the folder they were standing in.
   */
  destinationFromContext: boolean;
  /**
   * Whether the full destination tree is on screen.
   *
   * Starts open for a capture with no context (a share from another app has to
   * be filed by hand once) and closed when the destination is already known, with
   * one tap to open it for anyone who wants to file it somewhere else after all.
   */
  showDestinationPicker: boolean;
  /** True once the user chose to save despite an existing copy. */
  duplicateAcknowledged: boolean;
  duplicates: DuplicateMatch[];
  duplicateCheckDone: boolean;

  saveOtherUrls: boolean;
  showCreateFolder: boolean;

  openFromShare: (share: IncomingShare) => Promise<void>;
  /**
   * Open a manual capture, optionally already knowing where it is going.
   *
   * `selection` is the caller telling the store "the user is standing here". The
   * shell passes the folder the user is browsing, which is the whole fix for the
   * redundant destination step: saving from inside `Developer` files into
   * `Developer` without a question.
   *
   * Omitting it means "no context" — a capture started from Home, Search or the
   * Inbox — and then the remembered destination is used and the picker stays on
   * screen, because a guess is worth confirming and a fact is not.
   */
  openManual: (selection?: DestinationSelection) => void;
  setShowDestinationPicker: (value: boolean) => void;
  setDraftField: (field: 'url' | 'title' | 'note', value: string) => void;
  setSaveOtherUrls: (value: boolean) => void;
  selectDestination: (selection: DestinationSelection) => void;
  /** Selects a destination, asking for access first when it is protected. */
  chooseDestination: (selection: DestinationSelection) => Promise<boolean>;
  setShowCreateFolder: (value: boolean) => void;
  recheckDuplicates: () => Promise<void>;
  acknowledgeDuplicate: () => void;
  save: () => Promise<SaveOutcome>;
  /**
   * The fastest path there is: file nothing, decide nothing, be done.
   *
   * Sets the destination and saves in the same call so the whole thing is one
   * tap. A hurried capture must not be able to land anywhere except the Inbox,
   * whatever the sheet happened to be showing when the button was pressed.
   */
  saveToInbox: () => Promise<SaveOutcome>;
  moveExisting: (linkId: string) => Promise<SaveOutcome>;
  reset: () => void;
}

function emptyDraft(): CaptureDraft {
  return {
    url: '',
    title: '',
    note: '',
    rawText: '',
    domain: '',
    otherUrls: [],
    receivedAt: Date.now(),
  };
}

export const useCaptureStore = create<CaptureState>((set, get) => ({
  status: 'idle',
  mode: 'share',
  draft: null,
  unreadable: null,
  destination: INBOX_DESTINATION,
  destinationFromContext: false,
  showDestinationPicker: true,
  duplicateAcknowledged: false,
  duplicates: [],
  duplicateCheckDone: false,
  saveOtherUrls: false,
  showCreateFolder: false,

  openFromShare: async (share) => {
    const parsed = parseShareToDraft(share);

    if (!parsed.draft) {
      // No URL anywhere in the payload. Do not invent a link: say so plainly and
      // write nothing to the vault.
      set({
        status: 'open',
        mode: 'share',
        draft: null,
        unreadable: parsed.share,
        duplicates: [],
        duplicateCheckDone: true,
        showCreateFolder: false,
      });
      return;
    }

    /*
     * The note is pre-filled from whatever the source app already told us.
     *
     * A share usually arrives with a title (YouTube sends the video name, Chrome
     * the page title), and asking the user to retype it would be busywork. It
     * lands in the *note* rather than staying only in `title` because the note is
     * the field the user owns: it is pre-filled for them, editable by them, and
     * never rewritten afterwards. `title` is kept alongside as provenance — what
     * the source claimed — so the two never have to be conflated.
     */
    const draft: CaptureDraft = {
      url: parsed.draft.url,
      title: parsed.draft.title ?? '',
      note: parsed.draft.note ?? parsed.draft.title ?? '',
      rawText: parsed.share.rawText,
      domain: parsed.draft.domain,
      otherUrls: parsed.draft.otherUrls,
      receivedAt: parsed.draft.receivedAt,
    };
    if (parsed.draft.sourceLabel) draft.sourceLabel = parsed.draft.sourceLabel;
    if (parsed.draft.sourcePackage) draft.sourcePackage = parsed.draft.sourcePackage;
    if (parsed.draft.appLabel) draft.appLabel = parsed.draft.appLabel;

    set({
      status: 'open',
      mode: 'share',
      unreadable: null,
      draft,
      destination: defaultDestination(),
      // A share arrives from another app with no context inside Stash, so the
      // destination is the one thing the sheet legitimately has to ask about.
      destinationFromContext: false,
      showDestinationPicker: true,
      duplicateAcknowledged: false,
      duplicates: [],
      duplicateCheckDone: false,
      saveOtherUrls: false,
      showCreateFolder: false,
    });

    await get().recheckDuplicates();
  },

  openManual: (selection) => {
    /*
     * Where the user is standing wins over where they filed things last.
     *
     * A capture started from inside `Developer` is a capture that belongs in
     * `Developer`, and a capture started on the Inbox belongs in the Inbox: asking
     * in either case is the step this removes. Only a capture with no context at
     * all keeps the remembered destination *and* the picker — a guess is worth
     * confirming once, in one place, when the app genuinely does not know.
     */
    const contextual = selection ?? null;
    set({
      status: 'open',
      mode: 'manual',
      draft: emptyDraft(),
      unreadable: null,
      destination: contextual ?? defaultDestination(),
      destinationFromContext: contextual !== null,
      showDestinationPicker: contextual === null,
      duplicateAcknowledged: false,
      duplicates: [],
      duplicateCheckDone: false,
      saveOtherUrls: false,
      showCreateFolder: false,
    });
  },

  setDraftField: (field, value) => {
    const draft = get().draft;
    if (!draft) return;
    const next: CaptureDraft = { ...draft, [field]: value };
    if (field === 'url') {
      next.domain = domainOf(value);
      const label = labelForDomain(next.domain);
      if (label) next.sourceLabel = label;
      else delete next.sourceLabel;
      // The URL changed, so any previous duplicate verdict is stale. Clearing it
      // here prevents acting on a result that no longer matches what is shown.
      set({ draft: next, duplicateCheckDone: false, duplicates: [], duplicateAcknowledged: false });
      return;
    }
    set({ draft: next });
  },

  setSaveOtherUrls: (value) => set({ saveOtherUrls: value }),

  selectDestination: (selection) =>
    set({ destination: selection, showCreateFolder: false, showDestinationPicker: false }),

  setShowDestinationPicker: (value) => set({ showDestinationPicker: value }),

  /**
   * Choose a destination, crossing a lock boundary only if the choice needs it.
   *
   * This is the one place a share can raise the system prompt, and it does so for
   * exactly one reason: the user picked a protected folder. Choosing the Inbox, an
   * ordinary folder, or creating a new one never asks for anything.
   */
  chooseDestination: async (selection) => {
    if (selection.kind === 'folder' && selection.folderId) {
      if (!(await requireFolderAccess(selection.folderId))) return false;
    }
    set({ destination: selection, showCreateFolder: false, showDestinationPicker: false });
    return true;
  },

  setShowCreateFolder: (value) => set({ showCreateFolder: value }),

  recheckDuplicates: async () => {
    const draft = get().draft;
    if (!draft || !isHttpUrl(draft.url)) {
      set({ duplicates: [], duplicateCheckDone: true });
      return;
    }
    const duplicates = await useVaultStore.getState().duplicatesFor(draft.url);
    set({ duplicates, duplicateCheckDone: true });
  },

  acknowledgeDuplicate: () => set({ duplicateAcknowledged: true }),

  save: async () => {
    const { draft, destination, saveOtherUrls, duplicateAcknowledged } = get();
    if (!draft) return { ok: false, reason: 'unavailable' };

    const url = draft.url.trim();
    if (!isHttpUrl(url)) return { ok: false, reason: 'invalid-url' };

    set({ status: 'saving' });

    // Re-check at write time: the vault may have changed since the sheet opened.
    const duplicates = await useVaultStore.getState().duplicatesFor(url);
    if (duplicates.length > 0 && !duplicateAcknowledged) {
      set({ status: 'open', duplicates, duplicateCheckDone: true });
      return { ok: false, reason: 'duplicate' };
    }

    const folderId = destinationFolderId(destination);
    const isFavorite = destinationIsFavorite(destination);

    // Write-time authorization, not just a picker guard.
    //
    // The destination could have been chosen before the folder was locked, or
    // restored from a recent-destinations list that predates the lock. Filing a
    // link into a folder the session cannot read would be a silent bypass of the
    // boundary — and because a link saved there is immediately sealed, it would
    // also hand the user a link they could not find again.
    if (folderId && !canAccessFolder(folderId)) {
      const granted = await requireFolderAccess(folderId);
      if (!granted) {
        set({ status: 'open' });
        return { ok: false, reason: 'locked' };
      }
    }

    const vault = useVaultStore.getState();
    const link = await vault.saveLink({
      url,
      folderId,
      isFavorite,
      ...(draft.title ? { title: draft.title } : {}),
      ...(draft.note ? { userNote: draft.note } : {}),
      ...(draft.rawText ? { rawText: draft.rawText } : {}),
      source: draft.domain || domainOf(url),
      ...(draft.sourcePackage ? { sourcePackage: draft.sourcePackage } : {}),
    });

    // Secondary links are best-effort: an already-known extra must never turn a
    // successful primary save into a failure.
    let savedCount = 1;
    const extras = saveOtherUrls ? draft.otherUrls : [];
    for (const extra of extras) {
      const extraDuplicates = await useVaultStore.getState().duplicatesFor(extra);
      if (extraDuplicates.length > 0) continue;
      await vault.saveLink({
        url: extra,
        folderId,
        source: domainOf(extra),
        ...(draft.rawText ? { rawText: draft.rawText } : {}),
      });
      savedCount += 1;
    }

    set({
      status: 'idle',
      draft: null,
      duplicates: [],
      duplicateCheckDone: false,
      saveOtherUrls: false,
      showCreateFolder: false,
    });
    return { ok: true, link, savedCount };
  },

  saveToInbox: async () => {
    set({ destination: INBOX_DESTINATION, showCreateFolder: false });
    return get().save();
  },

  moveExisting: async (linkId) => {
    const { destination } = get();
    const folderId = destinationFolderId(destination);
    if (folderId && !canAccessFolder(folderId)) {
      const granted = await requireFolderAccess(folderId);
      if (!granted) {
        set({ status: 'open' });
        return { ok: false, reason: 'locked' };
      }
    }
    await useVaultStore.getState().moveLink(linkId, folderId);
    if (destinationIsFavorite(destination)) {
      await useVaultStore.getState().toggleLinkFavorite(linkId, true);
    }
    set({ status: 'idle', draft: null, duplicates: [], duplicateCheckDone: false, showCreateFolder: false });
    return { ok: true };
  },

  reset: () =>
    set({
      status: 'idle',
      draft: null,
      unreadable: null,
      duplicates: [],
      duplicateCheckDone: false,
      showCreateFolder: false,
      showDestinationPicker: true,
      destinationFromContext: false,
      duplicateAcknowledged: false,
      saveOtherUrls: false,
    }),
}));

/**
 * Where a fresh capture should land.
 *
 * Recent destinations win because repeat captures ("that goes in Development
 * again") are the common case; otherwise Inbox, so saving never begins with a
 * decision the user did not ask to make.
 */
function defaultDestination(): DestinationSelection {
  const { folders, recentFolderIds } = useVaultStore.getState();
  const known = new Set(folders.map((folder) => folder.id));
  // A protected folder is skipped rather than pre-selected. Preselecting one
  // would put a lock prompt in front of a share the user never asked to unlock
  // anything for, and a share must never be the reason a password is requested.
  const recent = recentFolderIds.find((id) => known.has(id) && canAccessFolder(id));
  return recent ? folderDestination(recent) : INBOX_DESTINATION;
}

