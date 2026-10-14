'use client';

import { create } from 'zustand';
import type { BackupData, BackupMode, StashBackup } from '@/lib/backup/format';
import { backupFileName } from '@/lib/backup/format';
import { decryptBackupPayload } from '@/lib/backup/envelope';
import { parseBackup, type ValidationReport } from '@/lib/backup/validate';
import { indexExisting, planImport, type ImportMode, type ImportPlan } from '@/lib/backup/merge';
import { applyImport, buildBackup, readVaultRaw } from '@/db/repos/backup';
import { pickBackupFile, saveBackupToDevice, stashEmergencyBackup } from '@/lib/backup/file-bridge';
import { hasKeyring } from '@/lib/privacy/keyring';
import { useVaultStore } from './vault-store';
import { usePrivacyStore } from './privacy-store';

/**
 * The backup flow, as a state machine.
 *
 * Deliberately one place rather than scattered across screens, because the
 * ordering *is* the safety property. A restore goes
 * file → parse → validate → decrypt → plan → confirm → apply, and no step may be
 * skipped or reordered: the database is only ever touched by the last one, and
 * only after the consequences of doing so have been computed and shown.
 *
 * The stages below are real states of the flow, which is why they live here and
 * not in component state — a dialog that lost its place because a re-render
 * moved it would be an awful thing to happen in the middle of a destructive
 * operation.
 */

export type BackupStage =
  | 'idle'
  /** Reading and validating a chosen file. */
  | 'reading'
  /** Validated, but the payload is encrypted: a passphrase is needed. */
  | 'passphrase'
  /** Fully validated and planned. Waiting for the user to commit. */
  | 'review'
  /** Writing to the database. */
  | 'applying'
  /** Finished, one way or the other. */
  | 'done';

export interface ImportDraft {
  fileName: string;
  bytes: number;
  backup: StashBackup;
  data: BackupData;
  report: ValidationReport;
}

/** A file held while its passphrase is being asked for. */
interface PendingEnvelope {
  fileName: string;
  bytes: number;
  backup: StashBackup;
  report: ValidationReport;
}

export interface ImportResultSummary {
  mode: ImportMode;
  folders: number;
  links: number;
  tags: number;
  notes: number;
  linkTags: number;
  noteLinks: number;
  /** Rows the file offered that were already here, and were merged into. */
  mergedFolders: number;
  mergedLinks: number;
  mergedNotes: number;
  mergedTags: number;
  /** Notes kept alongside a same-titled note here because the bodies differ. */
  ambiguousNotes: number;
  /** Where the pre-restore safety copy was stored, when one could be written. */
  emergencyPath: string | null;
  keyringReplaced: boolean;
}

export interface BackupState {
  stage: BackupStage;
  busy: boolean;
  draft: ImportDraft | null;
  pending: PendingEnvelope | null;
  mode: ImportMode;
  plan: ImportPlan | null;
  /** Failure or informational text for the current stage. */
  message: string | null;
  /** Specific problems behind a failed validation, for the "what is wrong" view. */
  details: string[];
  result: ImportResultSummary | null;
  /** Set after an export so the UI can say what was written. */
  exportName: string | null;
  exportPath: string | null;

  exportVault: (options: { mode: BackupMode; passphrase?: string }) => Promise<boolean>;
  beginImport: () => Promise<void>;
  submitPassphrase: (passphrase: string) => Promise<void>;
  setMode: (mode: ImportMode) => Promise<void>;
  confirmImport: () => Promise<boolean>;
  /** Return to idle. Never touches the database. */
  reset: () => void;
}

const EMPTY = {
  draft: null,
  pending: null,
  plan: null,
  message: null,
  details: [] as string[],
  result: null,
  exportName: null,
  exportPath: null,
};

