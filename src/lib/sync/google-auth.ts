import { SyncTransportError } from './transport';
import {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_REVOCATION_ENDPOINT,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
  hasDriveScope,
  requireAndroidClient,
  requireWebClientId,
  scopeString,
} from './google-config';

/**
 * Google sign-in, separated from Drive.
 *
 * The rest of sync only ever asks for an access token. Two platform flows sit
 * behind that question:
 *
 *  - the web uses Google Identity Services, which returns a short-lived token to
 *    JavaScript without ever putting a secret in the bundle;
 *  - Android uses the RFC 8252 installed-app flow with PKCE: the system browser
 *    performs the authorization, no client secret exists, and the code exchange
 *    runs through a small native HTTP bridge so a WebView origin cannot break it
 *    with CORS.
 *
 * Access tokens live in module memory only and are never written to IndexedDB,
 * a log, an error message or a backup. On Android the refresh token is the one
 * credential that outlives the process; it goes into the Keystore-backed
 * platform store, never into the vault, and is revoked and removed on
 * disconnect. The web needs none: GIS can mint a fresh token silently for an
 * account the person has already approved.
 */

export interface GoogleAccount {
  /** Google's stable subject id. Identity is this, never the email. */
  sub: string;
  email: string;
  name?: string;
}

export interface GoogleAuthSession {
  readonly platform: 'web' | 'android';
  /** Explicit Connect. Always asks Google, so account switching is deliberate. */
  connect(): Promise<GoogleAccount>;
  /** Startup/resume path: reuse an existing grant, or return null quietly. */
  silentAccount(): Promise<GoogleAccount | null>;
  /** A token for one request. Never cached by callers across sessions. */
  accessToken(): Promise<string>;
  disconnect(): Promise<void>;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  scope?: string;
}

const TOKEN_SAFETY_WINDOW_MS = 60_000;
const AUTH_TIMEOUT_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function tokenError(fields: { error?: string; error_description?: string }): SyncTransportError {
  const error = fields.error ?? '';
  if (error === 'invalid_grant') {
    return new SyncTransportError(
      'auth-required',
      'Google sign-in has expired. Connect again to continue syncing.',
    );
  }
  if (error === 'invalid_client' || error === 'unauthorized_client') {
    return new SyncTransportError(
      'missing-config',
      'Google rejected this app configuration. Check the OAuth client id and redirect URI.',
    );
  }
  return new SyncTransportError(
    'auth-required',
    'Google sign-in did not complete. Connect again to continue syncing.',
  );
}

function scopedOrThrow(token: CachedToken): CachedToken {
  if (!hasDriveScope(token.scope)) {
    throw new SyncTransportError(
      'auth-required',
      'Stash needs permission to manage its own Google Drive app data. Connect again and allow that access.',
    );
  }
  return token;
}

function cachedFrom(
  response: { access_token?: string; expires_in?: number; scope?: string },
  now = Date.now(),
): CachedToken | null {
  if (!response.access_token) return null;
  const lifetime = typeof response.expires_in === 'number' && response.expires_in > 0
    ? response.expires_in
    : 3_000;
  return {
    accessToken: response.access_token,
    expiresAt: now + lifetime * 1_000,
    scope: response.scope,
  };
}

function isFresh(token: CachedToken): boolean {
  return token.expiresAt - Date.now() > TOKEN_SAFETY_WINDOW_MS;
}

