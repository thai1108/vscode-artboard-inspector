import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { defineConfig } from '@vscode/test-cli';

// Prefer the VS Code already installed on this machine (VSCODE_EXECUTABLE or the default macOS location) over a download.
const local = process.env.VSCODE_EXECUTABLE ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';

// VS Code puts its IPC socket in the user data dir and refuses paths over ~103 characters, which a profile inside a
// deep checkout easily exceeds, so the test profile lives in a short temporary directory.
const userDataDir = mkdtempSync(path.join(tmpdir(), 'ai-vsc-'));

export default defineConfig({
  files: 'dist-test/vscode/**/*.test.cjs',
  workspaceFolder: 'dist-test/vscode/workspace',
  mocha: { ui: 'tdd', timeout: 60_000 },
  launchArgs: [`--user-data-dir=${userDataDir}`, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
  ...(existsSync(local) ? { useInstallation: { fromPath: local } } : {}),
});
