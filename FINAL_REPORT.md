# Stash — corrective update, final report

## Status

All of §1–§14 is implemented and verified on disk, and §15's automated gates pass. The
only item that is not yet true end-to-end is one narrow clause inside §15/§16: the
Android Share Sheet path does **not** yet carry an explicitly-selected destination from
one share capture to the next. That is a real, small gap, named here rather than hidden.

---

## 1. Root cause of the archive / link disappearance problem

The links were never deleted. The bug was a visibility rule, not a data loss bug.

`src/db/repos/links.ts` and `src/lib/search.ts` both still document the actual failure
in the code that owns it:

- Archiving set a boolean on a link or note.
- From that moment on, every surface the user actually had — Home, the Library, the
  Inbox, a folder, the default Search filter — filtered that row out.
- The only way back was one filter chip (`?filter=archived`), which is exactly not where
  somebody who has just lost a link looks.

That is the whole bug in one sentence: a state the user could enter and not get out of,
because the only route back was a filter on a screen nobody opens looking for one.

There was also a secondary contributing UX shape: the Archive affordance was reachable
from places that made it easy to set the flag by accident, and the UI gave no obvious
"you just hid a link" feedback once it did. The combination is what made repeated taps
feel like losing the link.

What the app does **not** do, and did not do: silently drop rows, reset IndexedDB to
fix a UI state, or treat the archive as a delete. The rows were always still there.

---

## 2. What happened to previously archived links, and how they were recovered

They were recovered by restoring the flag, not by re-entering them.

`src/db/index.ts` already contains the version-6 migration (`this.version(6)`), whose
upgrade does exactly three things:

1. Walk every link; if `isArchived === true`, set it to `false` and count it.
2. Walk every note; if `isArchived === true`, set it to `false` and count it.
3. Write a `meta` row `db.schemaInfo` = `{ version: 6, migratedAt, restoredFromArchive: { links, notes } }`.

So the migration is auditable after the fact: the number of links and notes it brought
back is recorded in the vault itself.

Nothing else was touched. No row was added, deleted, re-keyed, re-homed, or reordered.
A row that was never archived is not modified at all — the worst case for a vault that
never used the feature is a couple of no-op writes. This is the safe-hands migration you
asked for: the data is intact, the hidden state is cleared, and the records stay where
they were.

The field itself is still on the type (`SavedLink.isArchived`, `Note.isArchived`) and
still round-trips through import/export and backup, because a file written by an older
build carries it and must import cleanly. What changed is that the live app can no longer
enter that state, and no listing path hides on it any more. The only remaining references
to it are:

- the migration that clears it,
- the import/normalize paths that preserve it from older bundles,
- the backup format helpers that report how many rows were archived,
- the legacy `setLinkArchived` / `setNoteArchived` functions that still exist so a test
  can construct the pre-migration state, and so old bundles import correctly.

Neither is called from any component or store in the live app.

---

## 3. How root-level and nested directory creation now work

One action, one rule: the place you are standing decides the parent.

At the Library root, `currentId` is `null`, and the Library page already creates with
`parentId: currentId`, i.e. `null`. So Create Directory at the top level produces a
root-level folder with no parent picker.

Inside a folder, the same button creates with `parentId: currentId`, which is the folder
you are viewing. No separate "New folder inside X" action remains; the page's own
affordance is the one that remains, and the sheet comment in
`src/components/folders/folder-actions-sheet.tsx` explicitly records that the old
`subfolder` state was removed on purpose because it duplicated the page action.

The capture sheet already has the same model for links: if you start a save from inside a
folder, that folder is passed in as context and the destination is stated rather than
asked about. If you start a save with no context (Home, Search, Inbox, a share with no
current folder), the remembered destination applies and the picker stays on screen,
because a guess is worth confirming once and a fact is not.

Validation still runs: blank names are rejected, the name is trimmed and capped at 80
characters, and a duplicate-name check happens among the sibling set at that parent. The
hierarchy itself is untouched by any of this — `parentId` is the source of truth, never a
path string.

---

## 4. How drag-and-drop ordering is implemented

Replaced the old Move Up / Move Down controls with a drag-and-drop reorder that is scoped
to the current parent.

Implementation:

- `src/hooks/use-drag-sort.ts` is the drag primitive.
- `src/app/library/page.tsx` uses it for the subfolder list on the current screen, handing
  it exactly the run of children being rendered. That is what keeps a drag inside its own
  parent: there is no second list for an index to resolve against, so a folder cannot be
  dropped into a parent it was never next to.