async function fetchAccount(accessToken: string): Promise<GoogleAccount> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new SyncTransportError('network', 'Could not reach Google to confirm the signed-in account.');
  }
  if (response.status === 401) {
    throw new SyncTransportError('auth-required', 'Google sign-in has expired. Connect again.');
  }
  if (!response.ok) {
    throw new SyncTransportError('network', 'Could not read the signed-in Google account.');
  }
  const body = (await response.json().catch(() => null)) as {
    sub?: unknown;
    email?: unknown;
    name?: unknown;
  } | null;
  if (!body || typeof body.sub !== 'string' || typeof body.email !== 'string') {
    throw new SyncTransportError('auth-required', 'Google did not return a usable account identity.');
  }
  const account: GoogleAccount = { sub: body.sub, email: body.email };
  if (typeof body.name === 'string' && body.name.length > 0) account.name = body.name;
  return account;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomUrlToken(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256. Exported so the native flow can be tested without a browser. */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomUrlToken(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function buildAndroidAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  loginHint?: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: scopeString(),
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    state: input.state,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  if (input.loginHint) params.set('login_hint', input.loginHint);
  return `${GOOGLE_AUTHORIZATION_ENDPOINT}?${params.toString()}`;
}

export function parseAndroidRedirect(
  url: string,
  expectedState: string,
): { code: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SyncTransportError('auth-cancelled', 'Google sign-in returned an unreadable response.');
  }
  const error = parsed.searchParams.get('error');
  if (error) {
    throw new SyncTransportError(
      error === 'access_denied' ? 'auth-cancelled' : 'auth-required',
      error === 'access_denied'
        ? 'Google sign-in was cancelled.'
        : 'Google sign-in did not complete. Try again.',
    );
  }
  const state = parsed.searchParams.get('state');
  const code = parsed.searchParams.get('code');
  if (!state || state !== expectedState || !code) {
    throw new SyncTransportError(
      'auth-required',
      'Google sign-in response could not be verified. Try connecting again.',
    );
  }
  return { code };
}

/**
 * Read the identity Google returned alongside the token.
 *
 * The token response arrived directly from Google over TLS, which is what makes
 * reading the payload sufficient here; this is not a general-purpose JWT
 * verifier and must never be used to validate a token from any other source.
 */
export function accountFromIdToken(idToken: string | undefined): GoogleAccount | null {
  if (!idToken) return null;
  const segment = idToken.split('.')[1];
  if (!segment) return null;
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
      sub?: unknown;
      email?: unknown;
      name?: unknown;
    };
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;
    const account: GoogleAccount = { sub: payload.sub, email: payload.email };
    if (typeof payload.name === 'string' && payload.name.length > 0) account.name = payload.name;
    return account;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Web: Google Identity Services
// ---------------------------------------------------------------------------

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GisTokenClient {
  requestAccessToken(overrides?: { prompt?: string; login_hint?: string }): void;
}

interface GisError {
  type?: string;
  message?: string;
}

interface GisOauth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (response: GisTokenResponse) => void;
    error_callback: (error: GisError) => void;
  }): GisTokenClient;
  revoke(token: string, done: () => void): void;
}

interface GisGlobal {
  accounts: { oauth2: GisOauth2 };
}

let gisPromise: Promise<GisOauth2> | null = null;

function loadGis(): Promise<GisOauth2> {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise<GisOauth2>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new SyncTransportError('missing-config', 'Google sign-in is only available in the app.'));
      return;
    }
    const existing = (window as { google?: GisGlobal }).google;
    if (existing?.accounts?.oauth2) {
      resolve(existing.accounts.oauth2);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    const timer = window.setTimeout(() => {
      reject(new SyncTransportError('network', 'Google sign-in could not be loaded. Check the connection.'));
    }, 15_000);
    script.onload = () => {
      window.clearTimeout(timer);
      const loaded = (window as { google?: GisGlobal }).google;
      if (loaded?.accounts?.oauth2) resolve(loaded.accounts.oauth2);
      else reject(new SyncTransportError('network', 'Google sign-in could not be loaded.'));
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new SyncTransportError('network', 'Google sign-in could not be loaded. Check the connection.'));
    };
    document.head.appendChild(script);
  });
  // A transient script failure must not poison every later attempt.
  gisPromise.catch(() => {
    gisPromise = null;
  });
  return gisPromise;
}

