# Google Drive sync — setup and operation

This is the manual half of sync. The code is complete and tested against a fake
Drive; a live run needs OAuth client identifiers from **your own** Google Cloud
project. Nothing in this repository contains one.

The same Cloud project must own both clients (web and Android). Stash's data
lives in the user's hidden `appDataFolder`, which is scoped to the OAuth client
project: two clients from different projects cannot see each other's files, so
mixing projects silently produces "two empty vaults" rather than an error.

There is **no client secret** on either platform, and none may be added. The web
flow is Google Identity Services' token flow; Android is the RFC 8252
installed-app flow with PKCE. Both are public clients by design.

## 1. Google Cloud project

1. Open <https://console.cloud.google.com/> and create (or select) a project.
2. **APIs & Services → Library → Google Drive API → Enable.**
3. **APIs & Services → OAuth consent screen** (in the newer console this is
   **Google Auth Platform → Branding / Audience**):
   - User type: **External**, unless every user is in one Workspace organisation,
     in which case **Internal** is simpler and needs no verification.
   - Fill in app name, user support email and developer contact email.
   - Add the scopes the app requests:
     - `openid`
     - `email`
     - `https://www.googleapis.com/auth/drive.appdata`
   - While the app is in **Testing**, add every Google account that will test it
     under **Test users**. Accounts not on the list get `access_denied`.
   - `drive.appdata` is a Google-classified sensitive scope. For a public
     External app, Google may require OAuth verification (and a privacy policy
     URL) before non-test users can consent. Personal use with test users does
     not need it.

Stash requests **only** `drive.appdata` for Drive. It cannot list or read the
user's normal Drive files, and it never asks for `drive`, `drive.readonly` or
`drive.file`.

## 2. Create the two OAuth clients

**APIs & Services → Credentials → Create credentials → OAuth client ID.**

### Web client

- Application type: **Web application**.
- **Authorized JavaScript origins** — exact origins, no path, no trailing slash:
  - `http://localhost:3000` for `npm run dev`
  - `https://getstash.web.app` for the Firebase Hosting deployment
  - any additional production origin that serves the static build
- No authorized redirect URI is needed: GIS returns the token to the page via its
  own callback and never navigates to a redirect URI.
- Copy the client id; it is used as `NEXT_PUBLIC_GOOGLE_CLIENT_ID`.
- The downloadable `client_secret_*.json` also contains a client secret. Stash
  never reads that file, never copies the secret into the repository or bundle,
  and the GIS token flow does not use it.

The build is a static export (`out/`). The client id is baked in at build time, so
a hosted copy built without it will report "not configured" no matter what the
host's runtime environment says.

### Android client

- Application type: **Android**.
- Package name: **`app.web.Stash`** (must match `applicationId` in
  `android/app/build.gradle` and `appId` in `capacitor.config.ts`).
- SHA-1 certificate fingerprint of the signing key used to install the APK.
  - Debug keystore, Windows:
    ```bat
    keytool -list -v -keystore "%USERPROFILE%\.android\debug.keystore" ^
      -alias androiddebugkey -storepass android -keypass android
    ```
    macOS/Linux:
    ```sh
    keytool -list -v -keystore ~/.android/debug.keystore \
      -alias androiddebugkey -storepass android -keypass android
    ```
  - For a release APK, add the release keystore's SHA-1 as a **second** Android
    client (or replace the fingerprint). A debug-only client makes release
    builds fail with `invalid_client`.
  - If you use Play App Signing, also add the SHA-1 shown in the Play Console.
- **Advanced settings → Enable custom URI scheme.** New Android clients have this
  turned off. If it stays off, Google rejects the authorization request with
  `Custom URI scheme is not enabled for your Android client` before showing
  consent. The toggle is what allows the system browser to return to Stash. It
  does not weaken the code exchange: redeeming an authorization code still needs
  the per-request PKCE verifier, which never leaves the app.
- No redirect URI is registered. Google's installed-app convention is a reverse
  client id scheme derived in `src/lib/sync/google-config.ts`:
  `com.googleusercontent.apps.<client-prefix>:/oauth2redirect`.
  Gradle derives the same value for the `AndroidManifest.xml` intent filter from
  the client id, so the manifest and the JavaScript cannot drift.
- Copy the client id; it is used as `NEXT_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`.