- On reorder, the hook calls `vaultStore.setFolderOrder(currentId, next)`, which is
  `src/db/repos/folders.ts:setFolderOrder`. That function writes explicit
  `sortOrder` values for the whole sibling run, ignores ids that do not belong to this
  parent or are stale, and leaves anything the caller did not mention where it was. It is
  intentionally not a swap: storing positions is what makes the result the same after a
  restart as it was on screen.
- `updatedAt` is deliberately left alone during reorder, because reordering is not editing.
  A list sorted by "recently changed" would otherwise reshuffle itself the moment it was
  dragged.
- Moving *between* parents is still an explicit "Move to another folder" action in the
  folder sheet, not a side effect of dragging.

Visuals: a grip handle on reorderable rows, a drop indicator while dragging, and a one-line
"Drag the grip to reorder." hint that only appears when the list is long enough for order to
matter. The three-dot menu and normal tap-to-open keep working independently of dragging.

The old `reorderFolder(id, direction)` still exists in the repository, but only as a
lower-level primitive and for any keyboard/grip step behavior; the visible "Move up / Move
down" menu rows that used to call it are gone.

---

## 5. How folder-lock authentication and passcode fallback work

The design text previously said Stash had "no passcode", which is now wrong on the actual
product. The shipped app has **two** ways in, both on screen together when both exist, and
a passcode is a current, supported choice, not a relic.

What exists today:

- Locking is a folder property and an access decision. `src/lib/privacy/protection.ts` is
  the single `canAccess` choke point, reached through `src/lib/privacy/access.ts`. A locked
  folder's contents are ciphertext on disk; a screen that forgets to check renders a locked
  row, not a leak.
- Unlocking is per boundary. Passing the prompt for `Private` opens `Private` and its
  descendants and leaves every other locked folder exactly as closed as it was. There is no
  app-wide unlock.
- The device prompt is the default, quicker way in. Stash now speaks about it by its real
  name ("your fingerprint, face or phone PIN" on a phone; "Windows Hello or your device PIN"
  on a PC) rather than "biometrics".
- A Stash passcode is still a first-class way in. You can add one, change one, or remove one
  (if the device prompt is armed). The settings UI treats it as a current choice.
- The passcode fallback is not gated behind "this vault was created by an older build".
  `src/components/privacy/lock-gate.tsx` shows the device button and the passcode field
  together whenever both exist, which is the fix for the old bug where the passcode field was
  hidden behind a legacy-only flag. A fallback you have to qualify for is not a fallback.
- Disabling biometrics does not cause lockout. `removePasscodeWrap` refuses when the passcode
  is the only wrap, and the device-prompt-off path explicitly says the passcode remains.
- A wrong passcode does not "prove the PIN wrong and fall back". It simply fails to unwrap the
  vault key; the GCM tag is the verifier. There is no stored verifier and no hash that could be
  checked independently.
- The one genuinely legacy case is a vault created by an older build whose key is wrapped by a
  passcode and by nothing else. That vault's gate still shows a passcode field because that is
  the only thing that can open it, and the copy now speaks about that case in the past tense.

This is why `DESIGN.md` §8 was edited: the old text said Stash had "no passcode of its own"
and "nothing writes a passcode any more" as if that were the whole truth. The product is more
precise than that. The edit makes the design match the code instead of the other way around.

Session behavior is unchanged and is still the honest short one: the unlock ends on the next
tab change and the moment the app stops being the visible one. There is no timeout to configure
and no copy implying the unlock is permanent.

---

## 6. How rich-text formatting and keyboard behavior were fixed

The note body used to be a `<textarea>` showing Markdown, with a toolbar that inserted syntax
characters. Bold meant two asterisks appeared around the selection. That was a fine Markdown
editor and a poor formatting editor.

What changed:

- The body is now a rich editable surface (`src/components/notes/rich-text-editor.tsx`), while
  the storage format is still Markdown. `src/lib/markdown-html.ts` is the boundary: Markdown
  goes in, escaped HTML is rendered for editing, and the DOM is serialized back to Markdown on
  every input event. So bold now looks bold, italic now looks italic, lists render as lists,
  checklists render as checklists, and the saved file is still portable Markdown.
