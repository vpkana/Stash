#!/usr/bin/env node
/**
 * Build the Android debug APK.
 *
 * This exists because the obvious npm script — `cd android && ./gradlew
 * assembleDebug` — only works on one of the two platforms this repository is
 * built on. npm runs scripts through `cmd.exe` on Windows, where `./gradlew` is
 * a directory-ish path that cmd cannot execute, so the command has to name
 * `gradlew.bat` there and `./gradlew` everywhere else. A `||` chain between the
 * two would work but would also re-run a build that failed for a real reason,
 * which is exactly the kind of silent double-work that hides a genuine error.
 *
 * So the platform pick is explicit here, `stdio` is inherited so Gradle's own
 * output is the output, and the exit code is Gradle's.
 *
 * The Windows wrapper is named by absolute path rather than as a bare `gradlew`:
 * some Windows environments set `NoDefaultCurrentDirectoryInExePath`, which turns
 * off cmd's search of the working directory, and a bare name then fails with "not
 * recognized" on a file that is plainly right there.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = path.join(root, 'android');
const wrapper =
  process.platform === 'win32' ? path.join(androidDir, 'gradlew.bat') : './gradlew';

const result = spawnSync(wrapper, ['assembleDebug'], {
  cwd: androidDir,
  stdio: 'inherit',
  // `.bat` needs a shell on Windows; the POSIX wrapper is executable on its own.
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`[stash] could not run the Gradle wrapper (${wrapper}):`, result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