The Android application may ask for the consent screen even though the app has a
WebView: authorization happens in the **system browser**, not in the WebView, and
the redirect returns to the app through the registered scheme.

### Why the IDs are not interchangeable

- **Web** uses the Web-application client with Google Identity Services'
  `initTokenClient`. GIS requires an authorized JavaScript origin; it returns an
  access token to the page and never uses the downloaded client secret.
- **Android** uses the installed/native client with the RFC 8252 authorization-code
  flow plus PKCE. The redirect is the client's reverse-id custom scheme, and the
  code exchange is a public-client request with a `code_verifier`.
- This Android flow does **not** use the web client as a `serverClientId`. That
  parameter belongs to the Google Sign-In Android SDK's ID-token flow, which Stash
  does not use. Passing the web client id here would not be correct.
- Both IDs live in the same Google Cloud project (`getstash-app`), which is what
  makes the same `appDataFolder` visible from both platforms.

## 3. Build and run

### Web

Create `.env.local` in the repository root (it is git-ignored; only public client
ids belong in it):

```dotenv
NEXT_PUBLIC_GOOGLE_CLIENT_ID=1234567890-xxxxxxxx.apps.googleusercontent.com
NEXT_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=1234567890-yyyyyyyy.apps.googleusercontent.com
```

Do not paste either downloaded `client_secret_*.json` here, and do not commit
those files. The Android client is an installed/native client and has no secret.
A single static bundle serves both platforms, so both **public** ids are present
at build time; the web runtime reads only the web id, and the Android runtime
reads only the Android id. Neither id is a secret.

Then:

```sh
npm run build
```

Serve `out/` from one of the origins registered above. With `npm run dev`, use
`http://localhost:3000` (GIS also accepts `http://localhost` with other ports
only if that exact origin is registered).

### Android

The Android client id has to reach **two** build steps: the JavaScript bundle and
Gradle's manifest placeholder. Either export the variable for both or pass it
explicitly:

```sh
export NEXT_PUBLIC_GOOGLE_CLIENT_ID=...
export NEXT_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=...
npm run build
npx cap sync android
npm run android:apk
```

`npm run android:apk` reads `.env.local` itself and passes the public Android id
to Gradle, so the same file configures both the JS bundle and the manifest
scheme. Gradle also accepts `STASH_GOOGLE_ANDROID_CLIENT_ID` or
`-PgoogleAndroidClientId=...`; an explicitly exported value wins over the file.
If no id is set, the manifest gets a private inactive scheme and the app still
builds; Connect then reports that Android sync is not configured instead of
failing at startup. Install the resulting debug APK
(`android/app/build/outputs/apk/debug/app-debug.apk`).

Requirements: Node 20+, JDK 21 for the Android build, Android SDK (compile SDK as
configured in `android/variables.gradle`).

### Account setup in the app

Settings → **Google Drive sync**:

1. **Connect** and choose the Google account.
2. **Sync now** once to publish the local vault.
3. Set up a **recovery key** if the vault contains locked folders and it should
   be readable on another device (see §6).
4. On the second device, connect the **same** Google account and sync.

Only one Stash account profile is expected per Google account: the hidden
`appDataFolder` belongs to the person, and all devices signed into that account
share it.

## 4. What is created in Drive

Everything is inside `appDataFolder`; nothing appears in the normal Drive UI:

```
stash-sync-v1-device-<deviceId>.json              mutable per-device manifest
stash-sync-v1-chunk-<deviceId>-<seq>-<hash>.json  immutable content chunks
stash-sync-v1-keyring-<fingerprint>.json          recovery wraps (ciphertext)
```

To inspect it, call the API with a token that has `drive.appdata`:

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name,size,modifiedTime)"
```

The app itself needs only `https://www.googleapis.com/auth/drive.appdata`. Do not
add broader scopes to make inspection easier.

## 5. Errors you can see, and what they mean

The UI shows sanitized states, never a token, note body or client configuration.