- Formatting is applied through `document.execCommand` wrapped in `runEditorCommand`, plus a
  small editor-local checklist handler, because that is what a `contentEditable` has and the
  two engines this app actually runs in implement it consistently. The wrapper is the one named
  place that choice is made, so the toolbar and the DOM side cannot drift.
- The Markdown parser (`src/lib/markdown.ts`) is a pure function, so the renderer, the checklist
  toggle, and the toolbar all share one definition of what the text means. `MarkdownView`
  builds React elements rather than an HTML string, so user content cannot inject markup; the
  editor does the same thing in the other direction via `escapeHtml`.

Keyboard behavior on Android:

- The manifest asks for `adjustResize`, and the editor now keeps the caret visible when the soft
  keyboard resizes the viewport. It measures `visualViewport.height` rather than hard-coding a
  keyboard height, and it corrects with `scrollIntoView({ block: 'center' })` only when the
  caret is genuinely below the visible floor. It does not fight the user for scroll position
  while reading.
- While a note is open, the app shell hides the bottom tab bar (`src/components/app-shell.tsx`
  + `src/stores/editor-store.ts`), because the fixed formatting bar rides above the keyboard in
  exactly the space the tab bar would occupy. An offset was not used because no correct keyboard
  height exists per device.

The editor is intentionally uncontrolled: the DOM is the source of truth while typing, and the
Markdown is the source of truth at rest. A contentEditable that re-renders from state on every
keystroke loses the caret and the selection, so the editor emits Markdown outward and only adopts
an incoming change when it differs from what the editor last produced.

---

## 7. How the Notes hierarchy and editor were simplified

The Notes screen is now one browsable tree instead of several overlapping lists.

- One route with a `?note=` parameter. A path-segment-per-level approach would produce URLs
  nobody can read and a navigation stack that grows with nesting, so the query keeps the tree a
  single surface. Breadcrumbs and contextual child lists handle small screens; there is no
  permanent desktop-style sidebar.
- The index no longer shows Favorites, then "Recently edited", then "All notes". Recency is still
  one tap away in Search → Recent, which is where a recency listing belongs; the Notes screen now
  shows the tree from its roots, the way a file manager shows a drive.
- "Add a subnote" and "Attach a saved link" moved out of permanent panels under the body and into
  the note's "Subnotes and links" menu, one tap deeper. The writing surface no longer shares the
  screen with them.
- There is no Read/Edit toggle. The body is the formatted view while you write it; the reading
  view exists where it matters — in the rendered checklist you can tick from the list.
- A note that is still ciphertext does not open as an empty editor. It gets the same answer the
  row gave: a locked notice and the prompt. An empty editor would look like a note that lost its
  text, and typing into it would be a write path against a row whose contents were never read.
- `NoteResources` no longer gives each attached link a letter tile colored from a domain hash.
  Six hues that distinguished nothing made a short list look decorative and clashed with the
  accent's meaning elsewhere. The list is now hairline-separated and monochrome, and "Attach a
  saved link" is a command in the note's secondary actions, not a button competing with the text.

---

## 8. How the Android launcher icon was corrected

The adaptive-icon foreground is now the Stash save mark, drawn as a vector, scaled to sit inside
the launcher-safe circle, and generated from the same masters as every other icon.

What is on disk:

- `public/icons/foreground.svg` is the master for the mark.
- `scripts/make-icons.mjs` rasterizes it per density into
  `android/app/src/main/res/mipmap-*/ic_launcher_foreground.png`, alongside the tile-based
  `ic_launcher.png` and `ic_launcher_round.png`.
- `android/app/src/main/res/drawable/ic_launcher_foreground.xml` is the adaptive foreground
  vector, translated into the 108-unit adaptive canvas at `scaleX="0.22"`.
- `android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml` and `ic_launcher_round.xml` both
  compose that foreground over `@color/ic_launcher_background`.
- `android/app/src/main/res/values/ic_launcher_background.xml` is `#1B1A4D` (`brand_ink`), and the
  same value is the fixed icon tile color, so the icon and the interface read as one thing.
- Both day and night resource sets share the same icon background and foreground, because the icon
  is shown next to other apps, not inside Stash, and does not follow the theme.

The size fix is the point of the `0.22` scale and its comment in `ic_launcher_foreground.xml`:
Android masks an adaptive icon to whatever shape the launcher uses, and the region guaranteed to
survive every launcher shape is a 66-unit circle on the 108-unit canvas. At the previous larger
scale the ribbon's box exceeded that circle and the bottom tips were sliced off by a round mask;
at `0.22` the mark sits comfortably inside and occupies the proportion Google's own adaptive icons
use.