class WebGoogleAuth implements GoogleAuthSession {
  readonly platform = 'web' as const;
  private token: CachedToken | null = null;
  private account: GoogleAccount | null = null;
  private inFlight: Promise<CachedToken> | null = null;

  async connect(): Promise<GoogleAccount> {
    const token = await this.requestToken(true);
    const account = await fetchAccount(token.accessToken);
    this.token = token;
    this.account = account;
    return account;
  }

  async silentAccount(): Promise<GoogleAccount | null> {
    try {
      const token = this.token && isFresh(this.token) ? this.token : await this.requestToken(false);
      this.token = token;
      if (this.account) return this.account;
      this.account = await fetchAccount(token.accessToken);
      return this.account;
    } catch {
      return null;
    }
  }

  async accessToken(): Promise<string> {
    const token = this.token && isFresh(this.token) ? this.token : await this.requestToken(false);
    this.token = token;
    return token.accessToken;
  }

  async disconnect(): Promise<void> {
    const token = this.token;
    this.token = null;
    this.account = null;
    if (!token) return;
    try {
      const oauth2 = await loadGis();
      await new Promise<void>((resolve) => {
        oauth2.revoke(token.accessToken, () => resolve());
      });
    } catch {
      // Local sign-out is complete even if Google could not be reached. The
      // access token expires on its own and no token was persisted.
    }
  }

  private async requestToken(interactive: boolean): Promise<CachedToken> {
    if (this.inFlight) return this.inFlight;
    const work = this.runTokenRequest(interactive);
    this.inFlight = work;
    try {
      return await work;
    } finally {
      this.inFlight = null;
    }
  }

  private async runTokenRequest(interactive: boolean): Promise<CachedToken> {
    const clientId = requireWebClientId();
    const oauth2 = await loadGis();
    const response = await new Promise<GisTokenResponse>((resolve, reject) => {
      const client = oauth2.initTokenClient({
        client_id: clientId,
        scope: scopeString(),
        callback: (value) => resolve(value),
        error_callback: (error) => {
          const type = error.type ?? '';
          if (type === 'popup_closed' || type === 'access_denied') {
            reject(new SyncTransportError('auth-cancelled', 'Google sign-in was cancelled.'));
            return;
          }
          reject(
            new SyncTransportError(
              'auth-required',
              interactive
                ? 'Google sign-in did not complete. Try again.'
                : 'Google sign-in needs your attention. Use Connect to sign in again.',
            ),
          );
        },
      });
      try {
        client.requestAccessToken({ prompt: interactive ? 'consent' : '' });
      } catch {
        reject(new SyncTransportError('auth-required', 'Google sign-in could not be started.'));
      }
    });

    if (response.error) throw tokenError(response);
    const token = cachedFrom({
      access_token: response.access_token,
      expires_in: typeof response.expires_in === 'string' ? Number(response.expires_in) : response.expires_in,
      scope: response.scope,
    });
    if (!token) {
      throw new SyncTransportError('auth-required', 'Google did not return an access token.');
    }
    return scopedOrThrow(token);
  }
}

// ---------------------------------------------------------------------------
// Android: system browser + PKCE + native token exchange
// ---------------------------------------------------------------------------

interface NativeGoogleAuthPlugin {
  request(options: { url: string; body: string }): Promise<{ status: number; body: string }>;
}

let nativePluginPromise: Promise<NativeGoogleAuthPlugin> | null = null;

async function nativePlugin(): Promise<NativeGoogleAuthPlugin> {
  if (nativePluginPromise) return nativePluginPromise;
  nativePluginPromise = (async () => {
    const { registerPlugin } = await import('@capacitor/core');
    return registerPlugin<NativeGoogleAuthPlugin>('GoogleAuth');
  })();
  return nativePluginPromise;
}

