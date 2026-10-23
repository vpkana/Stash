import type { GoogleAuthSession } from './google-auth';
import {
  SyncTransportError,
  type RemoteFileInfo,
  type SyncTransport,
  type UploadTextInput,
} from './transport';

/**
 * Google Drive REST v3, restricted to `appDataFolder`.
 *
 * Only the three operations the sync engine needs exist here: list, download
 * and upload. Everything protocol-shaped stays above this line, which is what
 * lets the engine be tested against an in-memory drive and what keeps the
 * provider's pagination, retry and error vocabulary out of the merge logic.
 *
 * `appDataFolder` is a per-user hidden folder that the `drive.appdata` scope
 * alone can see. Stash never asks for broader Drive access and never lists the
 * user's own files, so a compromised token cannot read anything the person did
 * not hand to Stash.
 */

const FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files';
const APP_DATA_FOLDER = 'appDataFolder';
const FILE_FIELDS = 'id,name,modifiedTime,size,mimeType';
const PAGE_SIZE = 1_000;
const MAX_PAGES = 200;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 45_000;
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'sharingRateLimitExceeded',
]);

const QUOTA_REASONS = new Set([
  'quotaExceeded',
  'storageQuotaExceeded',
  'dailyLimitExceeded',
  'uploadLimitExceeded',
]);

const CONFIG_REASONS = new Set(['accessNotConfigured', 'invalidClient', 'invalidClientId']);

const PERMISSION_REASONS = new Set([
  'insufficientPermissions',
  'insufficientFilePermissions',
  'appNotAuthorizedToFile',
  'domainPolicy',
]);

