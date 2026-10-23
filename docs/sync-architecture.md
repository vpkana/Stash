# Stash sync architecture

Status: implemented in this repository. The only missing piece for a live run is
your own Google Cloud OAuth client; see [google-drive-setup.md](./google-drive-setup.md).

## Scope

Stash syncs the vault through Google Drive's **hidden application data folder**
(`appDataFolder`) with the narrow `drive.appdata` scope. There is no server, no
account system of Stash's own, and no upload of anything the user did not ask to
sync. The local IndexedDB vault stays authoritative; Drive is a transport, never a
remote source of truth that replaces the local database.

What is synced:

| Entity | Stable identity | Relationship |
| --- | --- | --- |
| Folder | `folder.id` | `parentId`, `sortOrder`, favourite, lock flag, `enc` |
| Saved link | `link.id` | `folderId`, order, flags, all metadata, `enc` |
| Note | `note.id` | `parentNoteId`, order, flags, Markdown body, `enc` |
| Tag | `tag.id` | — |
| Link ↔ tag | `[linkId, tagId]` | a row in `linkTags` |
| Note ↔ link | `[noteId, linkId]` | a row in `noteLinks`, including `origin` |
| Trash | row state | `deletedAt` / `trashBatch` travel with a row |
| Hard deletion | tombstone | base row with no live counterpart |

What is intentionally **not** synced:

- `meta` preferences (theme, accent, recents, last destination, open note). They
  are device/UI state, not vault content.
- The `security` table: device wrapping keys, the WebAuthn credential id, and any
  other device secret. Never uploaded.
- Raw OAuth tokens. Web keeps an access token in memory only; Android stores the
  refresh state in `EncryptedSharedPreferences` behind a native plugin, never in
  IndexedDB, logs, or the JS store.
- Binary attachments. This build of Stash has no attachment table, no image
  embedding, and the Android share receiver accepts text only. `noteLinks` is the
  only "attachment" concept and it is a reference, not a blob. The protocol
  reserves no silent placeholder for binaries; adding them requires a new entity
  and a resumable-upload path, which is out of scope here.

## Storage layout in `appDataFolder`

```
stash-sync-v1-device-<deviceId>.json     per-device manifest (small, mutable)
stash-sync-v1-chunk-<deviceId>-<seq>-<hash>.json   immutable change chunks
stash-sync-v1-keyring-<fingerprint>.json recovery wraps, ciphertext only
```

A device writes **only its own manifest**. It appends immutable chunks and then
rewrites that small manifest. There is no shared manifest, so two devices never
need a multi-file transaction, compare-and-swap, or Drive ETag to avoid clobbering
each other. The manifest write is the commit point for that device's chunk(s).

`DeviceManifest`:

```json
{
  "protocol": "stash-sync",
  "protocolVersion": 1,
  "schemaVersion": 7,
  "deviceId": "…",
  "deviceName": "Android app · a1b2c3",
  "revision": 4,
  "updatedAt": 1760000000000,
  "chunks": [
    {
      "fileId": "1AbC…",
      "name": "stash-sync-v1-chunk-…json",
      "hash": "sha256 hex",
      "seq": 3,
      "revision": 4,
      "entries": 12,
      "createdAt": 1760000000000
    }
  ]
}
```

A chunk contains full current rows (not deltas), a revision stamp, and tombstones
for rows that were hard-deleted. Chunks are split at ~1.5 MB or 500 entries. The
protocol therefore does **not** upload the whole database on each change; only the
entities whose content differs from what is already known to be on Drive.

## Revisions and checkpoints

- Every entity on the wire has an opaque `rev` string. Locally it is derived from
  the row's `updatedAt` (or `createdAt` for relations), a prefix of the content
  hash, and the origin device id: `${updatedAt}-${hashPrefix}-${deviceId}`. It is
  deterministic for the same content, so a retried upload does not change it.
- The ordering is deliberately not "wall clock alone": the content hash and device
  id break ties. Clock skew can change which side is the deterministic winner of a
  non-note field conflict, but it can never silently discard the losing value —
  losing note content becomes a conflict copy, and losing non-note fields are kept
  in the local conflict record for review.
- Each device keeps `syncBase`: the last state it knows to be both local and on the
  remote log, including tombstones. This is the common ancestor for three-way
  merge, and the source of "pending changes" (current vs base).
- Each device keeps a `syncPeers` checkpoint: peer device id → last manifest
  revision consumed. Only chunks above the checkpoint are downloaded.
- A manifest's own revision is stored in the same peer map under this device's id,
  which is how a crash after manifest write (but before local commit) is recovered:
  the next run re-reads its own chunk and applies it idempotently.