interface TokenEndpointResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function nativeTokenRequest(body: URLSearchParams): Promise<TokenEndpointResponse> {
  let response: { status: number; body: string };
  try {
    const plugin = await nativePlugin();
    response = await plugin.request({ url: GOOGLE_TOKEN_ENDPOINT, body: body.toString() });
  } catch {
    throw new SyncTransportError('network', 'Could not reach Google to finish signing in.');
  }
  let parsed: TokenEndpointResponse | null = null;
  try {
    parsed = JSON.parse(response.body) as TokenEndpointResponse;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    throw new SyncTransportError('network', 'Google sign-in returned an unreadable response.');
  }
  if (response.status < 200 || response.status >= 300 || parsed.error) throw tokenError(parsed);
  return parsed;
}

async function nativeRevoke(token: string): Promise<void> {
  try {
    const plugin = await nativePlugin();
    await plugin.request({
      url: GOOGLE_REVOCATION_ENDPOINT,
      body: new URLSearchParams({ token }).toString(),
    });
  } catch {
    // Sign-out locally is still complete; the grant can be removed from the
    // Google account page and the token expires on its own.
  }
}

const REFRESH_TOKEN_KEY = 'stash.google.driveRefreshToken';

async function readRefreshToken(): Promise<string | null> {
  const { getSecureStore } = await import('@/lib/privacy/secure-store');
  const store = await getSecureStore();
  if (store.kind !== 'native') return null;
  return store.get(REFRESH_TOKEN_KEY);
}

async function writeRefreshToken(token: string | null): Promise<void> {
  const { getSecureStore } = await import('@/lib/privacy/secure-store');
  const store = await getSecureStore();
  if (store.kind !== 'native') return;
  if (token) await store.set(REFRESH_TOKEN_KEY, token);
  else await store.remove(REFRESH_TOKEN_KEY);
}

class AndroidGoogleAuth implements GoogleAuthSession {
  readonly platform = 'android' as const;
  private token: CachedToken | null = null;
  private account: GoogleAccount | null = null;
  private inFlight: Promise<CachedToken> | null = null;