| State | Likely cause |
| --- | --- |
| "not configured in this build" | `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (web) or `NEXT_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` (Android) was missing when the bundle was built. Rebuild; runtime env changes do nothing. |
| "Google rejected this app configuration" (`invalid_client`, `unauthorized_client`) | Wrong client id for the platform, or Android package/SHA-1 does not match the installed APK. |
| `origin_mismatch` in the Google window | The page origin is not listed under the **Web** client’s Authorized JavaScript origins. Add the exact origin, with scheme and port, e.g. `http://localhost:3000` and `https://getstash.web.app`. |
| “Access blocked / `invalid_request`: Custom URI scheme is not enabled for your Android client” | The Android client’s custom-scheme redirect is disabled. Edit the Android OAuth client → **Advanced settings** → enable **Custom URI scheme** → Save. Recreate the client if the setting is not offered. |
| `redirect_uri_mismatch` on Android | Client id used for Gradle differs from the one in the bundle, or the client is not an Android client. Check `NEXT_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` for both steps. |
| `access_denied` / "cancelled" | The user closed the consent window, or the account is not a test user while the consent screen is in Testing. |
| `accessNotConfigured` / 403 | Google Drive API not enabled in the project. |
| 401 after an hour | Access token expired; the app refreshes once silently. On the web, GIS can usually mint a new one; on Android the stored refresh token is used. If the grant was revoked, Connect again. |
| 429 / 5xx | Retried automatically with exponential backoff and jitter; the UI stays offline/error rather than losing data. |
| "another Google account" | The connected account no longer matches the account recorded for this vault. Disconnect and connect the original account, or erase to start a new vault under the new account. Stash never mixes two accounts' change history. |
| Quota exceeded | Drive storage full or a project quota; free space or wait. Local editing remains fully available. |

## 6. Locked folders and recovery keys

Google sign-in moves ciphertext only. A locked folder stays locked on every
device until that device has the vault key **and** the platform prompt succeeds.

- A device that already has the key: Android asks for biometrics/device
  credential; the Windows web app asks for Windows Hello (WebAuthn platform
  authenticator). Cancelling leaves the folder locked.
- A new device: sync delivers sealed rows, but they cannot be decrypted. In
  Settings → Google Drive sync → **Recovery key**, enter the recovery key created
  on the first device. The key unwraps the vault key, the device wrap is
  installed, and a WebAuthn credential is enrolled first on the web (Windows
  Hello PIN/fingerprint). Locked folders then prompt normally.
- The recovery key is 160 bits, shown once, and held only by the user. It is not
  a password, is not sent to Google in usable form, and cannot be reset by Stash.
  Losing every unlocked device **and** the recovery key makes the sealed content
  permanently unreadable; plaintext rows still sync normally.
- If Windows Hello is reset, the platform credential disappears while the wrapped
  key may remain. Entering the recovery key re-enrolls the credential and repairs
  the device wrap; it does not lower the lock.
- Changing the Google account does not carry the vault key. Use the recovery key
  on the new account's device as usual.

## 7. Release checklist

- [ ] Web production origin registered as an authorized JavaScript origin, served
      over HTTPS.
- [ ] Android release signing SHA-1 registered as an Android OAuth client for
      `app.web.Stash`.
- [ ] Both client ids built into the same release artifact set from the same
      Google Cloud project.
- [ ] Consent screen published (or test users maintained) and the privacy policy
      URL supplied if Google requires verification.
- [ ] No client secret exists in the repository, the bundle, Gradle files, or CI.
- [ ] A backup export has been taken and a restore tested before the first real
      sync with a populated vault.
- [ ] Recovery key created and stored somewhere safe for any vault with locked
      folders.

## 8. Manual verification that cannot be automated here

Automated tests use an in-memory transport and a fake Drive; they prove protocol,
merge and failure behavior, not Google's acceptance of a client. To verify live:

1. Sign in on the web with a test user; the consent screen must list exactly
   "See, edit, create, and delete only its own app data folder in Google Drive".
2. Create a link, a folder, a note and a tag; **Sync now**; confirm success and a
   timestamp.
3. Install the Android APK, connect the same account, **Sync now**; confirm the
   same rows appear.
4. Turn off network on one device, edit offline, restore network, sync both;
   confirm the edit survives and appears on the other device.
5. Edit the same note field on both while offline, sync, and confirm the losing
   version appears as a visible conflict (note copy or review record), not lost
   data.
6. Lock a folder containing a note and link; sync; confirm the other device shows
   the folder locked and cannot search or preview the contents. Unlock on one
   device and confirm the other stays locked until its own prompt is satisfied.
7. Kill the app between upload and completion (or disable network mid-sync),
   reopen, sync again; confirm no duplication and no missing row.
