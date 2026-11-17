import { fileShare, picker } from '@kit.CoreFileKit';
import preferences from '@ohos.data.preferences';
import { ContextAdapter } from './ContextAdapter';
import Inject from '../common/InjectModule';
import autoStartupManager from '@ohos.app.ability.autoStartupManager';
import { common } from '@kit.AbilityKit';

export function readStartup(callback: (value: string) => void): void {
  autoStartupManager.getAutoStartupStatusForSelf()
    .then((enabled: boolean) => callback(JSON.stringify({ ok: true, enabled: enabled })))
    .catch(() => callback(JSON.stringify({ ok: false, enabled: false })));
}

export function openStartupSettings(callback: (value: number) => void): void {
  const context = Inject.getOrCreate(ContextAdapter).getActiveContext() as common.UIAbilityContext | undefined;
  if (!context) { callback(-1); return; }
  context.startAbility({
    bundleName: 'com.huawei.hmos.settings',
    abilityName: 'com.huawei.hmos.settings.MainAbility',
    uri: 'application_settings'
  }).then(() => callback(0)).catch(() => callback(-1));
}

const STORE = 'workbenchSelectedFilesV1';
const KEY = 'policies';
const LIMIT = 512;
// A writable parent directory covers creating, deleting and renaming its children.
// Persist only the read/write modes granted by Picker, not per-target operation bits.
const DIRECTORY_WRITE_MODE = fileShare.OperationMode.READ_MODE | fileShare.OperationMode.WRITE_MODE;
const LEGACY_DIRECTORY_WRITE_MODE = DIRECTORY_WRITE_MODE |
  fileShare.OperationMode.CREATE_MODE | fileShare.OperationMode.DELETE_MODE | fileShare.OperationMode.RENAME_MODE;

function store(): preferences.Preferences {
  return preferences.getPreferencesSync(Inject.getOrCreate(ContextAdapter).getContext(), { name: STORE });
}

function readPolicies(): fileShare.PolicyInfo[] {
  const value = JSON.parse(store().getSync(KEY, '[]') as string) as fileShare.PolicyInfo[];
  if (!Array.isArray(value) || value.length > LIMIT) throw new Error('Invalid selected-file grants');
  value.forEach((policy: fileShare.PolicyInfo) => {
    if (typeof policy.uri !== 'string' || !policy.uri.startsWith('file://') || policy.uri.length > 32768 ||
        ![fileShare.OperationMode.READ_MODE, DIRECTORY_WRITE_MODE, LEGACY_DIRECTORY_WRITE_MODE].includes(policy.operationMode)) {
      throw new Error('Invalid selected-file policy');
    }
    // Older builds stored all five bits. Restore only their read/write subset;
    // the OS must still validate that access has not been revoked.
    if (policy.operationMode === LEGACY_DIRECTORY_WRITE_MODE) policy.operationMode = DIRECTORY_WRITE_MODE;
  });
  return value;
}

/** Called only after a native picker or file-open Want grants access. */
export async function persistSelectedAccess(uris: string[], writable: boolean, directory: boolean = false): Promise<void> {
  const mode = directory && writable ? DIRECTORY_WRITE_MODE :
    fileShare.OperationMode.READ_MODE | (writable ? fileShare.OperationMode.WRITE_MODE : 0);
  const policies: fileShare.PolicyInfo[] = uris.map((uri: string): fileShare.PolicyInfo => {
    if (!uri.startsWith('file://') || uri.length > 32768 || uri.includes('\u0000')) throw new Error('Invalid selected URI');
    return { uri: uri, operationMode: mode };
  });
  if (policies.length === 0) return;
  await fileShare.persistPermission(policies);
  await fileShare.activatePermission(policies);
  // Serialize the read/merge/write section; flush must finish before picker success.
  const previous = readPolicies();
  policies.forEach((policy: fileShare.PolicyInfo) => {
    const index = previous.findIndex((item: fileShare.PolicyInfo) => item.uri === policy.uri);
    if (index >= 0) {
      previous.splice(index, 1);
    }
    previous.push(policy);
  });
  const selectedStore = store();
  selectedStore.putSync(KEY, JSON.stringify(previous.slice(-LIMIT)));
  await selectedStore.flush();
}

export function persistOpenedFile(uri: string, callback: (value: number) => void): void {
  persistSelectedAccess([uri], false).then(() => callback(0)).catch(() => callback(-1));
}

/** Atomic publication needs siblings; obtain explicit approval for this directory. */
export async function ensureSaveDirectoryAccess(uri: string): Promise<boolean> {
  if (!uri.startsWith('file://') || uri.includes('\u0000')) throw new Error('Invalid save URI');
  const parent = uri.slice(0, uri.lastIndexOf('/'));
  const mode = DIRECTORY_WRITE_MODE;
  const previous = readPolicies().find((policy: fileShare.PolicyInfo) => policy.uri === parent && policy.operationMode === mode);
  if (previous) {
    try { await fileShare.activatePermission([previous]); return true; } catch { /* Re-select revoked access. */ }
  }
  const context = Inject.getOrCreate(ContextAdapter).getActiveContext() as common.UIAbilityContext | undefined;
  if (!context) throw new Error('Missing picker context');
  const options = new picker.DocumentSelectOptions();
  options.defaultFilePathUri = parent;
  options.selectMode = picker.DocumentSelectMode.FOLDER;
  options.authMode = true;
  options.maxSelectNumber = 1;
  const selected = await new picker.DocumentViewPicker(context).select(options);
  if (selected.length === 0) return false;
  if (selected.length !== 1 || selected[0] !== parent) throw new Error('Unexpected save directory');
  await persistSelectedAccess(selected, true, true);
  return true;
}

export function restoreFileAccess(callback: (value: string) => void): void {
  void (async () => {
    let restored = 0;
    let failed = 0;
    try {
      const policies = readPolicies();
      for (let start = 0; start < policies.length; start += 16) {
        await Promise.all(policies.slice(start, start + 16).map(async (policy: fileShare.PolicyInfo) => {
          try { await fileShare.activatePermission([policy]); restored++; }
          catch { failed++; }
        }));
      }
    } catch { failed++; }
    callback(JSON.stringify({ restored: restored, failed: failed }));
  })();
}