## Sync sequence

1. **Acquire** the local sync lock (module promise + Web Locks where available +
   a short database lease). One sync per device at a time; a second tab waits or
   skips.
2. **Read local**: all vault rows, plus base and peer checkpoints.
3. **Discover remote**: list manifests, validate versions and shapes, pick this
   device's manifest, download unseen chunks, verify SHA-256 and row hashes.
4. **Merge in memory** with the pure three-way engine. No database write, no UI
   mutation.
5. **Plan outgoing**: compare the merged result against the remote baseline (base
   overridden by the new remote entries). Only differences are uploaded. Echoes of
   remote changes are not re-uploaded.
6. **Upload** immutable chunk(s), then rewrite this device's manifest. That is the
   remote durable commit. If the process dies after this point, the next run pulls
   its own chunk and applies it.
7. **Commit locally** in one Dexie transaction: write merged rows, conflict copies,
   base, peer checkpoints, and resolve conflict records. Before each row is
   written the transaction checks that the row still equals the snapshot the merge
   read; a concurrent edit aborts the whole transaction rather than overwriting it.
8. **Advance checkpoints only in that transaction**, after the remote commit. A
   failure before it leaves the checkpoint behind, so nothing is marked processed
   that was not durably applied.

The order is deliberate: remote commit → transactional local apply → checkpoint.
Retrying is idempotent because chunks carry full rows and deterministic revisions.
An upload that succeeded without a manifest update leaves an orphan chunk, which is
harmless; an upload committed in the manifest without a local checkpoint is
recovered by the self-chunk pull above.

## Conflict policy

The merge engine is `src/lib/sync/merge.ts`; it has no React, Dexie, or Drive
imports and is tested directly.

- **Independent creates** on two devices survive. Different stable ids are two
  entities, even if their names match. Folders are never merged by name/title.
- **Note title/body edited on both sides** produces two visible notes: the
  deterministic winner keeps the original id, the loser is copied to a new note
  with a stable, content-derived id and a `(conflict copy)` title (except for a
  sealed note, whose title stays encrypted and unchanged). Both go through the
  normal lock rules; no plaintext is introduced for a sealed row.
- **Other field conflicts** are merged field by field: a field changed only on one
  side takes that side. If both sides changed the same field, the deterministic
  revision winner is used, and both full rows are stored in a local conflict record
  so the user can review and choose the other version.
- **Delete vs. edit**: an edit always survives a concurrent tombstone (the row is
  resurrected) and is surfaced as a conflict. Deletions are never allowed to
  silently destroy content that another device changed. Both-deleted produces a
  tombstone.
- **Soft delete (trash)** is a normal field. Trash/restore changes propagate. A
  concurrent edit remains in the trashed row and is recoverable.
- **Folder and note moves/reorder** merge as ordinary fields with deterministic
  tie-breaks. A missing or cyclic parent is repaired to the nearest safe root by a
  deterministic structural pass; a live child of a trashed parent is re-homed so
  it cannot become unreachable.
- **Relations** (`linkTags`, `noteLinks`) are set-like rows keyed by stable ids.
  Rows whose endpoints no longer exist are dropped. Tags with the same name that
  were created concurrently are deduplicated to the lowest id (a tag's name *is*
  its identity; this is the documented exception to "never merge by name"), and
  relations are rewritten to the winner. **Saved links are never deduplicated**,
  not even when they point at the same URL: two independently saved rows are two
  entities, and collapsing them would silently choose one history, tag set and
  lock state over the other. The only identity a link has is its stable `id`.
- **Tombstones are durable** in `syncBase`. They are retained and re-sent until the
  entity is recreated. There is no automatic tombstone collection in v1 because
  there is no central acknowledgement point: a device assumed gone could still
  return with an old checkpoint. The cost is small (one tiny base row per hard
  deletion); a future compaction can prune tombstones only once every known peer
  checkpoint is newer than the tombstone, or a device is explicitly removed.

## Privacy and lock semantics

Locked content was already sealed (AES-GCM envelope) in IndexedDB before sync.
Sync copies those rows exactly as stored: blank plaintext fields and `enc`
ciphertext. It never has the vault key and never decrypts. Folder rows are not
sealed by the current build — the folder name is the label on the door and the
only thing that makes a locked folder choosable, for example in the share
destination picker — while note and link content is ciphertext. Lock badges and
inherited protection are recomputed locally after apply.