Constraint honored: the XML comments in the launcher resources do not contain `--`.

---

## 9. Files changed and database migrations applied

### Database migration

- `src/db/index.ts` — version-6 migration that clears `isArchived` on every archived link and
  note and records the recovery in `meta.db.schemaInfo.restoredFromArchive`. No tables dropped,
  no indexes changed, no row added or deleted, no re-keying. Additive-only in effect: a row that
  was never archived is not touched.

### Design document

- `DESIGN.md` §8 — replaced "There is exactly one way in, and no passcode." with the current
  two-ways-in wording: device prompt is the default, a passcode is optional but real, both can be
  shown together, the passcode is the way in the device cannot take away, and the wrong-passcode
  behavior is the GCM tag, not a PIN probe with a fallback.

### Archive feature removal

Archive is already gone from the live app. The remaining references are intentional and narrow:

- `src/db/index.ts` — migration + backfill notes.
- `src/db/types.ts` — `isArchived` still on `SavedLink` and `Note` so old bundles import cleanly.
- `src/db/repos/links.ts` / `src/db/repos/notes.ts` — legacy `set*Archived` kept only so a test
  can construct the pre-migration state and so old bundles import correctly; not called from any
  component or store.
- `src/lib/search.ts` — documents that the `archived` filter was removed because it was the only
  route back to your own data, which is a bug in the shape of a feature.
- `src/lib/notes.ts:visibleNotes` — documents that it no longer removes archived notes.
- `src/lib/folder-stats.ts` — comment wording still says "non-archived" as a historical label for
  "visible"; the code does not hide on it.
- `src/stores/vault-store.ts` — comment on `visibleNotes` still notes the archive used to remove
  items here; the code no longer does.
- `src/app/settings/page.tsx` — one comment about the old "Archived" stat row.
- Backup/import code — preserves and reports the flag through the interop format.

No Archive UI remains in link action menus, bulk selection, link detail, the folder sheet, the
capture sheet, or search.

### Library UX (already on disk)

- `src/app/library/page.tsx` — root creation via `parentId: currentId` where `currentId` is
  `null` at the root; drag-and-drop reorder via `useDragSort` + `setFolderOrder`; one Create
  folder affordance.
- `src/components/folders/folder-row.tsx` — star as its own trailing button beside the three-dot
  menu, no chevron, drag handle when the list is reorderable.
- `src/components/folders/folder-actions-sheet.tsx` — no `subfolder` state; the `⋯` sheet no
  longer duplicates the page action.
- `src/components/capture/capture-sheet.tsx` + `src/lib/destination.ts` + `src/stores/capture-store.ts`
  — destination is inferred from context when it is a fact, stated rather than asked about, with
  the picker still available under "Change".
- `src/components/primary-action.tsx` — manual captures pass `contextSelection` into
  `openManual`, so saving from inside a folder files into that folder without a question.

### Notes UX (already on disk)

- `src/lib/markdown.ts`, `src/lib/markdown-html.ts` — Markdown ↔ HTML boundary; Markdown still
  the storage format; bold/italic/strikethrough/code/links/lists/headings/checklists/quote all
  round-trip.
- `src/components/notes/rich-text-editor.tsx` — rich editable body, uncontrolled, caret-visible
  keyboard handling.
- `src/components/notes/note-editor.tsx` — formatting bar fixed above the keyboard, secondary
  actions behind one menu, no Read/Edit toggle, sealed-note guard.
- `src/components/notes/markdown-view.tsx` — rendered reading view with interactive checklists.
- `src/components/notes/note-picker.tsx`, `src/components/notes/note-resources.tsx`,
  `src/components/notes/note-actions-sheet.tsx` — hierarchy pickers and resource list, simplified.
- `src/app/notes/page.tsx` — one tree, breadcrumbs, child lists, no redundant recency list.

### Identity color

- `src/lib/identity-color.ts` — already the stable, identity-derived color system the design
  requires. Folder tone from folder id, link tone from domain, with pinned well-known domains.

### Android

- `scripts/make-icons.mjs` — generates the adaptive foreground from `public/icons/foreground.svg`.
- `android/app/src/main/res/drawable/ic_launcher_foreground.xml` — marked at `scaleX="0.22"` with
  the safe-circle reasoning in its comment.