export const useBackupStore = create<BackupState>((set, get) => {
  /**
   * Compute what a mode would do.
   *
   * The existing rows come from a *raw* read rather than the rendered snapshot,
   * and that matters: while the session is locked, a hidden item is absent from
   * the snapshot, so planning a merge against it would not notice that its id is
   * already taken. Collision detection has to be independent of what is
   * currently on screen, or a locked item could be silently overwritten by a
   * restore.
   */
  const buildPlan = async (data: BackupData, backup: StashBackup, mode: ImportMode): Promise<ImportPlan> => {
    const [snapshot, deviceHasKeyring] = await Promise.all([readVaultRaw(), hasKeyring()]);
    return planImport({
      data,
      existing: indexExisting(snapshot),
      mode,
      backupHasKeyring: Boolean(backup.security?.keyring),
      deviceHasKeyring,
    });
  };

  /** Move to the review stage and plan the import. */
  const settle = async (
    backup: StashBackup,
    data: BackupData,
    report: ValidationReport,
    fileName: string,
    bytes: number,
  ): Promise<void> => {
    set({ draft: { fileName, bytes, backup, data, report }, pending: null, stage: 'review', busy: true });
    const plan = await buildPlan(data, backup, get().mode);
    set({ plan, busy: false });
  };

  return {
    stage: 'idle',
    busy: false,
    ...EMPTY,
    mode: 'merge',

    exportVault: async ({ mode, passphrase }) => {
      set({ busy: true, message: null, details: [], exportName: null, exportPath: null });

      const built = await buildBackup({ mode, passphrase });
      if (!built.ok || !built.text || !built.fileName) {
        set({ busy: false, message: built.message ?? 'The backup could not be created.' });
        return false;
      }

      const saved = await saveBackupToDevice(built.text, built.fileName);
      set({
        busy: false,
        exportName: built.fileName,
        exportPath: saved.path ?? null,
        message: saved.ok ? null : (saved.message ?? null),
      });
      // A cancelled share sheet is not a failed export: the file was written to
      // the app's own storage either way, and saying otherwise would just be
      // confusing.
      return saved.ok || Boolean(saved.path);
    },

    beginImport: async () => {
      set({ stage: 'reading', busy: true, ...EMPTY });

      const picked = await pickBackupFile();
      if (!picked.ok) {
        set({
          stage: 'idle',
          busy: false,
          message: picked.cancelled ? null : (picked.message ?? 'That file could not be opened.'),
        });
        return;
      }

      const parsed = parseBackup(picked.text ?? '', { bytes: picked.bytes ?? 0 });
      if (parsed.kind === 'invalid') {
        set({ stage: 'done', busy: false, message: parsed.message, details: parsed.details });
        return;
      }

      if (parsed.kind === 'encrypted') {
        // Hold the envelope, not the file: a passphrase is all that is missing,
        // and re-asking for the file would be a poor way to treat a typo.
        set({
          stage: 'passphrase',
          busy: false,
          pending: {
            fileName: picked.name ?? 'backup.json',
            bytes: picked.bytes ?? 0,
            backup: parsed.backup,
            report: parsed.report,
          },
        });
        return;
      }

      await settle(parsed.backup, parsed.data, parsed.report, picked.name ?? 'backup.json', picked.bytes ?? 0);
    },

    submitPassphrase: async (passphrase) => {
      const pending = get().pending;
      if (!pending) return;
      set({ busy: true, message: null, details: [] });

      const opened = await decryptBackupPayload(pending.backup, passphrase);
      if (opened.kind === 'invalid') {
        // Stays in the passphrase stage on purpose, so a typo does not discard
        // the file the user just chose.
        set({ busy: false, message: opened.message, details: opened.details });
        return;
      }
      if (opened.kind !== 'ready') {
        set({ busy: false, message: 'That passphrase did not open this backup.' });
        return;
      }

      await settle(opened.backup, opened.data, opened.report, pending.fileName, pending.bytes);
    },

    setMode: async (mode) => {
      const draft = get().draft;
      set({ mode, plan: null });
      if (!draft) return;
      const plan = await buildPlan(draft.data, draft.backup, mode);
      set({ plan });
    },

    confirmImport: async () => {
      const { plan, draft } = get();
      if (!plan || !draft) return false;

      set({ stage: 'applying', busy: true, message: null, details: [] });

      const outcome = await applyImport(plan, { keyring: draft.backup.security?.keyring ?? null });

      if (!outcome.ok) {
        set({
          stage: 'review',
          busy: false,
          message:
            outcome.message ??
            'The restore could not be completed. Dexie rolled the change back, so your vault is exactly as it was.',
        });
        return false;
      }

      const emergencyPath = outcome.emergencyBackup
        ? await stashEmergencyBackup(outcome.emergencyBackup, `pre-restore-${backupFileName()}`)
        : null;

      // Reload the vault from the database rather than patching the store: a
      // replace may have changed everything, so every cached list is now suspect.
      await useVaultStore.getState().refresh();

      if (outcome.keyringReplaced || plan.keyring === 'adopt') {
        // The key in memory belonged to the vault that was just replaced.
        // Dropping it immediately is the only safe move: keeping it would show
        // rows it cannot open and offer an unlock that no longer works.
        await usePrivacyStore.getState().reload();
      }

      set({
        stage: 'done',
        busy: false,
        plan: null,
        message: null,
        result: {
          mode: plan.mode,
          ...outcome.written,
          mergedFolders: outcome.merged.folders,
          mergedLinks: outcome.merged.links,
          mergedNotes: outcome.merged.notes,
          mergedTags: outcome.merged.tags,
          // Read from the plan rather than from the outcome: nothing about the
          // merge outcome changes because a note was preserved beside another,
          // and the plan is where that decision was made.
          ambiguousNotes: plan.ambiguousNotes,
          emergencyPath,
          keyringReplaced: outcome.keyringReplaced,
        },
      });
      return true;
    },

    reset: () => set({ stage: 'idle', busy: false, ...EMPTY }),
  };
});
