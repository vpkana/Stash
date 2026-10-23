import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_DRIVE_SCOPES,
  accountFromIdToken,
  buildAndroidAuthUrl,
  createPkcePair,
  parseAndroidRedirect,
} from '@/lib/sync/google-auth';
import { androidRedirectUri, scopeString } from '@/lib/sync/google-config';
import { SyncTransportError } from '@/lib/sync/transport';

/**
 * Pure pieces of the sign-in flow. The browser and native hand-offs are not
 * simulated here; these tests pin the protocol shape that both platforms must
 * agree on (PKCE, state, narrow scope, redirect scheme).
 */

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function idToken(payload: Record<string, unknown>): string {
  return `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(
    JSON.stringify(payload),
  )}.signature`;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('PKCE', () => {
  it('derives an S256 challenge from a 256-bit verifier', async () => {
    const pair = await createPkcePair();

    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pair.verifier)),
    );
    let binary = '';
    for (const byte of digest) binary += String.fromCharCode(byte);
    expect(pair.challenge).toBe(btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    expect(pair.challenge).not.toBe(pair.verifier);
  });

  it('produces a fresh verifier every time', async () => {
    const first = await createPkcePair();
    const second = await createPkcePair();
    expect(first.verifier).not.toBe(second.verifier);
  });
});

describe('Android authorization request', () => {
  it('uses the installed-app redirect, offline access and the app-data scope', () => {
    const url = new URL(
      buildAndroidAuthUrl({
        clientId: '123-abc.apps.googleusercontent.com',
        redirectUri: 'com.googleusercontent.apps.123-abc:/oauth2redirect',
        challenge: 'challenge-value',
        state: 'state-value',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('123-abc.apps.googleusercontent.com');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'com.googleusercontent.apps.123-abc:/oauth2redirect',
    );
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toBe(
      'openid email https://www.googleapis.com/auth/drive.appdata',
    );
    expect(url.searchParams.get('client_secret')).toBeNull();
    expect(url.toString()).not.toContain('client_secret');
  });

  it('adds a login hint only when one is supplied', () => {
    const base = {
      clientId: 'client',
      redirectUri: 'com.googleusercontent.apps.client:/oauth2redirect',
      challenge: 'c',
      state: 's',
    };
    expect(new URL(buildAndroidAuthUrl(base)).searchParams.get('login_hint')).toBeNull();
    expect(
      new URL(buildAndroidAuthUrl({ ...base, loginHint: 'person@example.com' })).searchParams.get(
        'login_hint',
      ),
    ).toBe('person@example.com');
  });

  it('derives the reverse-client-id scheme Google expects', () => {
    expect(androidRedirectUri('123-abc.apps.googleusercontent.com')).toBe(
      'com.googleusercontent.apps.123-abc:/oauth2redirect',
    );
  });
});

describe('Android redirect handling', () => {
  const redirect = 'com.googleusercontent.apps.123-abc:/oauth2redirect';

  it('accepts a code whose state matches', () => {
    expect(parseAndroidRedirect(`${redirect}?code=auth-code&state=expected`, 'expected')).toEqual({
      code: 'auth-code',
    });
  });

  it('rejects a mismatched state instead of exchanging the code', () => {
    expect(() => parseAndroidRedirect(`${redirect}?code=auth-code&state=other`, 'expected')).toThrow(
      SyncTransportError,
    );
    try {
      parseAndroidRedirect(`${redirect}?code=auth-code&state=other`, 'expected');
    } catch (error) {
      expect(error).toMatchObject({ code: 'auth-required' });
    }
  });

  it('reports cancellation as a cancellation, not a failure to retry blindly', () => {
    try {
      parseAndroidRedirect(`${redirect}?error=access_denied&state=s`, 's');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({ code: 'auth-cancelled' });
    }
  });

  it('treats a response without a code as unusable', () => {
    expect(() => parseAndroidRedirect(`${redirect}?state=s`, 's')).toThrow(SyncTransportError);
  });
});

describe('id token identity', () => {
  it('reads the stable subject and display email', () => {
    expect(
      accountFromIdToken(
        idToken({ sub: 'google-sub-1', email: 'person@example.com', name: 'A Person' }),
      ),
    ).toEqual({ sub: 'google-sub-1', email: 'person@example.com', name: 'A Person' });
  });

  it('omits an absent name and refuses a token without identity', () => {
    expect(accountFromIdToken(idToken({ sub: 's', email: 'e@example.com' }))).toEqual({
      sub: 's',
      email: 'e@example.com',
    });
    expect(accountFromIdToken(idToken({ sub: 's' }))).toBeNull();
    expect(accountFromIdToken(undefined)).toBeNull();
    expect(accountFromIdToken('not-a-jwt')).toBeNull();
  });
});

describe('scope and configuration', () => {
  it('asks for the narrow app-data scope, not full Drive', () => {
    expect([...GOOGLE_DRIVE_SCOPES]).toEqual([
      'openid',
      'email',
      'https://www.googleapis.com/auth/drive.appdata',
    ]);
    expect(scopeString()).not.toContain('https://www.googleapis.com/auth/drive ');
    expect(scopeString()).not.toContain('/auth/drive.files');
  });

  it('reports a missing web client id as a configuration error', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_CLIENT_ID', '');
    const { requireWebClientId } = await import('@/lib/sync/google-config');

    expect(() => requireWebClientId()).toThrowError(
      expect.objectContaining({ code: 'missing-config' }),
    );
  });

  it('accepts a configured Android client id and derives its redirect', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_ANDROID_CLIENT_ID', '123-abc.apps.googleusercontent.com');
    const { requireAndroidClient } = await import('@/lib/sync/google-config');

    expect(requireAndroidClient()).toEqual({
      clientId: '123-abc.apps.googleusercontent.com',
      redirectUri: 'com.googleusercontent.apps.123-abc:/oauth2redirect',
    });
  });
});