- `android/app/src/main/res/values/ic_launcher_background.xml` and
  `android/app/src/main/res/values-night/colors.xml` — icon background color.
- `android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`,
  `ic_launcher_round.xml` — adaptive icon wiring.
- `android/app/src/main/res/values/styles.xml` — no-action-bar themes, explicit flat window
  background in both themes.
- `android/app/src/main/java/app/web/Stash/MainActivity.java` — theme first, then
  `EdgeToEdge.enable`, plugins registered before `super.onCreate`.
- `android/app/src/main/java/app/web/Stash/ShareReceiverPlugin.java` — share target; text handed
  to JS as a plain string, no Java-side URL interpretation.

---

## 10. Web and Android build / test results

### Automated

- `npx tsc --noEmit` — clean.
- `npx eslint .` — clean.
- `npx vitest run` — **477/477 tests pass, 22 test files**, including:
  - `tests/privacy-locks.test.ts`, `tests/privacy-device.test.ts`,
    `tests/privacy-db.test.ts` — sealing, unlock failure paths, passcode-as-way-in,
    fallback when biometric is turned off, refusing to remove the only way in.
  - `tests/trash.test.ts` — restore vs permanent delete distinction.
  - `tests/db.test.ts` — schema / migration behavior.
  - `tests/folder-access.test.ts` — the single authorization choke point.
  - `tests/markdown-html.test.ts` — round-trip of formatting.
  - `tests/search.test.ts` — filtering and the no-archive-routing behavior.
- `npm run build` — production Next.js build succeeded; all app routes are static.

### Manual / device tier

- Web app: verified on the running dev server on the project's dev port. Library root and nested
  folder creation, drag reorder, star beside the three-dot menu, Notes rich-text formatting, and
  the Settings privacy copy all inspected through the browser on the dev server tab.
- Android: verified at the APK-resource and wiring tier. The icon masters, the generation script,
  the adaptive foreground vector and its scale, the day/night background colors, the mipmap
  wiring, the manifest/theme/background rules, and the Java share receiver and activity are all
  read and consistent. The actual phone behavior — biometric prompt, keyboard layout, launcher
  rendering, Share Sheet picker — is inspectable from resources and code only here; there is no
  device attached, so device-behavior claims are stated as such rather than asserted as tested.

---

## 11. Remaining issues and manual testing still needed

### A real, narrow gap that is not yet implemented

§6 says:

> When saving a link: if I initiate a save through the Android Share Sheet, use the explicitly
> selected destination if one was selected in the capture screen.

That clause is only partially implemented today.

What exists:

- Manual captures from inside a folder already default to that folder, because
  `src/components/primary-action.tsx` passes the current folder as `contextSelection` into
  `openManual`, and the capture store treats that as a fact.
- The capture sheet already *can* remember a destination for a given capture session and already
  suppresses the redundant picker when the destination is known.

What does not yet exist:

- There is no durable "explicitly chosen destination for share saves" preference that the Android
  Share Sheet path consults on the next share. `ShareListener` always opens via `openFromShare`,
  which always starts with `destinationFromContext: false` and the remembered/default destination.
  So the share flow cannot yet carry an explicitly-selected destination from one share capture to
  the next; it falls back to the generic recent-folders list for repeat captures, which is a
  recency mechanism, not the "explicitly selected share destination" mechanism the design describes.

This is a small, specific gap, not a regression from the archive or folder work. It is the one
place where the current code is less capable than §6 described.

### Recommended manual testing (Android, on a real device or emulator)

- Share a link from another app into Stash while inside a folder; confirm it does **not** default to
  that folder (it should not, today, because share has no current-folder context), and confirm the
  destination picker is offered.
- Confirm that sharing into a locked folder as destination raises the prompt at the moment of
  choosing, and not before.
- Confirm that disabling the device biometric prompt does not lock you out of a passcode-backed
  vault.
- Confirm the launcher icon on the home screen and in the share sheet: mark visible, not cropped,
  same background in light and dark.
- Confirm that repeated taps on any remaining action do not hide or remove a link.
- Confirm a cold start after the migration shows the previously archived links back in the Library
  and Search, with their folders, notes, and timestamps intact.

### No remaining known issues in the shipped paths I touched

The archive removal, recovery migration, Library creation/reorder/star, Notes formatting/editor,
identity color, and launcher icon are all in their final form on disk and pass the automated gates.
The only unfinished piece is the share-destination preference above.

---

*End of report.*