export interface DriveTransportOptions {
  /** Total attempts for idempotent requests, including the first. */
  maxAttempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  /** Injectable for tests; production uses real time and randomness. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface DriveResponse {
  status: number;
  text: string;
  retryAfterMs?: number;
}

class DriveHttpError extends SyncTransportError {
  readonly status: number;
  constructor(status: number, failure: SyncTransportError) {
    super(failure.code, failure.message, { retryable: failure.retryable });
    this.name = 'DriveHttpError';
    this.status = status;
  }
}

interface DriveFile {
  id?: unknown;
  name?: unknown;
  modifiedTime?: unknown;
  size?: unknown;
  mimeType?: unknown;
}

export class GoogleDriveTransport implements SyncTransport {
  private readonly auth: GoogleAuthSession;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(auth: GoogleAuthSession, options: DriveTransportOptions = {}) {
    this.auth = auth;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  async listFiles(): Promise<RemoteFileInfo[]> {
    const files = new Map<string, RemoteFileInfo>();
    let pageToken: string | undefined;
    let pages = 0;

    do {
      pages += 1;
      if (pages > MAX_PAGES) {
        throw new SyncTransportError(
          'remote-invalid',
          'Google Drive returned an unexpected number of file pages.',
          { retryable: false },
        );
      }
      const params = new URLSearchParams({
        spaces: APP_DATA_FOLDER,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: String(PAGE_SIZE),
      });
      if (pageToken) params.set('pageToken', pageToken);

      const response = await this.request(`${FILES_ENDPOINT}?${params.toString()}`, { method: 'GET' });
      const body = parseJsonObject(response.text, 'Google Drive returned an unreadable file list.');

      const next = body.nextPageToken;
      if (next !== undefined && typeof next !== 'string') {
        throw invalidRemote('Google Drive returned an invalid page token.');
      }
      pageToken = typeof next === 'string' && next.length > 0 ? next : undefined;

      const listed = body.files;
      if (listed !== undefined && !Array.isArray(listed)) {
        throw invalidRemote('Google Drive returned an invalid file list.');
      }
      for (const raw of Array.isArray(listed) ? listed : []) {
        const file = toRemoteFile(raw);
        if (file) files.set(file.id, file);
      }
    } while (pageToken);

    return [...files.values()];
  }

  async downloadText(fileId: string): Promise<string> {
    const response = await this.request(
      `${FILES_ENDPOINT}/${encodeURIComponent(fileId)}?alt=media`,
      { method: 'GET' },
    );
    if (response.text.length > MAX_TEXT_BYTES) {
      throw invalidRemote('A sync file is larger than Stash can accept.');
    }
    return response.text;
  }

  async uploadText(input: UploadTextInput): Promise<RemoteFileInfo> {
    if (input.content.length > MAX_TEXT_BYTES) {
      throw new Error('A sync payload exceeded the Drive transport limit.');
    }

    if (input.fileId) {
      try {
        return await this.replaceFile(input.fileId, input.content);
      } catch (error) {
        if (error instanceof DriveHttpError && error.status === 404) {
          // The file vanished between listing and writing. Recreating it is
          // safe: the engine's manifest is identified by name, not by id.
          return this.createFile(input.name, input.content);
        }
        throw error;
      }
    }
    return this.createFile(input.name, input.content);
  }

  private async createFile(name: string, content: string): Promise<RemoteFileInfo> {
    // A previous attempt may have written the file before failing to report
    // success. Reusing it by name keeps a manifest singular; Drive itself
    // happily stores several files with the same name.
    const existing = await this.findByName(name);
    if (existing) return this.replaceFile(existing.id, content);

    const boundary = multipartBoundary(content);
    const metadata = JSON.stringify({
      name,
      mimeType: 'application/json',
      parents: [APP_DATA_FOLDER],
    });
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}` +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}` +
      `\r\n--${boundary}--\r\n`;

    const params = new URLSearchParams({ uploadType: 'multipart', fields: FILE_FIELDS });
    // A create is not safe to replay: if the response is lost after the write,
    // a retry would leave two manifests. The next sync finds the first one by
    // name, so failing here costs one retry cycle and can never duplicate data.
    const response = await this.request(`${UPLOAD_ENDPOINT}?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    }, false);
    return parseUploaded(response);
  }

  private async replaceFile(fileId: string, content: string): Promise<RemoteFileInfo> {
    const params = new URLSearchParams({ uploadType: 'media', fields: FILE_FIELDS });
    const response = await this.request(
      `${UPLOAD_ENDPOINT}/${encodeURIComponent(fileId)}?${params.toString()}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: content,
      },
    );
    return parseUploaded(response);
  }

  private async findByName(name: string): Promise<RemoteFileInfo | null> {
    const params = new URLSearchParams({
      spaces: APP_DATA_FOLDER,
      q: `name = '${escapeQuery(name)}' and trashed = false`,
      fields: `files(${FILE_FIELDS})`,
      pageSize: '10',
    });
    const response = await this.request(`${FILES_ENDPOINT}?${params.toString()}`, { method: 'GET' });
    const body = parseJsonObject(response.text, 'Google Drive returned an unreadable file list.');
    const listed = Array.isArray(body.files) ? body.files : [];
    const matches = listed
      .map(toRemoteFile)
      .filter((file): file is RemoteFileInfo => file !== null && file.name === name)
      .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
    return matches[0] ?? null;
  }

  private async request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
    retry = true,
  ): Promise<DriveResponse> {
    const attempts = retry ? this.maxAttempts : 1;
    let lastError: SyncTransportError | null = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const token = await this.auth.accessToken();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: init.method,
          headers: { ...init.headers, Authorization: `Bearer ${token}` },
          body: init.body,
          signal: controller.signal,
        });
      } catch {
        const timedOut = controller.signal.aborted;
        const failure = new SyncTransportError(
          'network',
          timedOut
            ? 'Google Drive did not respond in time. Try again when the connection is better.'
            : 'Could not reach Google Drive. Check the connection and try again.',
          { retryable: true },
        );
        lastError = failure;
        if (attempt + 1 >= attempts) throw failure;
        await this.pause(attempt);
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) {
        return { status: response.status, text: await response.text() };
      }

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      const failure = classify(response.status, await safeText(response), retryAfterMs);
      if (failure.retryable && attempt + 1 < attempts) {
        lastError = failure;
        await this.pause(attempt, retryAfterMs);
        continue;
      }
      throw new DriveHttpError(response.status, failure);
    }

    throw lastError ?? new SyncTransportError('network', 'Could not reach Google Drive.');
  }

  private async pause(attempt: number, retryAfterMs?: number): Promise<void> {
    if (retryAfterMs !== undefined) {
      await this.sleep(Math.min(retryAfterMs, MAX_RETRY_DELAY_MS));
      return;
    }
    const ceiling = Math.min(MAX_RETRY_DELAY_MS, this.baseDelayMs * 2 ** attempt);
    await this.sleep(Math.max(0, ceiling * this.random()));
  }
}

function toRemoteFile(raw: unknown): RemoteFileInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const file = raw as DriveFile;
  if (typeof file.id !== 'string' || file.id.length === 0) return null;
  if (typeof file.name !== 'string' || file.name.length === 0) return null;
  // Folders can never carry a manifest or a chunk. Skipping them is safer than
  // letting a folder id reach the download path.
  if (file.mimeType === FOLDER_MIME) return null;

  const info: RemoteFileInfo = { id: file.id, name: file.name };
  const modified = typeof file.modifiedTime === 'string' ? Date.parse(file.modifiedTime) : NaN;
  if (Number.isFinite(modified)) info.modifiedAt = modified;
  const size = typeof file.size === 'string' ? Number(file.size) : NaN;
  if (Number.isFinite(size) && size >= 0) info.size = size;
  return info;
}

function parseUploaded(response: DriveResponse): RemoteFileInfo {
  const body = parseJsonObject(response.text, 'Google Drive returned an unreadable upload response.');
  const file = toRemoteFile(body);
  if (!file) throw invalidRemote('Google Drive did not confirm the uploaded file.');
  return file;
}

function parseJsonObject(text: string, message: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidRemote(message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidRemote(message);
  }
  return parsed as Record<string, unknown>;
}

function invalidRemote(message: string): SyncTransportError {
  return new SyncTransportError('remote-invalid', message, { retryable: true });
}

/** Read the provider's reason without ever surfacing the response body to a person. */
function providerReason(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { errors?: Array<{ reason?: unknown }>; status?: unknown };
    };
    const reasons = parsed.error?.errors;
    if (Array.isArray(reasons)) {
      for (const item of reasons) {
        if (item && typeof item.reason === 'string' && item.reason.length > 0) return item.reason;
      }
    }
    if (typeof parsed.error?.status === 'string') return parsed.error.status;
  } catch {
    // A non-JSON error page is classified by status below.
  }
  return '';
}

