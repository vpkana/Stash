/**
 * The transport boundary.
 *
 * The sync engine knows nothing about Google. It can list files, read one as
 * text, and write one. Everything Drive-specific — OAuth, pagination, retries,
 * `appDataFolder`, multipart upload — lives behind this interface, which is what
 * lets the whole protocol be tested against an in-memory fake.
 */

export interface RemoteFileInfo {
  id: string;
  name: string;
  /** Opaque provider version; never used as a merge revision. */
  modifiedAt?: number;
  size?: number;
}

export interface UploadTextInput {
  name: string;
  content: string;
  /** Present to replace an existing file (a device manifest); absent to create. */
  fileId?: string;
}

export interface SyncTransport {
  listFiles(): Promise<RemoteFileInfo[]>;
  downloadText(fileId: string): Promise<string>;
  uploadText(input: UploadTextInput): Promise<RemoteFileInfo>;
}

export type TransportErrorCode =
  | 'offline'
  | 'auth-cancelled'
  | 'auth-required'
  | 'auth-revoked'
  | 'missing-config'
  | 'quota'
  | 'rate-limited'
  | 'network'
  | 'remote-invalid';

/**
 * A classified transport failure.
 *
 * The message is written for a person and never includes an access token, a
 * request URL with parameters, a note title or a file body. Retryability is a
 * property of the failure, not a guess made by the caller.
 */
export class SyncTransportError extends Error {
  readonly code: TransportErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: TransportErrorCode,
    message: string,
    options: { retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'SyncTransportError';
    this.code = code;
    this.retryable =
      options.retryable ??
      (code === 'network' || code === 'offline' || code === 'rate-limited');
    this.retryAfterMs = options.retryAfterMs;
  }
}
