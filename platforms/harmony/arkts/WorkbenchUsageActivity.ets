import screenLock from '@ohos.screenLock';
import { power } from '@kit.BasicServicesKit';

// Public read-only status APIs. No identifiers, idle time or user input is read.
// The replacement for isScreenLocked is system-app-only; do not request it.
export function readUsageActivity(callback: (value: string) => void): void {
  try {
    screenLock.isScreenLocked().then((locked: boolean) => {
      try {
        const active = power.isActive();
        callback(JSON.stringify({ active: active, locked: locked }));
      } catch (_) { callback('{}'); }
    }).catch(() => callback('{}'));
  } catch (_) { callback('{}'); }
}