Validation does **not** require `isLocked:true` on a sealed row. A row sealed
because an ancestor folder is locked keeps `isLocked:false`, which records only a
lock on the row itself; what validation does enforce is that no plaintext secret
survives beside `enc` (a sealed note must have an empty title and body, a sealed
link empty URL/metadata fields, a sealed folder an empty name).

**Cross-device key release.** The vault key was device-bound; a second device
could not open synced locked content. Sync adds a high-entropy recovery wrap,
stored only as ciphertext in `stash-sync-v1-keyring-<fingerprint>.json`:

- The user generates a 160-bit recovery key. Stash displays it once and stores only
  an AES-GCM wrap of the vault key, derived under the recovery key with PBKDF2
  (210,000 rounds) and a random salt.
- It is never a short password, never synced to a server, and never stored in
  plaintext. Setting or revealing it requires device authentication.
- On a second device, connecting sync is not enough to read locked content: the
  user must enter the recovery key. That unwraps the vault key, rewraps it for the
  new device's secure store, and only then does the normal BiometricPrompt /
  WebAuthn gate apply to each locked folder.
- Adoption is deliberately fail-closed. On the web, a platform credential is
  enrolled **before** the keyring is written, because a browser cannot raise its
  prompt without one; if enrolment fails, nothing is changed. The device wrap is
  installed with permission to replace a matching stored key, so a Windows Hello
  reset (a lost credential beside a still-wrapped key) is recoverable with the
  same recovery key. The session stays locked afterwards — adopting a key never
  opens a folder by itself.
- Google sign-in alone therefore only moves ciphertext. It cannot decrypt.
- If device authentication is lost or the platform wrap is invalidated, the same
  recovery key restores access without weakening the lock.
- Device PINs, biometrics, refresh tokens, and device wrapping keys never sync.
- If two devices independently create a *different* first vault key while offline,
  each keyring file is preserved (names include the key fingerprint) and the UI
  reports the foreign key; content encrypted under the other key is preserved but
  cannot be opened until that key is supplied. This is a documented limitation of
  the single-active-key build, not a deletion.

Known limitation: a vault that existed before sync and has no recovery key can
sync, but its sealed content will not open on another device until “Set up
recovery” is used on a device that can already open it. The UI says so in the sync
panel rather than pretending otherwise.

## Migrations

Dexie version 7 adds exactly four sync tables (`syncBase`, `syncPeers`,
`syncConflicts`, `syncMeta`) and nothing else. No existing table is read,
rewritten, dropped, or re-keyed. Existing IDs are untouched. A legacy vault with
no sync data simply has no base; the first sync treats its rows as new entities and
uploads them. Remote manifests with a higher `schemaVersion` are refused, so an
older build cannot overwrite a newer device's data; the user is told to update.

Import/erase behavior:

- A backup restore keeps the sync base. Missing rows therefore become tombstones on
  the next sync rather than being silently left on Drive; imported rows upload as
  updates.
- “Erase vault” first stops sync (clears timers, disconnects the account, revokes
  the grant, drops sync meta and checkpoints) and only then deletes the local
  database, including recovery wraps. The order matters: an engine running against
  the emptied database could otherwise publish the whole vault as deletions. The
  confirmation stays behind device authentication. Drive content is not deleted,
  and the sync UI says so.

## Failure behavior

- Cancelled OAuth, revocation, expired refresh token, missing client id, missing
  network, 401/403/429/5xx, and malformed remote data are distinct sanitized
  states. No state contains tokens, note content, or configuration secrets.
- 429/5xx are retried with exponential backoff and jitter, respecting
  `Retry-After`; 401 tries one silent refresh. Authentication requiring
  interaction stops automatic retries until the user reconnects.
- Auto-sync runs only in the foreground, after startup/resume and after local
  changes, debounced and serialized, with bounded backoff. Android background
  execution is not promised.
- The local vault is usable with no network and no Google account, exactly as
  before.

## Testing

`tests/sync-merge.test.ts` covers the pure engine: independent creates, folder and
link identity (including “same URL is not the same link”), note conflict copies,
deterministic moves/order, tombstones, idempotent merges, clock skew, sealed rows,
relation/tag dedupe, and structural repairs. `tests/sync-engine.test.ts` runs the
engine against an in-memory store and a fake Drive with failure injection:
interrupted manifest writes, checkpoint lag, duplicate syncs, offline retries,
account isolation, validation failures, pagination, device-secret exclusion and
keyless pull of sealed rows are simulated. The real Google adapter is not
exercised in automated tests because it needs a live OAuth client; the web and
Android builds are compiled, and live verification steps are in
[google-drive-setup.md](./google-drive-setup.md).
