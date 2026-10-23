import Dexie from 'dexie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDatabase } from '@/db';
import {
  forgetVaultKey,
  getVaultKey,
  hasKeyring,
  isDeviceUnlockReady,
  isSessionLocked,
  unlockWithDevice,
} from '@/lib/privacy/keyring';
import {
  adoptRecoveryKey,
  createRecoveryKey,
  generateRecoveryKey,
  uploadRecoveryKeyring,
} from '@/lib/privacy/recovery';
import { setSecureStore } from '@/lib/privacy/secure-store';
import type { RemoteFileInfo, SyncTransport, UploadTextInput } from '@/lib/sync/transport';
import { memorySecureStore, setupDeviceVault } from './privacy-fixtures';

/**
 * The portable key, on a device that has never held it.
 *
 * The tests here are about the *boundary* between the two halves of locking:
 * entering a recovery key proves the user kept the portable secret, but it must
 * not become a way to read locked content. It installs the vault key and then
 * the ordinary platform prompt resumes control. On a browser that also means the
 * WebAuthn credential has to be registered — on a brand-new computer, and again
 * after the credential itself was reset — because a wrapped key with no prompt
 * is a lock nobody can open.
 *
 * The platform credential is mocked here because Node has no authenticator. The
 * cryptography, keyring writes and recovery-file parsing are real.
 */

const webauthn = vi.hoisted(() => ({
  enrolled: false,
  fail: false,
  enrollCalls: 0,
}));

vi.mock('@/lib/privacy/webauthn', () => ({
  isDevicePromptSupported: async () => true,
  readStoredCredential: async () =>
    webauthn.enrolled ? { id: 'test-credential', createdAt: 1 } : null,
  hasDeviceCredential: async () => webauthn.enrolled,
  forgetDeviceCredential: async () => {
    webauthn.enrolled = false;
  },
  enrollDeviceCredential: async () => {
    webauthn.enrollCalls += 1;
    if (webauthn.fail) return null;
    webauthn.enrolled = true;
    return 'test-credential';
  },
  promptDeviceCredential: async () => 'ok',
}));

class KeyringDrive implements SyncTransport {
  private readonly files = new Map<string, { id: string; name: string; content: string }>();
  private nextId = 1;

  async listFiles(): Promise<RemoteFileInfo[]> {
    return [...this.files.values()].map((file, index) => ({
      id: file.id,
      name: file.name,
      modifiedAt: index,
      size: file.content.length,
    }));
  }

  async downloadText(fileId: string): Promise<string> {
    const file = this.files.get(fileId);
    if (!file) throw new Error('missing remote file');
    return file.content;
  }

  async uploadText(input: UploadTextInput): Promise<RemoteFileInfo> {
    const existing = [...this.files.values()].find((file) => file.name === input.name);
    const file = existing ?? { id: `file-${this.nextId++}`, name: input.name, content: '' };
    file.content = input.content;
    this.files.set(file.id, file);
    return { id: file.id, name: file.name, modifiedAt: 0, size: file.content.length };
  }
}

async function resetDatabase(): Promise<void> {
  db.close();
  await Dexie.delete(db.name);
  await openDatabase();
}

/** Set up a vault with a published recovery file, as the first device would. */
async function publishRecovery(drive: KeyringDrive): Promise<string> {
  await setupDeviceVault();
  const created = await createRecoveryKey();
  if (!created.ok || !created.key) throw new Error(created.message ?? 'could not create recovery key');
  await uploadRecoveryKeyring(drive);
  return created.key;
}

/** Forget everything device-local, as a new machine or a reset secure store would. */
async function becomeFreshDevice(): Promise<void> {
  await resetDatabase();
  forgetVaultKey();
  setSecureStore(memorySecureStore('web'));
  webauthn.enrolled = false;
}

beforeEach(async () => {
  await resetDatabase();
  forgetVaultKey();
  setSecureStore(memorySecureStore('web'));
  webauthn.enrolled = false;
  webauthn.fail = false;
  webauthn.enrollCalls = 0;
});

describe('recovery on a fresh Windows device', () => {
  it('registers Windows Hello, installs the key, and still starts locked', async () => {
    const drive = new KeyringDrive();
    const key = await publishRecovery(drive);

    await becomeFreshDevice();
    webauthn.enrollCalls = 0;

    const adopted = await adoptRecoveryKey(drive, key);
    expect(adopted.ok).toBe(true);
    expect(webauthn.enrollCalls).toBe(1);
    expect(getVaultKey()).not.toBeNull();

    // The only way in is now a working device prompt holding the new wrap.
    expect(await isDeviceUnlockReady()).toBe(true);

    // The privacy store reloads after adoption, which drops the key. The
    // recovery key installed *access*; it did not open a folder by itself.
    forgetVaultKey();
    expect(isSessionLocked()).toBe(true);
    expect(await unlockWithDevice()).not.toBeNull();
  });

  it('re-registers the prompt after Windows Hello was reset on an existing vault', async () => {
    const drive = new KeyringDrive();
    const key = await publishRecovery(drive);

    // The keyring and device wrap survive; the platform credential does not.
    webauthn.enrolled = false;
    expect(await isDeviceUnlockReady()).toBe(false);
    forgetVaultKey();
    webauthn.enrollCalls = 0;

    const adopted = await adoptRecoveryKey(drive, key);
    expect(adopted.ok).toBe(true);
    expect(webauthn.enrollCalls).toBe(1);
    expect(await isDeviceUnlockReady()).toBe(true);
  });

  it('writes nothing when the computer cannot register its prompt', async () => {
    const drive = new KeyringDrive();
    const key = await publishRecovery(drive);

    await becomeFreshDevice();
    webauthn.fail = true;

    const adopted = await adoptRecoveryKey(drive, key);
    expect(adopted.ok).toBe(false);
    expect(adopted.message).toContain('unlock prompt');
    expect(await hasKeyring()).toBe(false);
    expect(getVaultKey()).toBeNull();
  });

  it('does not touch the prompt for a key that opens no vault', async () => {
    const drive = new KeyringDrive();
    await publishRecovery(drive);
    const wrong = await generateRecoveryKey();

    await becomeFreshDevice();
    webauthn.enrollCalls = 0;

    const adopted = await adoptRecoveryKey(drive, wrong.formatted);
    expect(adopted.ok).toBe(false);
    expect(webauthn.enrollCalls).toBe(0);
    expect(getVaultKey()).toBeNull();
  });
});