function classify(status: number, body: string, retryAfterMs?: number): SyncTransportError {
  if (status === 401) {
    return new SyncTransportError(
      'auth-required',
      'Google sign-in has expired. Connect again to continue syncing.',
    );
  }

  if (status === 403) {
    const reason = providerReason(body);
    if (RATE_LIMIT_REASONS.has(reason)) {
      return new SyncTransportError(
        'rate-limited',
        'Google Drive is receiving too many sync requests. Stash will try again later.',
        { retryable: true, retryAfterMs },
      );
    }
    if (QUOTA_REASONS.has(reason)) {
      return new SyncTransportError(
        'quota',
        'Google Drive is out of storage or request quota. Free up space in Drive, then sync again.',
        { retryable: false },
      );
    }
    if (CONFIG_REASONS.has(reason)) {
      return new SyncTransportError(
        'missing-config',
        'Google Drive is not enabled for this app’s Google Cloud project.',
        { retryable: false },
      );
    }
    if (PERMISSION_REASONS.has(reason)) {
      return new SyncTransportError(
        'auth-required',
        'Google Drive denied access to Stash’s app data. Connect again and allow that access.',
        { retryable: false },
      );
    }
    return new SyncTransportError(
      'remote-invalid',
      'Google Drive refused this request. Check that Drive is enabled for the app and try again.',
      { retryable: false },
    );
  }

  if (status === 404) {
    return new SyncTransportError(
      'remote-invalid',
      'A sync file is no longer in Google Drive. Stash will rebuild it on the next sync.',
      { retryable: false },
    );
  }

  if (status === 408) {
    return new SyncTransportError('network', 'Google Drive timed out. Try again.', { retryable: true });
  }

  if (status === 429) {
    return new SyncTransportError(
      'rate-limited',
      'Google Drive is receiving too many sync requests. Stash will try again later.',
      { retryable: true, retryAfterMs },
    );
  }

  if (status >= 500) {
    return new SyncTransportError('network', 'Google Drive is temporarily unavailable.', {
      retryable: true,
      retryAfterMs,
    });
  }

  if (status === 400 || status === 413) {
    return new SyncTransportError('remote-invalid', 'Google Drive rejected a sync request as invalid.', {
      retryable: false,
    });
  }

  return new SyncTransportError('remote-invalid', 'Google Drive returned an unexpected response.', {
    retryable: false,
  });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function multipartBoundary(content: string): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const boundary = `stash-${crypto.randomUUID()}`;
    if (!content.includes(boundary)) return boundary;
  }
  return `stash-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
