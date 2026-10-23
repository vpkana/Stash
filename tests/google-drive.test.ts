import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleDriveTransport } from '@/lib/sync/google-drive';
import { SyncTransportError } from '@/lib/sync/transport';
import type { GoogleAuthSession } from '@/lib/sync/google-auth';

/**
 * The Drive adapter is exercised against a scripted `fetch`, so these tests
 * cover the provider contract (pagination, multipart shape, retry policy,
 * error classification) without a Google account. They do not prove that a real
 * OAuth grant works; that is an integration concern documented in
 * `docs/google-drive-setup.md`.
 */

const ACCESS_TOKEN = 'test-access-token';

function authSession(): GoogleAuthSession {
  return {
    platform: 'web',
    connect: async () => ({ sub: 'sub-1', email: 'person@example.com' }),
    silentAccount: async () => null,
    accessToken: async () => ACCESS_TOKEN,
    disconnect: async () => undefined,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function driveFile(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    modifiedTime: '2026-01-02T03:04:05.000Z',
    size: '42',
    mimeType: 'application/json',
    ...extra,
  };
}

function setup(
  fetchMock: ReturnType<typeof vi.fn>,
  options: { maxAttempts?: number; baseDelayMs?: number } = {},
) {
  vi.stubGlobal('fetch', fetchMock);
  const sleep = vi.fn(async (_ms: number) => undefined);
  const transport = new GoogleDriveTransport(authSession(), {
    sleep,
    random: () => 1,
    baseDelayMs: options.baseDelayMs ?? 500,
    maxAttempts: options.maxAttempts ?? 4,
  });
  return { transport, sleep };
}

function callUrl(fetchMock: ReturnType<typeof vi.fn>, index: number): URL {
  return new URL(String(fetchMock.mock.calls[index]?.[0]));
}

function callInit(fetchMock: ReturnType<typeof vi.fn>, index: number): RequestInit {
  return (fetchMock.mock.calls[index]?.[1] ?? {}) as RequestInit;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GoogleDriveTransport listing', () => {
  it('pages through appDataFolder and maps file metadata', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          nextPageToken: 'page-2',
          files: [driveFile('m1', 'stash-sync-v1-device-a.json')],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ files: [driveFile('c1', 'stash-sync-v1-chunk-a-1.json')] }),
      );
    const { transport } = setup(fetchMock);

    const files = await transport.listFiles();

    expect(files).toEqual([
      {
        id: 'm1',
        name: 'stash-sync-v1-device-a.json',
        modifiedAt: Date.parse('2026-01-02T03:04:05.000Z'),
        size: 42,
      },
      {
        id: 'c1',
        name: 'stash-sync-v1-chunk-a-1.json',
        modifiedAt: Date.parse('2026-01-02T03:04:05.000Z'),
        size: 42,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const first = callUrl(fetchMock, 0);
    expect(first.origin + first.pathname).toBe('https://www.googleapis.com/drive/v3/files');
    expect(first.searchParams.get('spaces')).toBe('appDataFolder');
    expect(first.searchParams.get('pageSize')).toBe('1000');
    expect(first.searchParams.get('pageToken')).toBeNull();
    expect(callInit(fetchMock, 0).method).toBe('GET');
    expect((callInit(fetchMock, 0).headers as Record<string, string>).Authorization).toBe(
      `Bearer ${ACCESS_TOKEN}`,
    );

    expect(callUrl(fetchMock, 1).searchParams.get('pageToken')).toBe('page-2');
  });

  it('skips folders and entries without stable names instead of trusting them', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        files: [
          driveFile('folder-1', 'a folder', { mimeType: 'application/vnd.google-apps.folder' }),
          { id: 'no-name', modifiedTime: '2026-01-01T00:00:00.000Z' },
          { name: 'no-id' },
          driveFile('good', 'stash-sync-v1-chunk-a-1.json'),
        ],
      }),
    );
    const { transport } = setup(fetchMock);

    const files = await transport.listFiles();

    expect(files.map((file) => file.id)).toEqual(['good']);
    expect(files[0]?.size).toBe(42);
  });

  it('rejects an unreadable file list rather than treating it as empty', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('not-json', { status: 200 }));
    const { transport } = setup(fetchMock);

    await expect(transport.listFiles()).rejects.toMatchObject({
      code: 'remote-invalid',
    });
  });
});

