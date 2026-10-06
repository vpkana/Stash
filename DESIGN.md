# Stash — design system

This is the authored design language of Stash. It exists so the app does not
drift back into looking machine-made: the failure mode is not "ugly", it is
*generic* — card after rounded card, a rainbow of icons, a container around
every thought, decoration standing in for hierarchy.

Read this before changing UI. If a change cannot be justified by a rule here,
the rule is probably right and the change is probably wrong — or this document
needs a deliberate edit, which is a decision, not an accident.

Tokens live in `src/app/globals.css`. Primitives live in `src/components/ui/`.
Screens compose those; they do not invent new visual vocabulary.

---

## 1. The direction

**Daylight: a bright, saturated interface where colour is a label.**

Stash is a private utility someone opens many times a day to file something or
find something. It is not a dashboard, not a social product, not a showcase. It
should feel like a well-made tool that is *pleased* to be used: a calm, cool
near-white page, eight vivid colours that mean something, generous type, and
everything in its place.

Five rules produce everything else:

1. **Colour carries meaning, never decoration.** There is one accent, used for
the action and the selection, and there are eight **identity tones**. Every tone
is assigned by *identity* — a folder's own id, a link's domain — so a colour is a
label the user learns ("YouTube is the red one", "the Studio folder is the violet
one") rather than a rainbow generated for variety. **A colour that is not
carrying meaning is a bug.**
2. **Cool base, vivid ink.** Neutrals are a barely-violet near-white so the
saturated tones have something calm to sit on. A warm base fights saturated
accents; a cool one lets them ring.
3. **Hierarchy is typographic.** Size, weight, position and space carry it. A
   screen with its containers removed must still be understandable.
4. **Group, do not rule.** Things that belong together sit on one soft card with
   hairlines inside it. Full-bleed rules across a screen are a spreadsheet.
5. **Both shapes are first-class.** Mobile is the primary surface and the phone
   layout is never compromised for the desktop one — but a 1400px window is not a
   phone, and pretending it is produces the worst of both. Above `lg` the app
   becomes a sidebar plus a centred column (see *The two shapes*, below).

Corollary: **design from content, not from components.** Start with "what does
the user need to know here", not "I need a Card". A folder is a name, a count, a
face and a way in — and the face is how this app lets you recognise it without
reading.

### The two shapes

The same shell, one breakpoint, two honest layouts:

- **Below `lg` — the phone.** The tab bar at the bottom, the floating action
  above it, the full width for content. This is the primary surface. It is not
  "the narrow version of the desktop layout"; it is the layout.
- **From `lg` — the desktop.** A 256px rail on the left, the content in a
  centred 704px column (`column` in `globals.css`), and the tab bar retired.

Three things this buys, and each is the reason for one of the rules above: rows
stop being 1400px wide, the pointer gets a primary action where the hand already
is, and the rail has room to say what each destination *is for* rather than just
naming it. A second desktop-only shell is how the two drift until they disagree —
there is one `AppShell` with one `lg:` and that is deliberate.

A floating button hovering over a wide window is a phone habit, not a desktop
one: above `lg` the primary action lives in the rail.

### The mark

**A kept ribbon:** a bookmark whose notch is a soft curve rather than a sharp V,
in white on a deep indigo tile (`brand_cream` on `brand_ink`). It says what the
app is for — things you mean to keep — and it is one flat shape, so it reads at
16px in a tab bar and at 192px on a home screen with no second colour, no
gradient and no shadow.

Rules:

- **There is one mark.** It appears on the launch screen, in the settings
  sign-off, on an empty Home, and as the app icon. Nowhere else — a logo in a page
  header is decoration, and the app already has a title.
- **It is drawn, not imported.** `src/components/ui/logo.tsx` renders it from the
  same path as the icons, in `currentColor`, so it is crisp at any size and
  follows the theme without a second asset. Do not add a PNG of the mark to the
  interface.
- **Icon assets are generated.** `public/icons/{icon,maskable,foreground}.svg`
  are the masters; `node scripts/make-icons.mjs` writes every PNG (favicon,
  apple-touch, PWA, Android launcher and adaptive foreground). Never hand-edit a
  generated PNG — edit the master and re-run the script.
- **The tile is the same in both themes.** The app icon is shown next to other
  apps, not inside Stash, so it does not follow the theme. `--brand-ink` and
  `--brand-cream` exist for that reason and are the only fixed colours in the
  system.

---

## 2. Forbidden patterns

These are the specific tells of generated UI. None of them are in the app, and
none of them may be added:

- gradient hero cards, gradient buttons, gradient text, two-colour gradients of
  any kind. (The accent is one *solid* colour. A gradient is the single loudest
  tell that a palette was generated rather than chosen.)
- glassmorphism, glowing borders, floating blobs, decorative sparkles;
- a container around every element: card-inside-card, a box per list row.
- **a tile that is not an identity.** The `tile` utility exists for exactly one
  job: carrying the identity colour of the thing it labels (§6). A tile behind a
  *section heading*, a *navigation item*, a *button* or an *empty-state icon* is
  decoration, and decoration is how forty rounded squares stop meaning anything.
  The two exceptions are the accent tile on a locked row and on the Inbox card,
  and the accent tile on an empty state (§14) — in all three the accent means
  "this is the thing asking for you";
- **an icon chosen to look varied.** The glyph on a tile says what kind of thing
  it is (a folder's chosen icon, a note that contains subnotes, a link's source).
  It is never picked for visual balance;
- `rounded-2xl` on everything (see §5 — shape is a vocabulary);
- random icon colours, or an icon on every label "for balance";
- **hairline rules across a full screen**, and `border-dashed` anything: a dashed
  outline is what a design tool draws for "something goes here";
- headings that push content below the fold. (A 28px page title on a phone is
  not oversized — it is the difference between an app and a form. A hero band or
  an illustration above it is.)
- bordered pill chips for every metadata value. Soft chips (`bg-surface-2`,
  `rounded-full`, no outline) are allowed for a wrapped set of short names, which
  is the one shape that works for "favourite folders" and tags;
- badge soup, stat tiles, dashboards, scores;
- **a colour picked at the call site.** Every tone comes from
  `identityColor` / `domainColor` (§6). `bg-id-rose` typed into a component is a
  bug even when it looks right, because the next person cannot tell whether it
  was deliberate;
- excessive explanatory copy, duplicated labels (title + subtitle saying the
  same thing), all-uppercase section labels with wide tracking;
- animation for its own sake: on-load floats, staggered reveals, bouncing icons,
  ambient motion, spring overshoot;
- grey slabs on black, or white cards floating on grey — in either theme.

If something *feels* premium because it is loud, it is wrong. Premium here means
fast, calm and exact.

---

## 3. Typography

Six steps, each with one job. New UI picks a step; it never picks a raw size.

| Token         | Size | Job                                            |
| ------------- | ---- | ---------------------------------------------- |
| `text-hero`   | 34px | the page title on a wide screen, and the sign-off |
| `text-display`| 28px | the page title — one per screen                |
| `text-title`  | 19px | sheet and dialog titles, the wordmark          |
| `text-row`    | 16px | list-item titles (the most common text)        |
| `text-body`   | 15px | prose the user reads or writes                 |
| `text-meta`   | 13.5px | the secondary line under a row title         |
| `text-label`  | 13px | section labels                                 |

`text-hero` is *not* a licence to shout. It exists so that the two places the app
is allowed to be big — the page title once there is a desktop to be big on, and
the sign-off in Settings — do not each invent their own size. A page title is
`text-display` on a phone and `lg:text-hero` from `lg` up, and the change is made
by `PageTitle`, not by screens.

Rules:

- **Nothing is smaller than 13px, and nothing important is smaller than 15px.**
  A phone's type is not a desktop's: text that is legible on a 27" display is a
  squint in daylight on a bus.
- Weight does the emphasis: `font-semibold` for titles and section labels,
  `font-medium` for row titles, regular for prose. Avoid bold-everywhere.
- Section labels are sentence case, no letter-spacing, `font-semibold`,
  `text-muted` — *not* `text-subtle`. A signpost has to be readable; that was the
  bug in the old scale, where labels looked like something to skip.
- Two weights of secondary ink: `text-muted` for content the user reads,
  `text-subtle` for metadata that is never load-bearing. Do not stack three greys
  in one row.
- **Every text colour clears 4.5:1 against every surface it can sit on**, in both
  themes — including `text-subtle`. Re-check with the pair table when a palette
  value changes; "metadata" is not a licence to be unreadable.
- Truncate, never wrap, in rows. A row is one line of title plus one line of
  metadata, full stop.

---

## 4. Spacing and density

- 4px base unit. In practice: `px-4` page gutter, `py-3.5` row padding, `gap-3`
  inside a row, `mt-8` between sections, `pb-2` under a section label.
- **Rows are comfortable, not crammed**: a row with two lines of text is ~70px,
  which is a 44px touch target with air around it. The old density fitted more
  links per screen and made the app feel like a table; scrolling one extra screen
  is a fair price for a list that is pleasant to read.
- One gutter everywhere (16px), so lists line up from screen to screen. Cards are
  inset by exactly that gutter (`mx-4`), so a card's edge is never confused with
  the screen's edge.
- A row is: **identity tile**, title line, optional metadata line, optional
  trailing controls. Nothing else. (The tile is 40px and there is no variant of
  the row without one — a list where some rows have a tile and some do not reads
  as a list with a loading bug.)
- The desktop column is 704px (`column`), which is the reading width the app
  settles at above `lg`. It is not a maximum for its own sake: 1400px of 16px list
titles is measurably harder to scan than 704px of them.

---

## 5. Shape

Radius is a vocabulary with four words, not a default:

| Token                  | Use                                                     |
| ---------------------- | ------------------------------------------------------- |
| `rounded-tap`   (10px) | controls *inside* content (a small inline button)        |
| `rounded-control`(14px)| a real button, a field, an identity tile                 |
| `rounded-2xl`  (20px)  | a group of rows — use the `card` utility, not the class  |
| `rounded-surface` (28px)| a sheet or a dialog that floats above the page          |

Tailwind's stock radius steps are retuned to these four, so a stray `rounded-xl`
cannot quietly introduce a fifth corner. The `tile` utility fixes its own at 14px
(and `identity-tile.tsx` allows an override only for the smaller 34px tile in a
folder header, where 14px looks too round).

A list is a `card`: one soft edge around rows that belong together, with
hairlines *inside* it. The first and last row are clipped by the radius, which is
why `card` sets `overflow-hidden`.

`rounded-full` is reserved for: the floating action button, the sheet grab
handle, circular icon buttons in a row (`size-10`), the active tab's icon capsule,
and soft chips. That is the whole list.

Generous radii are not decoration. A 20px corner and a 44px button are what make
an interface feel touchable rather than drawn — and touchability is most of what
"friendly" means.

---

## 6. Colour and surface

This section is the heart of the language. Read all of it before changing a
colour.

### The accent

One accent — **vivid indigo** (`#4f46e5` light, `#a5b4fc` dark) — used for the
primary action, the current selection, focus, and links-in-context. Nothing else.
"Nothing else" is load-bearing: the accent is the only colour that means *act here
now*, and it stops meaning anything the moment it is also used to make a list look
lively.

**The one honest tension in this palette.** Indigo sits in hue between the `blue`
and `violet` identity tones, which is not ideal on paper. It is accepted because
the two are never in the same role or the same shape: the accent only ever appears
as a *solid* fill (a button, a selected row's background) or as text, while an
identity tone only ever appears as a *tint* on a 40px tile or as a small amount of
metadata text. A violet tinted square and an indigo filled button do not read as
the same thing, and no one has ever mistaken one for the other. If you are adding
a *new* use of the accent, check that it is not one of the tint roles.

### Identity colour — the single most important rule here

Eight tones — rose, orange, amber, emerald, cyan, blue, violet, fuchsia — each a
vivid foreground plus a tinted background (see `--id-*` and `--id-*-soft`).

They are **assigned by identity, never by position**:

- a folder's tone is derived from its own id (`identityColor(folder.id)`);
- a note's tone is derived from its own id;
- a link's tone is derived from its **domain**, and well-known domains are pinned
  (`domainColor`) so YouTube is red, GitHub violet, Spotify green, and a subdomain
  inherits its parent.

Two consequences, and both are the point:

1. **It is stable, so it is information.** The user learns "the Studio folder is
the violet one" and finds it in a list of forty without reading a single label. A
tone assigned per render, or by list index, would be decoration — and worse than
no colour at all, because the same folder changing colour every time you open the
Library is an active lie.
2. **It reduces the search, it does not uniquely identify.** Eight tones cannot
  distinguish forty folders, and pretending otherwise would be the failure this
  system is meant to avoid. With four folders, two pairs sharing a tone is
expected — that is what the *glyph* on the tile is for. Colour narrows a forty-row
scan to a five-row one; the icon and the name finish the job.

Where colour is *not* allowed: anywhere it is not an identity. Tags, counts,
buttons, section headings and chrome take the accent or a neutral. If you find
yourself wanting a ninth tone, the answer is a different glyph or a better name.

The per-tone values are written out as **literal** class strings in
`src/lib/identity-color.ts`, not composed from the tone name: Tailwind reads class
names out of the source as text, so `bg-id-${tone}-soft` would compile to no CSS
at all and every tile would silently go transparent. Do not "simplify" that file.

### Surfaces

A deliberately small ladder (light → dark):

- `bg` — the page (`#f6f7fb` / `#0c0e15`). What most of the screen is.
- `surface` — chrome raised off the page: cards, sheets, bars, toasts.
- `surface-2` — an inset: a field, a chip, a pressed row.
- `surface-3` — one step further in, for pressed states of insets.

The steps are small on purpose. A large step reads as "grey card floating on the
page", which is the look being avoided.

The two brand colours (`brand_ink` `#1b1a4d`, `brand_cream` `#ffffff`) are fixed in
both themes: they belong to the icon, which is not inside the app.

### Semantics

`danger` for destructive actions and a link the user marked dead; `warning` for a
favourite star; `success` for a confirmation toast. Never for variety. Note that
`warning` is a dark amber, not a yellow: it has to clear 4.5:1 on the page, and a
bright yellow cannot.

### Dark mode

Not inverted light mode, and never `#000`. The base is a deep blue-black
(`#0c0e15`) rather than a warm black, and surfaces step `#161922 → #1e222d →
#292d3a`, so depth reads as material rather than as holes.

The accent *lightens* rather than darkens — a saturated indigo is invisible
against a dark background, so dark mode uses a pale periwinkle. The identity
tones lift the same way: each becomes a bright foreground on a *deep* tint of its
own hue (`#fda4af` on `#3c1521` for rose), so a rose tile reads as rose in both
themes rather than as a washed-out shadow of itself.

Both themes are defined once in `src/app/globals.css`; components never branch on
theme. `color-scheme` follows the resolved theme, and `--chrome-gap` (§10) is
shared by both.

---

## 7. Icons

- **One family: Phosphor** (`@phosphor-icons/react`), imported through exactly one
  module: `src/components/ui/icons.tsx`. `size` 12–26. Do not import from
  `@phosphor-icons/react` directly in a component — the adapter is what keeps the
  vocabulary closed and the weights consistent.
- The adapter keeps the **names** the app already used (`Home`, `Lock`, `Link2`,
  even where Phosphor calls the glyph `House`, `LockKey`, `LinkSimple`) so a new
  icon is a one-line addition rather than a rename across thirty files.
- **Weight, not `strokeWidth`.** Every call site in the app says
  `strokeWidth={1.9}`; Phosphor has no such prop, so the adapter translates it to a
  weight (`≥2.6` fill, `≥2.15` bold, `≥1.75` regular, else light). That means the
  numbers already in the app express hierarchy correctly — an action icon is
  heavier than a decorative one. `strokeWidth` is a compatibility shim, **not API**:
  pass `weight` directly in anything new.
- An icon earns its place by clarifying an action or a state: a lock on locked
  content, a star on a favourite, a chevron on a drill-down.
- Icons are `aria-hidden` unless they carry meaning alone — and if they carry
  meaning, they get an `aria-label` (see the lock/star/unavailable marks).
- **A single-colour glyph is not an identity.** The one place a glyph is tinted is
  on an identity tile, where the tint comes from `IdentityTile`. Everywhere else an
  icon is `text-fg`, `text-muted` or `text-subtle`.
- Folder icons are stored as **stable string keys** (`src/components/ui/icon.tsx`)
  rather than raw glyphs, so the data model survives a future icon-set change —
  which is exactly what it just did. Never store a component or a Phosphor name in
  the database.

---

## 8. Rows, lists, folders

The row is the app. It is deliberately plain:

```
┌────┐  Docker networking talk          ☆   ⋯
│ Y  │  youtube.com · containers · 14h ago
└────┘
─────────────────────────────────────────────
```

- **The tile is the face.** 40px, one radius, one glyph, one tone. The glyph says
  what kind of thing it is; the tone says which one (§6). It is the only element
  in the app that is allowed to be coloured.
- Rows themselves are bare — no per-row background, no per-row radius, no
  per-row shadow. The surface they sit on provides the edge: `ListSurface` and
  `GroupSurface` are one `card` per group with `divide-y divide-hairline` inside
  it. A full-bleed hairline across a screen is a spreadsheet.
- The whole row is the touch target (`py-3.5`, ~70px). Trailing controls are
  `size-10` circular buttons so a thumb cannot miss.
- Metadata order is fixed: source → tags → context → relative time. Metadata is
  `text-meta text-subtle` — except the **source**, which carries its domain's tone
  and `font-medium`, because it is part of the identity and not incidental.
- State marks ride the title line (lock, favourite, unavailable) so they are
  visible while scanning.
- Grouped blocks (Settings-style) are the other half of the same idea:
  `GroupSurface` says "these rows are one thing".
- Long-press is a shortcut to the same action sheet the ⋯ button opens. Never
  long-press-only: the visible button is what makes it discoverable.
- **How the note-first rule survives the tile.** A saved link's first line is the
  user's own note, then the source's title, then the address (`link-label.ts`), and
  the address is never removed from the record. The tile shows the *source*, so
  the two lines together always answer "what is it" and "where is it from" even
  when the first line is the user's own words.

---

## 9. Sheets, dialogs, menus

- Bottom sheets for anything thumb-reachable: all item actions, move/copy
  destination pickers, capture, import.
- Sheets: `rounded-t-sheet` (28px — the one place the largest radius is
  correct), `border-t border-border`, `bg-surface`, `shadow-sheet`, grab handle,
  header, scrolling body, pinned footer with `pb-safe`.
- Action menus use `ActionList` / `ActionRow`: rows and hairlines, muted icons,
  the destructive row in `danger` and last. A five-item menu must not be five
  boxes.
- A dialog is reserved for a decision that needs an explicit answer
  (destructive confirmation). It is centred, `rounded-2xl`, `shadow-raised`.
- Confirmation copy names the item and the consequence. Never "Are you sure?".
- Destructive flows are two-step (delete → trash → purge), never one-step
  surprise.

---

## 10. System chrome, insets and the back button

**Insets.** Android paints edge to edge from API 35, and Capacitor 8's bundled
SystemBars plugin publishes the insets as `--safe-area-inset-*` custom
properties — which stay correct on every WebView version, including the older
ones where Capacitor pads the WebView natively and reports zero. So the safe
utilities read the custom property and fall back to `env()`:

```css
padding-top: calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + var(--chrome-gap));
```

- `pt-safe` / `pb-safe` add `--chrome-gap` (8px) on top of the inset. Those are
  the two edges where app chrome meets a system bar, and the gap is what keeps
  the clock and the gesture pill out of the header and the tab bar.
- `px-safe` handles landscape cutouts and adds nothing of its own.
- Nothing else may hand-roll `env(safe-area-inset-*)`.
- Because Capacitor zeroes the variables when it pads natively, the app never
  pads twice — do not "fix" that by removing the fallback chain.

**Bar appearance.** The system bars are styled from the app's *resolved* theme,
not the device's, via `syncSystemBars` (§`src/lib/system-bars.ts`). A light app
on a dark device would otherwise get dark icons on a dark background.

**No native chrome, ever.** The window belongs to the app and the app draws all
of it. Three rules, because each of them has already been broken once and each
failure looks the same on a phone — a bar at the top that nobody designed:

- **Both themes are no-action-bar themes, and the theme is claimed before any
  other window work** (`setTheme` first in `MainActivity.onCreate`, before
  `EdgeToEdge.enable`). AppCompat installs an ActionBar — titled with the
  activity label, which is the app's name — from whatever theme is current when
  the window's decor is first inflated, and one installed from the launch theme
  survives the later swap.
- **The window background is a flat colour, never a bitmap**
  (`color/stash_window_background`, day/night variants in
  `android/app/src/main/res/values{-night}/colors.xml`, matching the `bg`
  token). The window background is the one surface CSS cannot paint: it shows
  wherever the WebView does not cover the window — before the first frame, and in
  the strip Capacitor reserves natively on WebViews too old to report their own
  insets. A splash *image* there becomes a band of that image above the app's own
  content. `@drawable/splash` is therefore referenced by no theme.
- **Never set a window title or a toolbar**, and never assume `android:label`
  (used by the share sheet, which should say "Stash") renders inside the app.

**Back button.** Back is owned by the app, in this order:

1. close the topmost overlay (the overlay stack in `src/lib/overlays.ts`);
2. walk the screen hierarchy (`?folder=`, `?note=` nesting), falling back to
   Home when a screen was opened cold;
3. at Home, ask before leaving — twice within two seconds exits.

The canonical rules and their tests are in `src/lib/back.ts` and
`tests/back.test.ts`. Never leave a screen with no way back, and never let one
press of back drop the user out of the app.

---

## 11. Locked content

### 11.1 The rule

**The lock belongs to a folder, and it is an access decision.** Everything below
follows from those two clauses, and both are load-bearing:

- *Belongs to a folder* — `Private` is locked or it is not. There is no lock over
the app, no lock state per item, and no such thing as an unlock that opens the
vault. Passing the prompt for one folder opens that folder and its descendants,
and leaves every other locked folder exactly as shut as it was.
- *An access decision* — locked means the content may not be read. It does not
mean the content is drawn and then covered up. The store publishes a protected
row with its address, title, note and snippet **removed** (`redactLink` /
`redactNote` in `src/lib/privacy/protection.ts`), so a screen that forgets to
check renders a blank row rather than a leak. Hiding, blurring or greying an
item that is already in memory is not this feature.

Both halves are enforced through **one** function, `canAccess` in
`src/lib/privacy/protection.ts`, reached through `canAccessFolder` /
`requireFolderAccess` in `src/lib/privacy/access.ts`. A new surface either calls
that or it is drawing an empty row — which is the point. The bug this replaced
was never that one check was wrong; it was that there were several, and they
disagreed about folders locked *after* the app had been opened.

### 11.2 What it looks like

- **A protected row keeps its place.** It stays where it was in the list and
  becomes a locked row: an accent tile, a padlock, and "Tap to unlock".
- **A folder shows its name; a link or a note does not.** A folder name is the
  label on the lock, not what is behind it — `Private` is tappable, an anonymous
  "Locked folder" is not, and without it the share destination picker could not
offer a locked folder as a destination at all. Content is the opposite: a locked
  link has no address and a locked note has no title on disk, so a locked row
  shows the noun (`Locked note`, `Locked link`).
- **Lock state is a word and a small glyph, never a banner.** `Private 🔒` on a
  row, `Protected` under a folder's title. No warnings, no red, no full-width
  notice about privacy.
- **Stash has no lock screen, and asking for a password to open it is a bug.**
  The app opens like any other app. Nothing on the way in is gated: launching,
  Home, the Library, an unlocked folder, search over unlocked content, creating a
  folder and saving an ordinary link all happen with no prompt, no matter how many
  locked folders the vault contains.
- **Tapping a protected row is what raises the system prompt** — `BiometricPrompt`
  (which offers the phone's PIN/pattern for free) on Android, Windows Hello on a
  PC. It is the app's only prompt, and it appears where the user pointed. The
  dialog (`lock-gate.tsx`) is a *reveal* prompt, never a gate: it is shown when a
  tap was not answered, which is also the only moment a message about a cancelled
  or failed prompt belongs on screen. It must not depend on whether the vault key
  is already in memory — access is per folder, so being inside one open boundary
  says nothing about the next one, and a refusal on the second folder has to be
  visible.
- **An open boundary lasts for the session.** It ends on the next tab change and
  the moment the app stops being on screen — what "they locked the phone" looks
  like from inside — so there is no timeout to configure and no copy may imply the
  unlock is permanent. The one navigation exempted is the one the unlock itself
  caused (opening the folder that was just unlocked), exempted by the grace window
in `src/lib/privacy/session.ts` rather than by a rule the user has to understand.
- **A share is never behind the prompt.** Saving a shared link is an ordinary
  capture; it must work with locked folders present and must never open, or wait
  on, an unlock. The one exception is deliberate and is the user's own choice:
  picking a protected folder *as the destination* asks for the prompt, at that
  moment and nowhere else. A protected folder is never pre-selected as the
  destination, and the write itself re-checks the boundary, so a stale recent
  destination cannot file a link behind a lock.
- **Counts are listings.** A hidden folder gets no stats entry, a hidden link is
  not counted into its ancestor, and a hidden link's tags do not appear in the tag
  shelf. "3 links" beside something the user cannot open says as much as the row
  would have.
- **There is exactly one way in, and no passcode.** Stash keeps no passcode of
  its own — no setup screen offers one, no settings row adds or changes one, and
  no copy may imply one exists. The system prompt is the gate the device already
  trusts, and someone who cannot pass it does not read the locked items; that is
  the design, not a gap in it. The one exception is a vault created by an older
  build, whose key is wrapped by a passcode and by nothing else: its gate shows a
  passcode field, because that field is the only thing standing between the user
  and permanently unreadable content. Nothing writes a passcode any more, so the
  copy must speak about it in the past tense ("the passcode this vault was
  created with").
- **Name the platform dialog.** "Windows Hello or your device PIN" on a PC,
  "your fingerprint, face or phone PIN" on a phone. Never "biometrics".
- **Say what it costs, at the moment it is chosen.** A vault locked by the device
  alone has no second way in and no reset, and a backup of it carries no key:
  the copy says so beside the button, not in a help page. Two consequences are
  stated wherever they bite — clearing the app's data or losing the device makes
  locked items unreadable forever, and a backup written by such a vault can only
  open its locked items on the device that wrote it.- Protected content never appears in search results, is never offered as a *content* destination, and is never used for duplicate detection. A protected **folder** is offered as a destination — labelled with a padlock — because filing something into `Private` is a normal thing to want and the prompt that follows is the point of the lock.
- A deep link into a protected folder (`?folder=…`, a restored navigation, a favourite chip) asks the same question as walking in: the boundary for that folder's lock root, granted or refused, with no way to arrive inside one around it.
- **The folder's name survives locking; nothing inside it does.** A row written by an older build whose name was ciphertext is opened by `reconcileProtection` the first time a key is available, so the migration is the same code path that keeps sealing in step with the flags — not a special case.

## 12. Motion

Four animations exist, each with a physical origin. Every one answers "what does
this help the user understand?":

| Animation        | Where                        | What it explains                        |
| ---------------- | ---------------------------- | --------------------------------------- |
| `animate-sheet-in` | sheets open                | the surface rises from the bottom edge  |
| `animate-pop-in`   | dialogs, the boot mark     | it came from where you tapped           |
| `animate-rise`     | toasts                     | a confirmation arrived                  |
| `animate-overlay-in`| scrims                   | the page is now behind the overlay      |

(Two more exist and are not decoration: the locked row's spinner, which explains
that the platform prompt is open, and the boot mark's single pulse.)

Rules:

- Easing is `cubic-bezier(0.32, 0.72, 0, 1)`; durations 160–240ms in, 160–180ms
  out. Nothing overshoots — bounce reads as dated.
- Tap feedback is `tap` + `tap-scale` (a 0.975 press), never hover.
- No page-load animation, no stagger, no ambient motion.
- `prefers-reduced-motion` collapses everything to ~0ms, globally. That rule is
  not optional and must not be scoped away.

---

## 13. Accessibility

- Touch targets: ≥44px (`size-11`, `h-11`, `min-h-11`) for anything a thumb
  presses; icon-only buttons carry `aria-label`.
- Contrast: body text uses `text-fg` or `text-muted`; `text-subtle` is never
  used for something the user must read to act.
- Focus: one visible focus ring (`:focus-visible`, 2px accent, 2px offset).
  No component may remove it.
- Semantics: `nav`/`header`/`main`, `aria-current` on the active tab,
  `aria-pressed` on toggles, real `button` elements for actions.
- Sheets and dialogs get titles and descriptions (Radix wire-up) and trap focus.
- Font scaling: layout is built from rows and truncation, so a larger system
  font grows text without breaking structure. Never set a fixed pixel height on
  a text element.
- Status is never colour alone: a locked link is a lock glyph *and* coloured; a
  dead link is a struck-through icon *and* `danger`.

---

## 14. Empty, loading and error states

- An empty screen says one useful sentence and offers the action that fills it.
  No illustration, no "0 items" statistics.
- It may carry **one** accent tile with the screen's own glyph. It is one of the
  two sanctioned exceptions in §2, and it works for the same reason the locked
  row does: the accent means "this is the thing asking for you", and on a screen
  with nothing on it, that is exactly what the empty state is.
- Copy is written, not generated: "Nothing waiting to be organized.",
  "Save something worth coming back to.", "Start with a thought."
- Loading is a single quiet pulse (the boot mark). Never a spinner wall, never
  skeleton cards.
- Errors are stated plainly with a next step, in `danger` ink. No codes, no
  "oops".

---

## 15. The signature interaction: capture

`Share sheet → Stash → choose destination → saved` is the most important path in
the product and gets the most care:

- An incoming share takes over the screen — no Home flash first, no app chrome.
- The shared content is shown at the top, then **Inbox**, then recent
  destinations, then the folder tree, then **Create folder**.
- Saving is 1–3 interactions. Inbox is always first and always one tap.
- Confirmation is a toast that also offers Undo where undo is safe.
- After saving, the capture surface returns to a neutral state so the next
  normal launch shows Home, never a stale share.

---

## 16. Checking a change against this document

Before calling UI work done:

1. Remove the borders (mentally): is the hierarchy still legible?
2. Count containers: does each one *say* something a hairline could not?
3. Count radii: more than three shapes on a screen means the vocabulary leaked.
4. Count colours: is every non-neutral colour an **identity** (from
   `identityColor` / `domainColor`) or the accent? A literal `bg-id-*` at a call
   site is a bug even when it looks right.
5. Count tiles: is each one labelling a *thing*, rather than decorating a
   heading, a button or a nav item?
6. Count animations: does each one explain a physical relationship?
7. Read the copy out loud: is it the app talking, or a template?
8. Check it at 390px **and** at 1440px. The phone must not have regressed, the
   desktop must not be a stretched phone, and the tab bar must be gone above `lg`.
9. Tab through it, then read it at 200% font scale.
10. Typecheck, lint, test, build (`tsc --noEmit`, `eslint .`, `vitest run`,
    `next build`; then `npm run cap:sync` and `npm run android:apk` if the change
    touched tokens, icons or brand assets).

If a screen passes all ten, it belongs in this app.
