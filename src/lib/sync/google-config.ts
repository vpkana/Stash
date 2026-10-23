import { SyncTransportError } from './transport';

/**
 * Public OAuth configuration.
 *
 * These are client *identifiers*, not secrets: Google's installed-app flow has
 * no client secret, and the web token flow exposes the client id to every
 * browser anyway. The identifiers are baked into the static build from
 * `NEXT_PUBLIC_*` variables; the setup guide in `docs/google-drive-setup.md`
 * lists the exact values Google Cloud expects.
 *
 * Both clients must belong to the same Google Cloud project so that the same
 * `appDataFolder` follows the person from the web app to Android.
 */
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/drive.appdata',
] as const;

export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

/** Keep the token exchange and Drive requests on Google's current endpoints. */
export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOCATION_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

const webClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim() ?? '';
const androidClientId = process.env.NEXT_PUBLIC_GOOGLE_ANDROID_CLIENT_ID?.trim() ?? '';

export interface GoogleClientConfig {
  webClientId: string;
  androidClientId: string;
}

export function googleClientConfig(): GoogleClientConfig {
  return { webClientId, androidClientId };
}

/**
 * The redirect an Android OAuth client uses.
 *
 * Google's Android clients are not configured with a redirect URI. The custom
 * scheme is the reverse of the client id, which is the convention AppAuth and
 * Google's own documentation use. The matching intent filter is declared in
 * `AndroidManifest.xml` and receives the same value through a Gradle manifest
 * placeholder at build time.
 */
export function androidRedirectUri(clientId: string): string {
  const prefix = clientId.replace(/\.apps\.googleusercontent\.com$/i, '');
  return `com.googleusercontent.apps.${prefix}:/oauth2redirect`;
}

export function requireWebClientId(): string {
  if (!webClientId) {
    throw new SyncTransportError(
      'missing-config',
      'Google Drive sync is not configured in this build. Add NEXT_PUBLIC_GOOGLE_CLIENT_ID and rebuild.',
    );
  }
  return webClientId;
}

export function requireAndroidClient(): { clientId: string; redirectUri: string } {
  if (!androidClientId) {
    throw new SyncTransportError(
      'missing-config',
      'Google Drive sync is not configured for Android in this build. Add NEXT_PUBLIC_GOOGLE_ANDROID_CLIENT_ID and rebuild.',
    );
  }
  return { clientId: androidClientId, redirectUri: androidRedirectUri(androidClientId) };
}

export function scopeString(): string {
  return GOOGLE_SCOPES.join(' ');
}

export function hasDriveScope(scope: string | undefined): boolean {
  if (!scope) return false;
  return scope.split(/\s+/).includes(DRIVE_APPDATA_SCOPE);
}
