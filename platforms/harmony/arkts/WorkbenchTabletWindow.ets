import deviceInfo from '@ohos.deviceInfo';
import window from '@ohos.window';
import { common } from '@kit.AbilityKit';
import { ContextAdapter } from './ContextAdapter';
import Inject from '../common/InjectModule';

let focused: boolean = false;
let previousLayout: boolean = false;
let previousStatusVisible: boolean = true;

async function activeWindow(): Promise<window.Window> {
  const context = Inject.getOrCreate(ContextAdapter).getActiveContext() as common.UIAbilityContext | undefined;
  if (!context) throw new Error('No active tablet window');
  return window.getLastWindow(context);
}

function state(target: window.Window): string {
  const system = target.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
  const navigation = target.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
  const cutout = target.getWindowAvoidArea(window.AvoidAreaType.TYPE_CUTOUT);
  const keyboard = target.getWindowAvoidArea(window.AvoidAreaType.TYPE_KEYBOARD);
  const status = target.getWindowStatus();
  const properties = target.getWindowProperties();
  const drawable = properties.drawableRect;
  const topInsetPx = Math.max(system.topRect.height, cutout.topRect.height);
  const bottomInsetPx = Math.max(system.bottomRect.height, navigation.bottomRect.height, cutout.bottomRect.height);
  const contentTop = Math.max(drawable.top, topInsetPx);
  const keyboardTop = keyboard.bottomRect.height > 0
    ? keyboard.bottomRect.top : properties.windowRect.height;
  const contentBottom = Math.min(drawable.top + drawable.height,
    properties.windowRect.height - bottomInsetPx, keyboardTop);
  return JSON.stringify({ available: true, focusMode: focused,
    contentHeightPx: Math.max(0, contentBottom - contentTop),
    portrait: properties.windowRect.height > properties.windowRect.width,
    windowed: status !== window.WindowStatusType.FULL_SCREEN && status !== window.WindowStatusType.MAXIMIZE,
    topInsetPx, bottomInsetPx });
}

const UNSUPPORTED = '{"available":false,"focusMode":false,"topInsetPx":0,"bottomInsetPx":0}';

export function readTabletWindow(callback: (value: string) => void): void {
  if (deviceInfo.deviceType !== 'tablet') { callback(UNSUPPORTED); return; }
  activeWindow().then((target: window.Window) => callback(state(target)))
    .catch(() => callback('{"error":true}'));
}

export function setTabletFocus(enabled: boolean, callback: (value: string) => void): void {
  if (deviceInfo.deviceType !== 'tablet') { callback(UNSUPPORTED); return; }
  activeWindow().then(async (target: window.Window) => {
    if (enabled === focused) { callback(state(target)); return; }
    const status = target.getWindowStatus();
    if (enabled && status !== window.WindowStatusType.FULL_SCREEN && status !== window.WindowStatusType.MAXIMIZE) {
      callback('{"error":true}'); return;
    }
    const beforeFocused = focused;
    if (enabled) {
      previousLayout = target.getWindowProperties().isLayoutFullScreen;
      previousStatusVisible = target.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM).topRect.height > 0;
    }
    try {
      await target.setSpecificSystemBarEnabled('status', enabled ? false : previousStatusVisible);
      await target.setWindowLayoutFullScreen(enabled ? true : previousLayout);
      focused = enabled;
      callback(state(target));
    } catch (_) {
      focused = beforeFocused;
      // Roll back partial transitions; do not claim that a rejected request succeeded.
      try { await target.setSpecificSystemBarEnabled('status', focused ? false : previousStatusVisible); } catch (_) {}
      try { await target.setWindowLayoutFullScreen(focused ? true : previousLayout); } catch (_) {}
      callback('{"error":true}');
    }
  }).catch(() => callback('{"error":true}'));
}