  async connect(): Promise<GoogleAccount> {
    const { clientId, redirectUri } = requireAndroidClient();
    const { verifier, challenge } = await createPkcePair();
    const state = randomUrlToken(16);
    const authUrl = buildAndroidAuthUrl({ clientId, redirectUri, challenge, state });
    const code = await openAndWaitForCode(authUrl, redirectUri, state);
    const response = await nativeTokenRequest(
      new URLSearchParams({
        client_id: clientId,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    );

    if (response.refresh_token) await writeRefreshToken(response.refresh_token);
    const token = cachedFrom(response);
    if (!token) throw new SyncTransportError('auth-required', 'Google did not return an access token.');
    const account = accountFromIdToken(response.id_token) ?? (await fetchAccount(token.accessToken));
    this.token = scopedOrThrow(token);
    this.account = account;
    return account;
  }

  async silentAccount(): Promise<GoogleAccount | null> {
    try {
      const token = await this.tokenForRequest(false);
      if (this.account) return this.account;
      this.account = await fetchAccount(token.accessToken);
      return this.account;
    } catch {
      return null;
    }
  }

  async accessToken(): Promise<string> {
    const token = await this.tokenForRequest(false);
    return token.accessToken;
  }

  async disconnect(): Promise<void> {
    const refresh = await readRefreshToken();
    const access = this.token?.accessToken;
    await writeRefreshToken(null);
    this.token = null;
    this.account = null;
    if (refresh) await nativeRevoke(refresh);
    else if (access) await nativeRevoke(access);
  }

  private async tokenForRequest(interactive: boolean): Promise<CachedToken> {
    if (this.token && isFresh(this.token)) return this.token;
    if (interactive) {
      // Kept for symmetry with the session interface; explicit connect() is the
      // interactive path on Android.
      throw new SyncTransportError('auth-required', 'Use Connect to sign in to Google Drive.');
    }
    if (this.inFlight) return this.inFlight;
    const work = this.refresh();
    this.inFlight = work;
    try {
      return await work;
    } finally {
      this.inFlight = null;
    }
  }

  private async refresh(): Promise<CachedToken> {
    const { clientId } = requireAndroidClient();
    const refreshToken = await readRefreshToken();
    if (!refreshToken) {
      throw new SyncTransportError(
        'auth-required',
        'Google sign-in has expired. Connect again to continue syncing.',
      );
    }
    let response: TokenEndpointResponse;
    try {
      response = await nativeTokenRequest(
        new URLSearchParams({
          client_id: clientId,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      );
    } catch (error) {
      if (error instanceof SyncTransportError && error.code === 'auth-required') {
        await writeRefreshToken(null);
      }
      throw error;
    }
    const token = cachedFrom(response);
    if (!token) {
      await writeRefreshToken(null);
      throw new SyncTransportError('auth-required', 'Google sign-in has expired. Connect again.');
    }
    this.token = scopedOrThrow(token);
    return this.token;
  }
}

async function openAndWaitForCode(
  authUrl: string,
  redirectUri: string,
  expectedState: string,
): Promise<string> {
  const [{ Browser }, { App }] = await Promise.all([
    import('@capacitor/browser'),
    import('@capacitor/app'),
  ]);

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let browserClosed: ReturnType<typeof setTimeout> | null = null;
    const listeners: Array<{ remove: () => Promise<void> }> = [];
    const timer = setTimeout(() => {
      void finish(new SyncTransportError('auth-cancelled', 'Google sign-in timed out. Try again.'));
    }, AUTH_TIMEOUT_MS);

    const finish = async (error?: SyncTransportError, code?: string): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (browserClosed) clearTimeout(browserClosed);
      await Promise.all(listeners.map((listener) => listener.remove().catch(() => undefined)));
      await Browser.close().catch(() => undefined);
      if (error) reject(error);
      else if (code) resolve(code);
    };

    void (async () => {
      listeners.push(
        await App.addListener('appUrlOpen', ({ url }) => {
          if (!url.startsWith(redirectUri)) return;
          try {
            const { code } = parseAndroidRedirect(url, expectedState);
            void finish(undefined, code);
          } catch (error) {
            void finish(
              error instanceof SyncTransportError
                ? error
                : new SyncTransportError('auth-cancelled', 'Google sign-in was cancelled.'),
            );
          }
        }),
      );
      listeners.push(
        await Browser.addListener('browserFinished', () => {
          // The redirect normally arrives as appUrlOpen *and* closes the custom
          // tab. Cancelling immediately would race that intent and turn a
          // successful sign-in into a cancellation, so closing is only treated
          // as a cancel once the redirect has had time to be delivered.
          if (browserClosed) clearTimeout(browserClosed);
          browserClosed = setTimeout(() => {
            void finish(new SyncTransportError('auth-cancelled', 'Google sign-in was cancelled.'));
          }, 1_500);
        }),
      );
      try {
        await Browser.open({ url: authUrl, presentationStyle: 'popover' });
      } catch {
        void finish(new SyncTransportError('auth-cancelled', 'Could not open Google sign-in.'));
      }
    })().catch(() => {
      void finish(new SyncTransportError('auth-cancelled', 'Could not open Google sign-in.'));
    });
  });
}

// ---------------------------------------------------------------------------
// Platform selection
// ---------------------------------------------------------------------------

export function isNativeGoogleRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const capacitor = (window as {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }).Capacitor;
  if (!capacitor?.isNativePlatform?.()) return false;
  return capacitor.getPlatform?.() === 'android';
}

export function createGoogleAuthSession(): GoogleAuthSession {
  return isNativeGoogleRuntime() ? new AndroidGoogleAuth() : new WebGoogleAuth();
}

/** Test seam: proves the requested scope is the narrow app-data scope. */
export const GOOGLE_DRIVE_SCOPES = GOOGLE_SCOPES;