describe('GoogleDriveTransport download', () => {
  it('requests media for the exact file id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"entries":[]}', { status: 200 }));
    const { transport } = setup(fetchMock);

    await expect(transport.downloadText('file/with space')).resolves.toBe('{"entries":[]}');

    const url = callUrl(fetchMock, 0);
    expect(url.pathname).toBe('/drive/v3/files/file%2Fwith%20space');
    expect(url.searchParams.get('alt')).toBe('media');
    expect(callInit(fetchMock, 0).method).toBe('GET');
  });

  it('reports a missing remote file without retrying it', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: {} }, { status: 404 }));
    const { transport } = setup(fetchMock);

    await expect(transport.downloadText('gone')).rejects.toMatchObject({
      code: 'remote-invalid',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('GoogleDriveTransport upload', () => {
  it('creates a manifest as multipart in appDataFolder', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse(driveFile('new-id', 'stash-sync-v1-device-a.json')));
    const { transport } = setup(fetchMock);

    const uploaded = await transport.uploadText({
      name: 'stash-sync-v1-device-a.json',
      content: '{"protocol":"stash-sync"}',
    });

    expect(uploaded).toMatchObject({ id: 'new-id', name: 'stash-sync-v1-device-a.json' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const createUrl = callUrl(fetchMock, 1);
    expect(createUrl.pathname).toBe('/upload/drive/v3/files');
    expect(createUrl.searchParams.get('uploadType')).toBe('multipart');
    const init = callInit(fetchMock, 1);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toMatch(
      /^multipart\/related; boundary=stash-/,
    );
    const body = String(init.body);
    expect(body).toContain('"parents":["appDataFolder"]');
    expect(body).toContain('stash-sync-v1-device-a.json');
    expect(body).toContain('{"protocol":"stash-sync"}');
  });

  it('replaces an existing file with a media PATCH', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(driveFile('existing-id', 'stash-sync-v1-device-a.json')));
    const { transport } = setup(fetchMock);

    const uploaded = await transport.uploadText({
      name: 'stash-sync-v1-device-a.json',
      content: '{"revision":2}',
      fileId: 'existing-id',
    });

    expect(uploaded.id).toBe('existing-id');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = callUrl(fetchMock, 0);
    expect(url.pathname).toBe('/upload/drive/v3/files/existing-id');
    expect(url.searchParams.get('uploadType')).toBe('media');
    expect(callInit(fetchMock, 0).method).toBe('PATCH');
    expect(callInit(fetchMock, 0).body).toBe('{"revision":2}');
  });

  it('reuses a same-named file instead of creating a duplicate manifest', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ files: [driveFile('old-id', 'manifest.json')] }))
      .mockResolvedValueOnce(jsonResponse(driveFile('old-id', 'manifest.json')));
    const { transport } = setup(fetchMock);

    await transport.uploadText({ name: 'manifest.json', content: '{}' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callUrl(fetchMock, 1).pathname).toBe('/upload/drive/v3/files/old-id');
    expect(callInit(fetchMock, 1).method).toBe('PATCH');
  });

  it('recreates a file that disappeared after being listed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: {} }, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse(driveFile('replacement', 'manifest.json')));
    const { transport } = setup(fetchMock);

    const uploaded = await transport.uploadText({
      name: 'manifest.json',
      content: '{}',
      fileId: 'vanished',
    });

    expect(uploaded.id).toBe('replacement');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(callInit(fetchMock, 0).method).toBe('PATCH');
    expect(callInit(fetchMock, 2).method).toBe('POST');
  });

  it('never replays a multipart create after a network failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockRejectedValueOnce(new TypeError('connection reset'));
    const { transport, sleep } = setup(fetchMock);

    await expect(
      transport.uploadText({ name: 'manifest.json', content: '{}' }),
    ).rejects.toMatchObject({ code: 'network', retryable: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('escapes single quotes in the name search query', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse(driveFile('new', "a'b.json")));
    const { transport } = setup(fetchMock);

    await transport.uploadText({ name: "a'b.json", content: '{}' });

    const query = callUrl(fetchMock, 0).searchParams.get('q');
    expect(query).toBe("name = 'a\\'b.json' and trashed = false");
    expect(callUrl(fetchMock, 0).searchParams.get('spaces')).toBe('appDataFolder');
  });
});

describe('GoogleDriveTransport failures', () => {
  it('maps an expired token to auth-required without retrying', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { status: 'UNAUTHENTICATED' } }, { status: 401 }));
    const { transport } = setup(fetchMock);

    await expect(transport.listFiles()).rejects.toMatchObject({
      code: 'auth-required',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After on rate limits', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { errors: [{ reason: 'rateLimitExceeded' }] } },
          { status: 429, headers: { 'retry-after': '2' } },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ files: [] }));
    const { transport, sleep } = setup(fetchMock);

    await expect(transport.listFiles()).resolves.toEqual([]);

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 403 rate limit with bounded exponential backoff', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { errors: [{ reason: 'userRateLimitExceeded' }] } },
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ files: [] }));
    const { transport, sleep } = setup(fetchMock);

    await transport.listFiles();

    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('does not retry an exhausted Drive quota', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { errors: [{ reason: 'storageQuotaExceeded' }] } }, { status: 403 }),
      );
    const { transport } = setup(fetchMock);

    await expect(transport.listFiles()).rejects.toMatchObject({
      code: 'quota',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a permission rejection to auth-required', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { errors: [{ reason: 'insufficientPermissions' }] } },
          { status: 403 },
        ),
      );
    const { transport } = setup(fetchMock);

    await expect(transport.listFiles()).rejects.toMatchObject({ code: 'auth-required' });
  });

  it('retries server errors with growing delays and then gives up', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: {} }, { status: 503 }));
    const { transport, sleep } = setup(fetchMock, { maxAttempts: 4 });

    await expect(transport.listFiles()).rejects.toMatchObject({
      code: 'network',
      retryable: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([500, 1_000, 2_000]);
  });

  it('retries a transient network failure and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ files: [] }));
    const { transport } = setup(fetchMock);

    await expect(transport.listFiles()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('turns a rejected fetch into a retryable transport error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('failed to fetch'));
    const { transport } = setup(fetchMock, { maxAttempts: 2 });

    await expect(transport.listFiles()).rejects.toBeInstanceOf(SyncTransportError);
    await expect(transport.listFiles()).rejects.toMatchObject({ code: 'network' });
  });
});
