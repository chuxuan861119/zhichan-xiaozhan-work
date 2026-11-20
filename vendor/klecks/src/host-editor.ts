import { bindKlecksCommandPort } from '../../../src/renderer/src/design-patent/correction/klecks-command-port';
import { bindKlecksFrameHandshake } from '../../../src/renderer/src/design-patent/correction/klecks-frame-handshake';
import { HostEditorRuntime } from './host/editor-runtime';
import { HostFrameWorkspace } from './host/frame-workspace';
import { grantedKlecksResourcePolicy, DEFAULT_KLECKS_RESOURCE_POLICY } from '../../../src/renderer/src/design-patent/correction/klecks-resource-budget';
import { presentKlecksOperationError,bindKlecksOperationFeedback } from '../../../src/renderer/src/design-patent/correction/klecks-operation-error';
import { bindKlecksUserInteraction } from '../../../src/renderer/src/design-patent/correction/klecks-user-interaction';

// Host-owned canvas entry. No upstream menus, startup dialog, probe hooks or file APIs.
const parameters = new URLSearchParams(location.search);
const sessionId = parameters.get('session') ?? '';
const platform = parameters.get('platform') ?? 'windows';
let resourcePolicy: ReturnType<typeof grantedKlecksResourcePolicy> | null = null;
try { resourcePolicy = grantedKlecksResourcePolicy(parameters.has('budget') ? Number(parameters.get('budget')) : DEFAULT_KLECKS_RESOURCE_POLICY.limitBytes); } catch { /* Invalid quotas fail closed. */ }
const nonce = location.hash.slice(1);
// Pinned by the main-process response, not by the embedding page or URL query.
const parentOrigin = document.querySelector<HTMLMetaElement>('meta[name="klecks-parent-origin"]')?.content ?? 'patent-app://app';
const errorElement = document.getElementById('error')!;
const report = (error?: unknown) => {
    presentKlecksOperationError(errorElement, error);
};

if (!resourcePolicy || parent === window || !sessionId || sessionId.length > 200 || !/^[a-f0-9]{64}$/.test(nonce) || !['windows', 'mac', 'harmony'].includes(platform)) {
    report();
} else {
    const feedback=bindKlecksOperationFeedback(errorElement,window);
    const runtime = new HostEditorRuntime(document.getElementById('canvas')!, platform as 'windows' | 'mac' | 'harmony', {
        changed:feedback.changed,error:feedback.error,
    }, resourcePolicy);
    const workspace = new HostFrameWorkspace(sessionId, runtime);
    const release = bindKlecksFrameHandshake(window, { parent, origin: parentOrigin, nonce }, port => {
        const documents = workspace.bind(port);
        const commands = bindKlecksCommandPort(port, () => workspace.activeIdentity, command => runtime.dispatch(command));
        const input = bindKlecksUserInteraction(window, () => parent.postMessage({ type: 'klecks:user-input', version: 1, nonce }, parentOrigin));
        return () => { input(); documents(); commands(); };
    });
    addEventListener('pagehide', () => { feedback.release();release(); workspace.destroy(); }, { once: true });
}
