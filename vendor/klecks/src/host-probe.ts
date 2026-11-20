import { KlHistory } from './app/script/klecks/history/kl-history';
import { KlCanvas } from './app/script/klecks/canvas/kl-canvas';
import { HostDocument, THostProject } from './host/host-document';
import { HostWorkspace } from './host/host-workspace';
import { HostCanvasSurface } from './host/canvas-surface';
import { HostEditorRuntime } from './host/editor-runtime';
import { HostFrameWorkspace } from './host/frame-workspace';
import { probeWorkspaceResources } from './host/workspace-resource-probe';
import { readPsd } from './app/script/klecks/storage/ag-psd';
import type { MultiPolygon } from 'polygon-clipping';
import { bindKlecksPointerInput } from '../../../src/renderer/src/design-patent/correction/klecks-pointer-input';
import { bindKlecksKeyboard } from '../../../src/renderer/src/design-patent/correction/klecks-keyboard';
import { routeKlecksCommand } from '../../../src/renderer/src/design-patent/correction/klecks-command-router';
import { bindKlecksCommandPort } from '../../../src/renderer/src/design-patent/correction/klecks-command-port';
import { bindKlecksFrameHandshake } from '../../../src/renderer/src/design-patent/correction/klecks-frame-handshake';
import { imageToScreen } from '../../../src/renderer/src/design-patent/correction/klecks-viewport';
import { verifyPixelTransforms } from './host/pixel-transform-probe';

// Development-only probe; never imported by the production entry point.
async function run(): Promise<void> {
try {
    if (new URLSearchParams(location.search).has('resources')) {
        document.getElementById('result')!.textContent = JSON.stringify(await probeWorkspaceResources());
        return;
    }
    const workspace = new HostWorkspace();
    verifyPixelTransforms();
    const makeWorkspaceImage = (id: string) => new HostDocument({ projectId: id, width: 16, height: 16,
        layers: [{ name: id, opacity: 1, isVisible: true, hasClipping: false, mixModeStr: 'source-over', image: { fill: 'white' } }] });
    workspace.sync(['a', 'b']);
    workspace.open('a', () => makeWorkspaceImage('a'));
    workspace.setViewport({ x: 20, y: -15, zoom: 2, pixelRatio: 1 });
    workspace.document!.paint([[8, 8, 1]], { tool: 'brush', size: 4, opacity: 1, color: { r: 0, g: 0, b: 0 } });
    workspace.document!.undo();
    const undoneUsage = workspace.resourceUsage();
    if (undoneUsage.historyPixelBytes <= 0 || undoneUsage.layerCanvasBytes !== 16 * 16 * 4) throw new Error('Resource accounting omitted redo or active canvas');
    workspace.open('b', () => makeWorkspaceImage('b'));
    workspace.document!.renameLayer(workspace.document!.canvas.getLayer(0).id, 'B edited');
    workspace.open('a', () => { throw new Error('Existing document reinitialized'); });
    workspace.document!.redo();
    if (workspace.document!.canvas.getLayer(0).context.getImageData(8, 8, 1, 1).data[0] !== 0) throw new Error('Workspace lost suspended redo');
    if (workspace.viewport?.zoom !== 2 || workspace.viewport.x !== 20) throw new Error('Workspace lost per-image viewport');
    workspace.document!.select([[[[6, 6], [10, 6], [10, 10], [6, 10], [6, 6]]]], 'replace');
    workspace.copy();
    const systemCopyPng = await workspace.exportClipboardPng();
    if (!systemCopyPng || systemCopyPng.width !== 4 || systemCopyPng.height !== 4 || !systemCopyPng.bytes.length) throw new Error('Internal pixels could not encode for system clipboard');
    workspace.document!.undo();
    workspace.open('b', () => { throw new Error('Existing document reinitialized'); });
    if (workspace.viewport !== null) throw new Error('Viewport leaked between images');
    workspace.paste(true);
    if (workspace.document!.canvas.getLayerCount() !== 2 || workspace.document!.canvas.getLayer(1).context.getImageData(8, 8, 1, 1).data[0] !== 0) throw new Error('Cross-image clipboard lost pixels');
    workspace.document!.undo();
    workspace.open('a', () => { throw new Error('Existing document reinitialized'); });
    workspace.sync(['a', 'b', 'c']);
    let loadFailurePreserved = false;
    try { workspace.open('c', () => { throw new Error('Decode failure'); }); }
    catch { loadFailurePreserved = workspace.activeId === 'a'; }
    if (!loadFailurePreserved) throw new Error('Workspace decode failure destroyed active image');
    workspace.open('b', () => { throw new Error('Retained document reinitialized'); });
    if (workspace.document!.canvas.getLayer(0).name !== 'B edited') throw new Error('Workspace lost retained layer');
    workspace.document!.beginStroke([1, 1, 1], { tool: 'brush', size: 2, opacity: 1, color: { r: 0, g: 0, b: 0 } });
    let pendingBlocked = false;
    try { workspace.sync(['a']); } catch { pendingBlocked = true; }
    if (!pendingBlocked || workspace.activeId !== 'b') throw new Error('Pending stroke deletion was not atomic');
    workspace.document!.cancelStroke();
    workspace.sync(['b', 'a']);
    workspace.open('a', () => { throw new Error('Reorder reinitialized document'); });
    workspace.document!.undo();
    if (workspace.document!.canvas.getLayer(0).context.getImageData(8, 8, 1, 1).data[0] !== 255) throw new Error('Workspace lost history after reorder');
    workspace.document!.select([], 'replace');
    let failedCopy = false;
    try { workspace.copy(); } catch { failedCopy = true; }
    if (!failedCopy) throw new Error('Empty copy unexpectedly succeeded');
    workspace.sync(['b']);
    workspace.open('b', () => { throw new Error('Retained target was lost'); });
    workspace.paste(true);
    if (workspace.document!.canvas.getLayer(1).context.getImageData(8, 8, 1, 1).data[0] !== 0) throw new Error('Failed copy or source deletion destroyed clipboard');
    workspace.sync(['b', 'a']);
    workspace.open('a', () => makeWorkspaceImage('a'));
    if (workspace.viewport !== null) throw new Error('Deleted image viewport resurrected');
    workspace.sync([]);
    if (workspace.document !== null || workspace.activeId !== null) throw new Error('Workspace empty state leaked document');
    workspace.destroy();
    const loading = new HostWorkspace();
    loading.sync(['a', 'b', 'c']);
    loading.open('a', () => makeWorkspaceImage('a'));
    let finishB!: (image: HostDocument) => void;
    const pendingB = loading.openAsync('b', () => new Promise(resolve => { finishB = resolve; }));
    loading.document!.renameLayer(loading.document!.canvas.getLayer(0).id, 'Edited while loading');
    await loading.openAsync('c', async () => makeWorkspaceImage('c'));
    const staleB = makeWorkspaceImage('b');
    finishB(staleB);
    if (await pendingB !== null || loading.activeId !== 'c') throw new Error('Older decode replaced latest target');
    let staleReleased = false;
    try { staleB.capture(); } catch { staleReleased = true; }
    if (!staleReleased) throw new Error('Stale decode retained engine');
    loading.open('a', () => { throw new Error('Loading lost active history'); });
    if (loading.document!.canvas.getLayer(0).name !== 'Edited while loading') throw new Error('Loading lost concurrent edits');
    let finishDeleted!: (image: HostDocument) => void;
    const deletedLoad = loading.openAsync('b', () => new Promise(resolve => { finishDeleted = resolve; }));
    loading.sync(['a', 'c']); loading.sync(['a', 'b', 'c']);
    finishDeleted(makeWorkspaceImage('b'));
    if (await deletedLoad !== null || String(loading.activeId) !== 'a') throw new Error('Deleted decode resurrected image');
    let finishDuringStroke!: (image: HostDocument) => void;
    const duringStroke = loading.openAsync('b', () => new Promise(resolve => { finishDuringStroke = resolve; }));
    loading.document!.beginStroke([2, 2, 1], { tool: 'brush', size: 2, opacity: 1, color: { r: 0, g: 0, b: 0 } });
    const blockedDecode = makeWorkspaceImage('b');
    finishDuringStroke(blockedDecode);
    let switchBlocked = false;
    try { await duringStroke; } catch { switchBlocked = true; }
    if (!switchBlocked || String(loading.activeId) !== 'a') throw new Error('Async switch discarded pending stroke');
    loading.document!.cancelStroke();
    let finishAfterClose!: (image: HostDocument) => void;
    const afterClose = loading.openAsync('b', () => new Promise(resolve => { finishAfterClose = resolve; }));
    loading.destroy();
    const closedDecode = makeWorkspaceImage('b');
    finishAfterClose(closedDecode);
    if (await afterClose !== null) throw new Error('Closed workspace accepted decode');
    let closedReleased = false;
    try { closedDecode.capture(); } catch { closedReleased = true; }
    if (!closedReleased) throw new Error('Closed workspace retained decoded pixels');
    const selectionCommands = makeWorkspaceImage('selection-commands');
    selectionCommands.selectAll();
    if (selectionCommands.copyPixels().image.width !== 16) throw new Error('Select all missed document bounds');
    selectionCommands.select([[[[2, 2], [6, 2], [6, 6], [2, 6], [2, 2]]]], 'replace', { feather: 1 });
    const selectionPixels = Array.from(selectionCommands.canvas.getLayer(0).context.getImageData(0, 0, 16, 16).data).join(',');
    selectionCommands.moveSelection(3, 4);
    selectionCommands.deselect();
    const selectionSaved = selectionCommands.capture(); selectionCommands.destroy();
    const selectionRestored = HostDocument.restore(selectionSaved);
    selectionRestored.reselect();
    const selected = selectionRestored.canvas.getSelection();
    if (selected?.[0]?.[0]?.[0]?.join(',') !== '5,6') throw new Error('Moved/reselected boundary lost position');
    if (selectionRestored.canvas.getKlHistory().getComposed().selection.feather !== 1) throw new Error('Reselect lost edge settings');
    if (Array.from(selectionRestored.canvas.getLayer(0).context.getImageData(0, 0, 16, 16).data).join(',') !== selectionPixels) throw new Error('Boundary move modified pixels');
    selectionRestored.destroy();
    const portImage = makeWorkspaceImage('port-probe');
    portImage.paint([[8, 8, 1]], { tool: 'brush', size: 4, opacity: 1, color: { r: 0, g: 0, b: 0 } });
    const channel = new MessageChannel();
    const portIdentity = { sessionId: 'port-case', viewId: 'port-view', generation: 1 };
    const releasePort = bindKlecksCommandPort(channel.port1, () => portIdentity, command => {
        if (command.action !== 'undo') return false;
        portImage.undo(); return true;
    });
    const sendPort = (sequence: number, generation = 1) => new Promise<string>(resolve => {
        channel.port2.addEventListener('message', event => resolve(event.data.code), { once: true });
        channel.port2.start();
        channel.port2.postMessage({ version: 1, sequence, identity: { ...portIdentity, generation }, action: 'undo' });
    });
    if (await sendPort(1, 2) !== 'STALE_TARGET' || portImage.canvas.getLayer(0).context.getImageData(8, 8, 1, 1).data[0] !== 0) throw new Error('Port accepted stale image generation');
    if (await sendPort(2) !== 'ACCEPTED' || portImage.canvas.getLayer(0).context.getImageData(8, 8, 1, 1).data[0] !== 255) throw new Error('Port command failed to reach engine');
    if (await sendPort(2) !== 'REPLAY') throw new Error('Port accepted duplicate sequence');
    releasePort(); channel.port2.close(); portImage.destroy();
    const externalWorkspace = new HostWorkspace();
    externalWorkspace.sync(['external']);
    externalWorkspace.open('external', () => makeWorkspaceImage('external'));
    const pngCanvas = document.createElement('canvas'); pngCanvas.width = 2; pngCanvas.height = 2;
    pngCanvas.getContext('2d')!.fillStyle = 'blue'; pngCanvas.getContext('2d')!.fillRect(0, 0, 1, 1);
    const pngBlob = await new Promise<Blob>(resolve => pngCanvas.toBlob(blob => resolve(blob!), 'image/png'));
    const externalPng = { bytes: new Uint8Array(await pngBlob.arrayBuffer()), width: 2, height: 2 };
    const ownerContainer = document.createElement('div'); ownerContainer.style.cssText = 'width:128px;height:128px'; document.body.append(ownerContainer);
    const ownerRuntime = new HostEditorRuntime(ownerContainer, 'windows', { changed: () => {}, error: error => { throw error; } });
    const owner = new HostFrameWorkspace('collection-probe', ownerRuntime);
    if (ownerRuntime.state.ids.length || ownerRuntime.captureActive()) throw new Error('Frame collection created an empty canvas');
    const ownerSource = async () => ({ bytes: externalPng.bytes, widthPx: 2, heightPx: 2 });
    owner.sync([{ viewId: 'a', generation: 1 }, { viewId: 'b', generation: 1 }]);
    await ownerRuntime.openRaster('a', 'A', ownerSource); ownerRuntime.movePixels(1, 0);
    const ownerActions = ownerRuntime.captureActive()!.history.totalActions;
    owner.sync([{ viewId: 'a', generation: 1 }, { viewId: 'b', generation: 1 }, { viewId: 'c', generation: 1 }]);
    await ownerRuntime.openRaster('b', 'B', ownerSource);
    await ownerRuntime.openRaster('a', 'A', async () => { throw new Error('Retained image was initialized again'); });
    if (ownerRuntime.captureActive()!.history.totalActions !== ownerActions || !ownerRuntime.state.dirty) throw new Error('Frame collection switching lost image history');
    owner.sync([{ viewId: 'a', generation: 1 }, { viewId: 'late', generation: 1 }]);
    let ownerResolve!: (source: Awaited<ReturnType<typeof ownerSource>>) => void;
    const cancelledOpen = ownerRuntime.openRaster('late', 'Cancelled', () => new Promise(resolve => { ownerResolve = resolve; }));
    ownerRuntime.cancelLoading(); ownerResolve(await ownerSource());
    if (await cancelledOpen || ownerRuntime.state.activeId !== 'a') throw new Error('Cancelled decode changed the active document');
    const lateOpen = ownerRuntime.openRaster('late', 'Late', () => new Promise(resolve => { ownerResolve = resolve; }));
    owner.sync([{ viewId: 'a', generation: 1 }]);
    owner.sync([{ viewId: 'a', generation: 1 }, { viewId: 'late', generation: 2 }]);
    ownerResolve(await ownerSource());
    if (await lateOpen || ownerRuntime.state.activeId !== 'a') throw new Error('Removed decode revived an old image generation');
    await ownerRuntime.openRaster('late', 'New', ownerSource);
    ownerRuntime.resizeCanvas(3, 2, { horizontal: 'left', vertical: 'top' });
    owner.sync([{ viewId: 'late', generation: 3 }]);
    await ownerRuntime.openRaster('late', 'Replacement', ownerSource);
    if (ownerRuntime.state.size!.width !== 2 || ownerRuntime.state.dirty) throw new Error('Replacement image kept the previous generation state');
    let retiredRejected = false;
    try { owner.sync([{ viewId: 'late', generation: 2 }]); } catch { retiredRejected = true; }
    if (!retiredRejected) throw new Error('Retired image generation was accepted');
    ownerRuntime.previewCrop({ left: 0, top: 0, width: 1, height: 1 });
    let pendingRemovalRejected = false;
    try { owner.sync([]); } catch { pendingRemovalRejected = true; }
    if (!pendingRemovalRejected || !owner.isCurrent({ sessionId: 'collection-probe', viewId: 'late', generation: 3 })) throw new Error('Pending deletion changed frame identities');
    ownerRuntime.cancelCrop(); owner.sync([]);
    if (ownerRuntime.state.activeId || ownerRuntime.captureActive()) throw new Error('Removing the last image created a blank project');
    owner.destroy(); ownerContainer.remove();
    let transparentBackgroundRejected = false;
    try { await HostDocument.fromPng('invalid-background', 'Source', { bytes: externalPng.bytes, widthPx: 2, heightPx: 2, initialLayerKind: 'background' }); }
    catch { transparentBackgroundRejected = true; }
    if (!transparentBackgroundRejected) throw new Error('Transparent import was silently flattened into background');
    const runtimeContainer = document.createElement('div'); runtimeContainer.style.cssText = 'width:128px;height:128px'; document.body.append(runtimeContainer);
    const runtime = new HostEditorRuntime(runtimeContainer, 'windows', { changed: () => {}, error: error => { throw error; } });
    if (runtime.state.activeId !== null || runtime.captureActive() !== null) throw new Error('Empty runtime created blank document');
    runtime.sync(['first', 'second']);
    await runtime.openRaster('first', 'First', async () => ({ bytes: externalPng.bytes, widthPx: 2, heightPx: 2 }));
    const numericKey = (key: string, options: KeyboardEventInit = {}, target: HTMLElement = runtime.canvas) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
        target.dispatchEvent(event); return event.defaultPrevented;
    };
    if (!numericKey('5') || !numericKey('4') || runtime.state.brush.opacity !== 0.54) throw new Error('Runtime brush numeric opacity unavailable');
    numericKey('!', { code: 'Digit1', shiftKey: true }); numericKey('%', { code: 'Digit5', shiftKey: true });
    if (runtime.state.brush.flow !== 0.15 || runtime.state.brush.opacity !== 0.54) throw new Error('Runtime Shift-number flow changed opacity');
    runtime.setTool('eraser'); numericKey('2');
    if (Number(runtime.state.brush.opacity) !== 0.2) throw new Error('Eraser numeric opacity unavailable');
    const parameterInput = document.createElement('input'); runtimeContainer.append(parameterInput);
    if (numericKey('7', {}, parameterInput) || numericKey('7', { isComposing: true }) || Number(runtime.state.brush.opacity) !== 0.2)
        throw new Error('Numeric brush shortcut stole text or IME input');
    parameterInput.remove();
    runtime.setTool('move');
    if (numericKey('9') || Number(runtime.state.brush.opacity) !== 0.2) throw new Error('Non-painting tool changed brush opacity');
    runtime.setTool('brush'); runtime.setStroke({ tool: 'brush', size: 8, opacity: 1, flow: 1, hardness: 1, color: { r: 0, g: 0, b: 0 } });
    if (!runtime.dispatch({ action: 'selectAll' }) || !runtime.dispatch({ action: 'copy' })) throw new Error('Runtime command route unavailable');
    const beforeNavigation = runtime.captureActive()!.history.totalActions;
    const beforeWheel = runtime.state.viewport!;
    runtime.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 20, cancelable: true }));
    if (runtime.state.viewport!.y !== beforeWheel.y - 20 || runtime.state.viewport!.zoom !== beforeWheel.zoom) throw new Error('Runtime ordinary wheel did not pan');
    runtime.setWheelZoom(true);
    runtime.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 20, cancelable: true }));
    if (runtime.state.viewport!.zoom >= beforeWheel.zoom) throw new Error('Runtime wheel zoom preference did not apply');
    runtime.zoomTo(1);
    if (runtime.state.viewport!.zoom !== 1 || runtime.captureActive()!.history.totalActions !== beforeNavigation) throw new Error('Viewport navigation modified content history');
    if (runtime.state.dirty) throw new Error('Selection or viewport navigation marked image content dirty');
    runtime.dispatch({ action: 'tool', group: 'marquee', cycle: false });
    runtime.dispatch({ action: 'tool', group: 'marquee', cycle: true });
    if (runtime.state.tool !== 'ellipse') throw new Error('Runtime tool group cycle failed');
    runtime.previewCrop({ left: 0, top: 0, width: 1, height: 1 });
    if (!runtime.state.pending || runtime.state.size?.width !== 2) throw new Error('Crop preview committed before confirmation');
    runtime.cancelCrop();
    runtime.previewCrop({ left: 0, top: 0, width: 1, height: 1 }); runtime.applyCrop();
    if (Number(runtime.state.size?.width) !== 1) throw new Error('Crop confirmation did not apply');
    runtime.dispatch({ action: 'undo' });
    await runtime.openRaster('second', 'Second', async () => ({ bytes: externalPng.bytes, widthPx: 2, heightPx: 2 }));
    runtime.dispatch({ action: 'pasteInPlace' });
    const runtimeRestored = HostDocument.restore(runtime.captureActive()!);
    if (runtimeRestored.canvas.getLayerCount() !== 2) throw new Error('Runtime cross-image clipboard failed');
    runtimeRestored.destroy();
    const runtimeSaved = await runtime.exportActiveProject();
    if (!runtime.state.dirty) throw new Error('Edited runtime was not dirty before save acknowledgement');
    runtime.movePixels(1, 0);
    runtime.markSaved(runtimeSaved.saveToken);
    if (!runtime.state.dirty) throw new Error('Old save acknowledgement cleared newer edits');
    runtime.dispatch({ action: 'undo' });
    if (runtime.state.dirty) throw new Error('Undo to explicit savepoint remained dirty');
    if (!runtime.state.unapplied) throw new Error('Saving a project silently applied image edits');
    const runtimeApplication = await runtime.exportActiveRevision();
    runtime.markApplied(runtimeApplication.saveToken);
    if (runtime.state.unapplied || runtime.state.dirty) throw new Error('Acknowledged application did not update both states');
    runtime.movePixels(1, 0);
    if (!runtime.state.unapplied) throw new Error('New edit was treated as already applied');
    runtime.dispatch({ action: 'undo' });
    if (runtime.state.unapplied) throw new Error('Undo to applied revision remained unapplied');
    runtime.sync([]);
    if (runtime.markSaved(runtimeSaved.saveToken)) throw new Error('Deleted runtime image accepted old save acknowledgement');
    if (runtime.markApplied(runtimeApplication.saveToken)) throw new Error('Deleted runtime image accepted old application acknowledgement');
    if (runtime.captureActive() !== null) throw new Error('Runtime did not return to empty state');
    runtime.destroy();
    if (runtimeContainer.querySelector('canvas')) throw new Error('Runtime disposal leaked canvas');
    const runtimeReopened = new HostEditorRuntime(runtimeContainer, 'windows', { changed: () => {}, error: error => { throw error; } });
    runtimeReopened.sync(['second']);
    await runtimeReopened.openProject('second', async () => runtimeSaved.project);
    if (runtimeReopened.state.dirty || !runtimeReopened.state.unapplied) throw new Error('Saved-but-unapplied project restore states were conflated');
    if (runtimeReopened.state.viewport?.zoom !== runtimeSaved.project.metadata.hostViewport?.zoom) throw new Error('Saved runtime viewport did not restore');
    const reopenedRuntimeImage = HostDocument.restore(runtimeReopened.captureActive()!);
    if (reopenedRuntimeImage.canvas.getLayerCount() !== 2) throw new Error('Saved runtime restored flattened image');
    reopenedRuntimeImage.destroy(); runtimeReopened.destroy();
    runtimeContainer.remove();
    const lineContainer = document.createElement('div'); lineContainer.style.cssText = 'width:128px;height:64px'; document.body.append(lineContainer);
    const lineCanvas = document.createElement('canvas'); lineCanvas.width = 32; lineCanvas.height = 16;
    lineCanvas.getContext('2d')!.fillStyle = 'white'; lineCanvas.getContext('2d')!.fillRect(0, 0, 32, 16);
    const linePng = await new Promise<Blob>(resolve => lineCanvas.toBlob(blob => resolve(blob!), 'image/png'));
    const lineSource = { bytes: new Uint8Array(await linePng.arrayBuffer()), widthPx: 32, heightPx: 16 };
    const lineRuntime = new HostEditorRuntime(lineContainer, 'windows', { changed: () => {}, error: error => { throw error; } });
    lineRuntime.sync(['line-a', 'line-b']); await lineRuntime.openRaster('line-a', 'Line A', async () => lineSource);
    lineRuntime.setStroke({ tool: 'brush', size: 2, opacity: 1, flow: 1, hardness: 1, color: { r: 0, g: 0, b: 0 } });
    lineRuntime.canvas.setPointerCapture = () => {}; lineRuntime.canvas.hasPointerCapture = () => false;
    const linePointer = (type: string, x: number, y: number, shiftKey = false) => {
        const point = imageToScreen(lineRuntime.state.viewport!, { x, y }), box = lineRuntime.canvas.getBoundingClientRect();
        lineRuntime.canvas.dispatchEvent(new PointerEvent(type, {
            clientX: box.left + point.x, clientY: box.top + point.y, shiftKey, pointerId: 1, pointerType: 'mouse', button: 0, bubbles: true,
        }));
    };
    const lineClick = (x: number, y: number, shiftKey = false, cancel = false) => {
        for (const type of ['pointerdown', cancel ? 'pointercancel' : 'pointerup']) linePointer(type, x, y, shiftKey);
    };
    const linePixel = (x: number, y: number) => {
        const image = HostDocument.restore(lineRuntime.captureActive()!);
        try { return image.canvas.getLayer(0).context.getImageData(x, y, 1, 1).data[0]; } finally { image.destroy(); }
    };
    lineClick(3.5, 8.5);
    const beforeLine = lineRuntime.captureActive()!.history.totalActions;
    lineClick(25.5, 8.5, true);
    if (linePixel(14, 8) !== 0 || lineRuntime.captureActive()!.history.totalActions !== beforeLine + 1)
        throw new Error('Shift-click did not connect a single undoable brush stroke');
    lineRuntime.dispatch({ action: 'undo' });
    if (linePixel(14, 8) !== 255 || linePixel(3, 8) !== 0) throw new Error('Shift line undo removed the previous stroke');
    lineRuntime.dispatch({ action: 'redo' });
    await lineRuntime.openRaster('line-b', 'Line B', async () => lineSource); lineClick(25.5, 8.5, true);
    if (linePixel(14, 8) !== 255) throw new Error('Shift brush endpoint leaked across images');
    lineRuntime.activate('line-a');
    lineClick(25.5, 3.5, true, true);
    if (linePixel(25, 5) !== 255) throw new Error('Cancelled Shift line left pixels');
    lineClick(3.5, 3.5, true);
    if (linePixel(14, 3) !== 255 || linePixel(14, 6) !== 0) throw new Error('Cancelled line replaced the last committed endpoint');
    lineRuntime.sync(['line-b']); lineRuntime.sync(['line-a', 'line-b']);
    await lineRuntime.openRaster('line-a', 'New A', async () => lineSource); lineClick(25.5, 3.5, true);
    if (linePixel(14, 3) !== 255) throw new Error('Retired image endpoint survived document replacement');
    lineRuntime.sync([]); lineRuntime.sync(['line-a']);
    await lineRuntime.openRaster('line-a', 'Axis A', async () => lineSource);
    const axisHistory = lineRuntime.captureActive()!.history.totalActions;
    linePointer('pointerdown', 3.5, 4.5, true);
    linePointer('pointermove', 25.5, 6.5, true); linePointer('pointermove', 25.5, 12.5, true);
    linePointer('pointerup', 25.5, 12.5, true);
    if (linePixel(14, 4) !== 0 || linePixel(25, 10) !== 255 || lineRuntime.captureActive()!.history.totalActions !== axisHistory + 1)
        throw new Error('Shift-drag axis constraint changed pixels or history incorrectly');
    lineRuntime.dispatch({ action: 'undo' });
    if (linePixel(14, 4) !== 255) throw new Error('Constrained stroke did not undo');
    lineRuntime.dispatch({ action: 'redo' });
    const beforeMarqueeView = JSON.stringify(lineRuntime.state.viewport);
    const beforeMarquee = HostDocument.restore(lineRuntime.captureActive()!); const beforeMarqueePixels = beforeMarquee.contentIdentity(); beforeMarquee.destroy();
    lineRuntime.setTool('rectangle'); linePointer('pointerdown', 2, 2); linePointer('pointermove', 10, 6);
    lineRuntime.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
    linePointer('pointermove', 14, 8);
    lineRuntime.canvas.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
    linePointer('pointerup', 14, 8);
    const movedMarquee = HostDocument.restore(lineRuntime.captureActive()!);
    try {
        if (JSON.stringify(movedMarquee.canvas.getSelection()?.[0]?.[0]) !== JSON.stringify([[6, 4], [14, 4], [14, 8], [6, 8], [6, 4]]) ||
            movedMarquee.contentIdentity() !== beforeMarqueePixels || JSON.stringify(lineRuntime.state.viewport) !== beforeMarqueeView)
            throw new Error('Space moved canvas/pixels or resized the drawing marquee');
    } finally { movedMarquee.destroy(); }
    const boundaryHistory = lineRuntime.captureActive()!.history.totalActions;
    const boundaryRevision = lineRuntime.state.checkpointRevision;
    linePointer('pointerdown', 8, 6); linePointer('pointermove', 12, 8);
    if (lineRuntime.state.checkpointRevision !== boundaryRevision || !lineRuntime.state.pending) throw new Error('Boundary preview committed or lost its pending gesture');
    linePointer('pointerup', 12, 8);
    const boundaryMoved = HostDocument.restore(lineRuntime.captureActive()!);
    const movedBoundary = JSON.stringify([[10, 6], [18, 6], [18, 10], [10, 10], [10, 6]]);
    try {
        if (JSON.stringify(boundaryMoved.canvas.getSelection()?.[0]?.[0]) !== movedBoundary || boundaryMoved.contentIdentity() !== beforeMarqueePixels ||
            lineRuntime.captureActive()!.history.totalActions !== boundaryHistory + 1) throw new Error('Boundary drag moved pixels or replaced the selection');
    } finally { boundaryMoved.destroy(); }
    linePointer('pointerdown', 12, 8); linePointer('pointermove', 14, 10); linePointer('pointercancel', 14, 10);
    const cancelledBoundary = HostDocument.restore(lineRuntime.captureActive()!);
    if (JSON.stringify(cancelledBoundary.canvas.getSelection()?.[0]?.[0]) !== movedBoundary) throw new Error('Cancelled boundary drag changed selection');
    cancelledBoundary.select([[[[0, 0], [20, 0], [20, 15], [0, 15], [0, 0]], [[4, 4], [4, 10], [10, 10], [10, 4], [4, 4]]]], 'replace');
    if (!cancelledBoundary.selectionContains(2, 2) || cancelledBoundary.selectionContains(7, 7) || cancelledBoundary.selectionContains(25, 12))
        throw new Error('Selection hit test treated holes or bounds as selected interior');
    cancelledBoundary.destroy();
    lineRuntime.dispatch({ action: 'undo' });
    const undoneBoundary = HostDocument.restore(lineRuntime.captureActive()!);
    if (JSON.stringify(undoneBoundary.canvas.getSelection()?.[0]?.[0]) !== JSON.stringify([[6, 4], [14, 4], [14, 8], [6, 8], [6, 4]]) || undoneBoundary.contentIdentity() !== beforeMarqueePixels)
        throw new Error('Boundary movement did not undo independently of pixels');
    undoneBoundary.destroy();
    lineRuntime.zoomTo(2);
    const nudgeView = JSON.stringify(lineRuntime.state.viewport);
    const arrowKey = (key: string, shiftKey = false) => lineRuntime.canvas.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
    if (arrowKey('ArrowRight') || arrowKey('ArrowDown', true)) throw new Error('Nudge keyboard input escaped to browser defaults');
    const nudgedSelection = HostDocument.restore(lineRuntime.captureActive()!);
    try {
        if (JSON.stringify(nudgedSelection.canvas.getSelection()?.[0]?.[0]) !== JSON.stringify([[7, 14], [15, 14], [15, 18], [7, 18], [7, 14]]) ||
            nudgedSelection.contentIdentity() !== beforeMarqueePixels || JSON.stringify(lineRuntime.state.viewport) !== nudgeView)
            throw new Error('Selection arrows used display units or modified pixels/viewport');
    } finally { nudgedSelection.destroy(); }
    lineRuntime.dispatch({ action: 'undo' }); lineRuntime.dispatch({ action: 'undo' });
    lineRuntime.setTool('move'); arrowKey('ArrowDown');
    const nudgedPixels = HostDocument.restore(lineRuntime.captureActive()!);
    try {
        const context = nudgedPixels.canvas.getLayer(0).context;
        if (context.getImageData(10, 4, 1, 1).data[3] !== 0 || context.getImageData(10, 5, 1, 1).data[0] !== 0 ||
            context.getImageData(10, 5, 1, 1).data[3] !== 255 || context.getImageData(3, 4, 1, 1).data[3] !== 255)
            throw new Error('Move-tool arrow did not move selected pixels by one document pixel');
    } finally { nudgedPixels.destroy(); }
    lineRuntime.dispatch({ action: 'undo' });
    if (linePixel(10, 4) !== 0) throw new Error('Pixel nudge did not undo');
    const reselectSource = HostDocument.restore(lineRuntime.captureActive()!);
    reselectSource.select(reselectSource.canvas.getSelection(), 'replace', { feather: 2, antiAlias: false });
    const reselectGeometry = JSON.stringify(reselectSource.canvas.getSelection());
    const reselectProject = await reselectSource.exportProject(); reselectSource.destroy();
    lineRuntime.sync(['reselect']); await lineRuntime.openProject('reselect', async () => reselectProject);
    const importedReselect = HostDocument.restore(lineRuntime.captureActive()!);
    const reselectPixels = importedReselect.contentIdentity(); importedReselect.destroy();
    const selectionKey = (shiftKey: boolean) => lineRuntime.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'D', ctrlKey: true, shiftKey, bubbles: true, cancelable: true }));
    if (selectionKey(false)) throw new Error('Deselect escaped the editor');
    const deselected = HostDocument.restore(lineRuntime.captureActive()!);
    if (deselected.canvas.getSelection() !== undefined) throw new Error('Deselect did not remove active selection');
    deselected.destroy();
    if (selectionKey(true)) throw new Error('Reselect shortcut escaped the editor');
    const reselected = HostDocument.restore(lineRuntime.captureActive()!);
    try {
        const project = await reselected.exportProject();
        if (JSON.stringify(reselected.canvas.getSelection()) !== reselectGeometry || project.metadata.selection.feather !== 2 || project.metadata.selection.antiAlias !== false ||
            reselected.contentIdentity() !== reselectPixels || lineRuntime.state.dirty) throw new Error(JSON.stringify({ message: 'Reselect lost edge settings or changed image pixels',
                geometry: JSON.stringify(reselected.canvas.getSelection()) === reselectGeometry, feather: project.metadata.selection.feather, antiAlias: project.metadata.selection.antiAlias,
                sameContent: reselected.contentIdentity() === reselectPixels, dirty: lineRuntime.state.dirty }));
    } finally { reselected.destroy(); }
    lineRuntime.dispatch({ action: 'undo' });
    const undoneReselect = HostDocument.restore(lineRuntime.captureActive()!);
    if (undoneReselect.canvas.getSelection() !== undefined) throw new Error('Reselect did not enter undo history');
    undoneReselect.destroy();
    lineRuntime.destroy(); lineContainer.remove();
    const rasterWorkspace = new HostWorkspace();
    rasterWorkspace.sync(['raster', 'other']);
    const raster = await rasterWorkspace.openRaster('raster', 'Full raster', async () => ({ bytes: externalPng.bytes, widthPx: 2, heightPx: 2 }));
    if (!raster || raster.canvas.getWidth() !== 2 || raster.canvas.getLayer(0).name !== 'Full raster') throw new Error('Prepared source did not initialize document');
    if (raster.canvas.getLayer(0).context.getImageData(0, 0, 1, 1).data[2] !== 255 || raster.canvas.getLayer(0).context.getImageData(1, 1, 1, 1).data[3] !== 0) throw new Error('Prepared raster changed pixels or transparency');
    const displayContainer = document.createElement('div'); displayContainer.style.cssText = 'width:64px;height:64px'; document.body.append(displayContainer);
    const display = new HostCanvasSurface(displayContainer, rasterWorkspace);
    const displayRatio = window.devicePixelRatio || 1;
    rasterWorkspace.setViewport({ x: 16, y: 16, zoom: 8 * displayRatio, pixelRatio: displayRatio }); display.redraw();
    const displayPixel = (x: number, y: number) => Array.from(display.canvas.getContext('2d')!.getImageData(x * displayRatio, y * displayRatio, 1, 1).data).join(',');
    if (displayPixel(1, 1) !== '229,231,235,255' || displayPixel(17, 17) !== '0,0,255,255' || displayPixel(25, 25) !== '209,213,219,255') throw new Error('Document/transparent/outside display boundaries differ');
    if (display.canvas.width !== Math.round(64 * displayRatio) || raster.canvas.getLayer(0).context.getImageData(1, 1, 1, 1).data[3] !== 0) throw new Error('Display background entered document pixels or DPI backing size is wrong');
    const beforePreview = display.canvas.toDataURL();
    display.previewSelection([[[[0.25, 0.25], [1.75, 0.25], [1.75, 1.75], [0.25, 1.75], [0.25, 0.25]]]]);
    if (display.canvas.toDataURL() === beforePreview || raster.canvas.getSelection() !== undefined) throw new Error('Selection preview is invisible or committed to history');
    display.previewSelection(null);
    if (display.canvas.toDataURL() !== beforePreview) throw new Error('Selection preview cancel did not restore display');
    display.fit();
    if (rasterWorkspace.viewport?.zoom !== 32 * displayRatio) throw new Error('Display fit changed physical zoom semantics');
    display.destroy(); displayContainer.remove();
    rasterWorkspace.open('other', () => makeWorkspaceImage('other'));
    await rasterWorkspace.openRaster('raster', 'Ignored', async () => { throw new Error('Prepared image loaded twice'); });
    if (rasterWorkspace.document!.canvas.getWidth() !== 2) throw new Error('Prepared image was rebuilt on switch');
    rasterWorkspace.destroy();
    if (!await externalWorkspace.pasteExternalPng(externalPng)) throw new Error('External PNG paste was rejected');
    const externalLayer = externalWorkspace.document!.canvas.getLayer(1);
    if (externalLayer.context.getImageData(7, 7, 1, 1).data[2] !== 255 || externalLayer.context.getImageData(8, 8, 1, 1).data[3] !== 0) throw new Error('External PNG lost size or transparency');
    externalWorkspace.document!.undo();
    if (externalWorkspace.document!.canvas.getLayerCount() !== 1) throw new Error('External paste was not one undo unit');
    let mismatchedPngBlocked = false;
    try { await externalWorkspace.pasteExternalPng({ ...externalPng, width: 3 }); } catch { mismatchedPngBlocked = true; }
    if (!mismatchedPngBlocked || externalWorkspace.document!.canvas.getLayerCount() !== 1) throw new Error('Mismatched PNG modified destination');
    const mutablePng = { ...externalPng, bytes: new Uint8Array(externalPng.bytes) };
    const ownedPaste = externalWorkspace.pasteExternalPng(mutablePng);
    mutablePng.bytes.fill(0);
    if (!await ownedPaste) throw new Error('Caller mutation invalidated owned PNG');
    externalWorkspace.document!.undo();
    const stalePasteTarget = externalWorkspace.captureTarget();
    externalWorkspace.sync([]); externalWorkspace.sync(['external']);
    externalWorkspace.open('external', () => makeWorkspaceImage('external'));
    if (await externalWorkspace.pasteExternalPng(externalPng, stalePasteTarget)) throw new Error('External paste crossed image generation');
    const pasteDuringDelete = externalWorkspace.pasteExternalPng(externalPng);
    externalWorkspace.sync([]);
    if (await pasteDuringDelete) throw new Error('Decode completion revived deleted image');
    externalWorkspace.destroy();
    const red = new ImageData(new Uint8ClampedArray([
        255, 0, 0, 255, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
    ]), 2, 2);
    const history = new KlHistory({ oldest: {
        projectId: { value: 'probe-a' }, size: { width: 2, height: 2 },
        selection: { value: [[[[0, 0], [2, 0], [2, 2], [0, 0]]]] },
        activeLayerId: 'layer-a', layerMap: { 'layer-a': {
            index: 0, name: 'Pixel layer', opacity: 0.5, isVisible: true,
            mixModeStr: 'source-over', hasClipping: false,
            tiles: [{ id: 'red', data: red }],
        } },
    } });
    const canvas = new KlCanvas(history);
    history.push({ layerMap: { 'layer-a': { name: 'Changed' } } });
    history.decreaseIndex();
    const saved = history.exportSnapshot();
    canvas.destroy();
    const restored = KlHistory.fromSnapshot(saved);
    const rebuilt = new KlCanvas(restored);
    const pixel = Array.from(rebuilt.getLayer(0).context.getImageData(0, 0, 1, 1).data);
    if (pixel.join(',') !== '255,0,0,255') throw new Error('Pixel restoration mismatch');
    if (restored.getComposed().layerMap['layer-a'].opacity !== 0.5) throw new Error('Opacity mismatch');
    if (!restored.getComposed().selection.value?.length) throw new Error('Selection missing');
    if (!restored.canRedo()) throw new Error('Redo missing');
    const before = restored.getComposed();
    restored.increaseIndex();
    rebuilt.updateViaComposed(before, restored.getComposed());
    if (rebuilt.getLayer(0).name !== 'Changed') throw new Error('Redo not reflected in canvas');
    rebuilt.destroy();
    const images = Array.from({ length: 9 }, (_, index) => new HostDocument({
        projectId: `document-${index}`, width: 2, height: 2,
        layers: [
            { name: `base-${index}`, opacity: 1, isVisible: true, hasClipping: false,
                mixModeStr: 'source-over', image: [{ id: `pixel-${index}`, data: red }] },
            { name: 'transparent', opacity: 0.5, isVisible: false, hasClipping: false,
                mixModeStr: 'source-over', image: { fill: 'transparent' } },
        ],
    }));
    const states = images.map((image, index) => {
        image.canvas.renameLayer(0, `edited-${index}`);
        image.undo();
        const state = image.capture();
        image.destroy();
        return state;
    });
    for (const [index, state] of states.entries()) {
        const image = HostDocument.restore(state);
        if (image.canvas.getLayerCount() !== 2) throw new Error('Layer count mismatch');
        image.redo();
        if (image.canvas.getLayer(0).name !== `edited-${index}`) throw new Error('Cross-document history mismatch');
        const psd = await image.exportPSD();
        if (psd.size === 0) throw new Error('PSD empty');
        const decoded = readPsd(await psd.arrayBuffer());
        if (decoded.children?.length !== 2 || decoded.children[0].name !== `edited-${index}` ||
            decoded.children[1].hidden !== true || Math.abs(decoded.children[1].opacity! - 0.5) > 0.01) {
            throw new Error('PSD roundtrip layer attributes mismatch');
        }
        const decodedPixel = decoded.children[0].canvas!.getContext('2d')!.getImageData(0, 0, 1, 1).data;
        if (Array.from(decodedPixel).join(',') !== '255,0,0,255') throw new Error('PSD pixel mismatch');
        image.destroy();
    }
    const painting = new HostDocument({ projectId: 'painting', width: 16, height: 16, layers: [{
        name: 'drawing', opacity: 1, isVisible: true, hasClipping: false,
        mixModeStr: 'source-over', image: { fill: 'white' },
    }] });
    painting.canvas.setSelection([[[[0, 0], [8, 0], [8, 16], [0, 16], [0, 0]]]]);
    painting.paint([[4, 8, 1], [12, 8, 1]], { tool: 'brush', size: 4, opacity: 1, color: { r: 0, g: 0, b: 0 } });
    const paintPixel = () => Array.from(painting.canvas.getLayer(0).context.getImageData(4, 8, 1, 1).data);
    if (paintPixel()[0] !== 0) throw new Error('Real brush did not paint');
    if (painting.canvas.getLayer(0).context.getImageData(12, 8, 1, 1).data[0] !== 255) throw new Error('Brush ignored selection');
    painting.undo();
    if (paintPixel()[0] !== 255) throw new Error('Brush undo failed');
    painting.redo();
    painting.paint([[4, 8, 1]], { tool: 'eraser', size: 8, opacity: 1, color: { r: 0, g: 0, b: 0 } });
    if (paintPixel()[3] !== 0) throw new Error('Real eraser did not clear alpha');
    painting.undo();
    if (paintPixel()[3] !== 255 || paintPixel()[0] !== 0) throw new Error('Eraser undo failed');
    const baseline = Array.from(painting.canvas.getLayer(0).context.getImageData(0, 0, 16, 16).data);
    const options = { tool: 'brush' as const, size: 4, opacity: 1, color: { r: 255, g: 0, b: 0 } };
    painting.beginStroke([4, 4, 1], options);
    painting.moveStroke([4, 10, 1]);
    let captureBlocked = false;
    try { painting.capture(); } catch { captureBlocked = true; }
    if (!captureBlocked) throw new Error('Half stroke was captured');
    painting.cancelStroke();
    const cancelled = Array.from(painting.canvas.getLayer(0).context.getImageData(0, 0, 16, 16).data);
    if (baseline.join(',') !== cancelled.join(',')) throw new Error('Stroke cancellation changed pixels');
    painting.beginStroke([4, 4, 1], options);
    painting.moveStroke([4, 10, 1]);
    painting.endStroke();
    painting.undo();
    const undone = Array.from(painting.canvas.getLayer(0).context.getImageData(0, 0, 16, 16).data);
    if (baseline.join(',') !== undone.join(',')) throw new Error('Interactive stroke undo changed prior state');
    const rect = (left: number, right: number): MultiPolygon => [[[[left, 0], [right, 0], [right, 8], [left, 8], [left, 0]]]];
    painting.select(rect(0, 4), 'replace');
    painting.select(rect(4, 8), 'add');
    if (painting.copyPixels().image.width !== 8) throw new Error('Selection add failed');
    painting.select(rect(4, 8), 'subtract');
    if (painting.copyPixels().image.width !== 4) throw new Error('Selection subtract failed');
    painting.select(rect(2, 6), 'intersect');
    if (painting.copyPixels().image.width !== 2) throw new Error('Selection intersection failed');
    painting.select(rect(2, 6), 'subtract');
    let emptyCopyBlocked = false;
    try { painting.copyPixels(); } catch { emptyCopyBlocked = true; }
    if (!emptyCopyBlocked) throw new Error('Empty selection copied');
    painting.select([[[[2, 2], [10, 2], [2, 10], [2, 2]]]], 'replace');
    const clip = painting.copyPixels();
    if (clip.x !== 2 || clip.y !== 2 || clip.image.width !== 8) throw new Error('Copy origin/dimensions mismatch');
    if (clip.image.data[(6 * 8 + 6) * 4 + 3] !== 0) throw new Error('Copied outside lasso');
    const cut = painting.cutPixels();
    if (cut.x !== clip.x || painting.canvas.getLayer(0).context.getImageData(3, 3, 1, 1).data[3] !== 0) throw new Error('Cut failed');
    if (painting.canvas.getLayer(0).context.getImageData(13, 13, 1, 1).data[3] !== 255) throw new Error('Cut cleared outside selection');
    painting.undo();
    if (painting.canvas.getLayer(0).context.getImageData(3, 3, 1, 1).data[3] !== 255) throw new Error('Cut undo failed');
    const newId = painting.newLayer('Working');
    painting.setActiveLayer(newId);
    painting.deleteLayer(newId);
    if (painting.canvas.getLayerCount() !== 1) throw new Error('Layer deletion failed');
    let lastLayerBlocked = false;
    try { painting.deleteLayer(painting.canvas.getLayer(0).id); } catch { lastLayerBlocked = true; }
    if (!lastLayerBlocked) throw new Error('Last layer deletion was not blocked');
    const workingId = painting.newLayer('Attributes');
    painting.renameLayer(workingId, 'Renamed');
    painting.setLayerOpacity(workingId, 0.25);
    painting.setLayerVisibility(workingId, false);
    const attrSnapshot = painting.capture();
    const attrRestored = HostDocument.restore(attrSnapshot);
    const attrLayer = attrRestored.canvas.getLayers().find(layer => layer.id === workingId)!;
    if (attrLayer.name !== 'Renamed' || attrLayer.opacity !== 0.25 || attrLayer.isVisible) throw new Error('Layer attributes did not restore');
    attrRestored.setLayerVisibility(workingId, true);
    attrRestored.moveLayer(workingId, 0);
    if (attrRestored.canvas.getLayer(0).id !== workingId) throw new Error('Layer reorder failed');
    attrRestored.undo();
    if (attrRestored.canvas.getLayer(1).id !== workingId) throw new Error('Layer reorder undo failed');
    const duplicateId = attrRestored.duplicateLayer(workingId);
    if (attrRestored.canvas.getLayerCount() !== 3 || duplicateId === workingId) throw new Error('Layer duplication failed');
    attrRestored.mergeDown(duplicateId);
    if (attrRestored.canvas.getLayerCount() !== 2) throw new Error('Layer merge failed');
    attrRestored.undo();
    if (attrRestored.canvas.getLayerCount() !== 3) throw new Error('Layer merge undo failed');
    attrRestored.setLayerLocks(workingId, { all: true });
    attrRestored.setActiveLayer(workingId);
    let lockedClearBlocked = false;
    try { attrRestored.clearPixels(); } catch { lockedClearBlocked = true; }
    if (!lockedClearBlocked) throw new Error('Locked layer was cleared');
    const lockedSnapshot = attrRestored.capture();
    const lockedRestored = HostDocument.restore(lockedSnapshot);
    if (!lockedRestored.getLayerLocks(workingId).all) throw new Error('Layer lock missing after restore');
    lockedRestored.setLayerLocks(workingId, { all: false, pixels: true });
    let lockedPaintBlocked = false;
    try { lockedRestored.paint([[4, 4, 1]], options); } catch { lockedPaintBlocked = true; }
    if (!lockedPaintBlocked) throw new Error('Pixel lock ignored');
    lockedRestored.undo();
    if (!lockedRestored.getLayerLocks(workingId).all) throw new Error('Layer lock undo failed');
    const projectBundle = await lockedRestored.exportProject();
    projectBundle.metadata = JSON.parse(JSON.stringify(projectBundle.metadata));
    projectBundle.psd = new Blob([await projectBundle.psd.arrayBuffer()], { type: projectBundle.psd.type });
    lockedRestored.destroy();
    const reopened = await HostDocument.openProject(projectBundle);
    if (!reopened.getLayerLocks(workingId).all || reopened.canvas.getLayerCount() !== 3 ||
        reopened.canvas.getKlHistory().getComposed().activeLayerId !== workingId ||
        !reopened.canvas.getSelection()?.length) throw new Error('Project metadata restore failed');
    reopened.setLayerLocks(workingId, { all: false, pixels: false });
    reopened.renameLayer(workingId, 'Continue editing');
    if (!reopened.canvas.getLayers().some(layer => layer.name === 'Continue editing')) throw new Error('Reopened project is not editable');
    reopened.destroy();
    const opacityDocument = new HostDocument({ projectId: 'opacity', width: 16, height: 16, layers: [{
        name: 'opacity', opacity: 1, isVisible: true, hasClipping: false, mixModeStr: 'source-over', image: { fill: 'transparent' },
    }] });
    const half = { tool: 'brush' as const, size: 8, opacity: 0.5, flow: 1, color: { r: 0, g: 0, b: 0 } };
    opacityDocument.paint([[4, 8, 1], [12, 8, 1], [4, 8, 1], [12, 8, 1]], half);
    const alphaAtCenter = () => opacityDocument.canvas.getLayer(0).context.getImageData(8, 8, 1, 1).data[3];
    if (alphaAtCenter() < 126 || alphaAtCenter() > 129) throw new Error('Stroke exceeded opacity cap');
    opacityDocument.paint([[4, 8, 1], [12, 8, 1]], half);
    if (alphaAtCenter() < 189 || alphaAtCenter() > 194) throw new Error('Separate strokes did not accumulate');
    opacityDocument.undo();
    opacityDocument.undo();
    opacityDocument.paint([[8, 8, 1]], { ...half, flow: 0.1 });
    if (alphaAtCenter() >= 126 || alphaAtCenter() <= 0) throw new Error('Flow is not independent of opacity');
    opacityDocument.undo();
    opacityDocument.paint([[8, 8, 1]], { ...half, opacity: 1, size: 16, hardness: 1 });
    const edgeAlpha = () => opacityDocument.canvas.getLayer(0).context.getImageData(14, 8, 1, 1).data[3];
    const hardEdge = edgeAlpha();
    opacityDocument.undo();
    opacityDocument.paint([[8, 8, 1]], { ...half, opacity: 1, size: 16, hardness: 0 });
    if (edgeAlpha() >= hardEdge || edgeAlpha() <= 0) throw new Error('Brush hardness ignored');
    opacityDocument.undo();
    opacityDocument.paint([[8, 8, 1]], { ...half, opacity: 1, size: 16, hardness: 1 });
    opacityDocument.paint([[4, 8, 1], [12, 8, 1], [4, 8, 1], [12, 8, 1]], { ...half, tool: 'eraser', hardness: 1 });
    if (alphaAtCenter() < 126 || alphaAtCenter() > 129) throw new Error('Eraser stroke exceeded opacity cap');
    opacityDocument.destroy();
    const feathered = new HostDocument({ projectId: 'feather', width: 24, height: 24, layers: [{
        name: 'feather', opacity: 1, isVisible: true, hasClipping: false, mixModeStr: 'source-over', image: { fill: 'transparent' },
    }] });
    feathered.select([[[[8, 8], [16, 8], [16, 16], [8, 16], [8, 8]]]], 'replace', { feather: 2, antiAlias: true });
    feathered.paint([[12, 12, 1]], { tool: 'brush', size: 40, opacity: 1, color: { r: 0, g: 0, b: 0 } });
    const edge = feathered.canvas.getLayer(0).context.getImageData(7, 12, 1, 1).data[3];
    const center = feathered.canvas.getLayer(0).context.getImageData(12, 12, 1, 1).data[3];
    if (edge <= 0 || edge >= center) throw new Error('Feathered paint mask missing');
    feathered.undo();
    feathered.canvas.drawOperation(0, () => {
        const context = feathered.canvas.getLayer(0).context;
        context.fillStyle = '#000'; context.fillRect(0, 0, 24, 24);
    });
    const featherCopy = feathered.copyPixels();
    const copiedEdge = featherCopy.image.data[((12 - featherCopy.y) * featherCopy.image.width + 7 - featherCopy.x) * 4 + 3];
    if (copiedEdge !== edge) throw new Error('Copy and paint feather coverage differ');
    feathered.clearPixels();
    const clearedEdge = feathered.canvas.getLayer(0).context.getImageData(7, 12, 1, 1).data[3];
    if (Math.abs(clearedEdge + edge - 255) > 1) throw new Error('Clear and paint feather coverage differ');
    feathered.undo();
    if (feathered.canvas.getLayer(0).context.getImageData(7, 12, 1, 1).data[3] !== 255) throw new Error('Feather clear undo failed');
    const featherProject = await feathered.exportProject();
    feathered.destroy();
    const featherOpened = await HostDocument.openProject(featherProject);
    if (featherOpened.canvas.getKlHistory().getComposed().selection.feather !== 2) throw new Error('Feather state did not persist');
    featherOpened.destroy();
    const cropping = new HostDocument({ projectId: 'crop', width: 16, height: 16, layers: [{
        name: 'crop', opacity: 1, isVisible: true, hasClipping: false, mixModeStr: 'source-over', image: { fill: 'red' },
    }] });
    cropping.crop({ left: 4, top: 4, width: 8, height: 8 }, false);
    const cropOriginalId = cropping.canvas.getLayer(0).id;
    cropping.setLayerLocks(cropOriginalId, { alpha: true });
    const cropDuplicateId = cropping.duplicateLayer(cropOriginalId);
    if (!cropping.getLayerLocks(cropDuplicateId).alpha) throw new Error('Duplicate dropped layer locks');
    cropping.crop({ left: -4, top: -4, width: 16, height: 16 }, false);
    if (cropping.canvas.getLayer(1).context.getImageData(1, 1, 1, 1).data[3] !== 255) throw new Error('Duplicate dropped crop backing');
    cropping.undo(); cropping.undo();
    if (cropping.canvas.getLayerCount() !== 1) throw new Error('Duplicate was not one undo unit');
    cropping.undo(); cropping.undo();
    cropping.crop({ left: 4, top: 4, width: 8, height: 8 }, false);
    cropping.paint([[4, 4, 1]], { tool: 'brush', size: 4, opacity: 1, color: { r: 0, g: 0, b: 255 } });
    const cropProject = await cropping.exportProject();
    cropProject.metadata = JSON.parse(JSON.stringify(cropProject.metadata));
    let missingBackingBlocked = false;
    try { await HostDocument.openProject({ ...cropProject, backings: [] }); } catch { missingBackingBlocked = true; }
    if (!missingBackingBlocked) throw new Error('Missing crop backing silently accepted');
    cropping.destroy();
    const mergeCropped = new HostDocument({ projectId: 'merge-crop', width: 16, height: 16,
        layers: ['red', 'blue'].map(fill => ({ name: fill, opacity: 1, isVisible: true,
            hasClipping: false, mixModeStr: 'source-over' as const, image: { fill } })) });
    mergeCropped.crop({ left: 4, top: 4, width: 8, height: 8 }, false);
    mergeCropped.mergeDown(mergeCropped.canvas.getLayer(1).id);
    mergeCropped.crop({ left: -4, top: -4, width: 16, height: 16 }, false);
    const mergedOutside = mergeCropped.canvas.getLayer(0).context.getImageData(1, 1, 1, 1).data;
    if (mergedOutside[2] !== 255 || mergedOutside[0] !== 0) throw new Error('Merge lost outside pixels');
    mergeCropped.undo(); mergeCropped.undo();
    if (mergeCropped.canvas.getLayerCount() !== 2) throw new Error('Merge was not one undo unit');
    mergeCropped.destroy();
    const applying = new HostDocument({ projectId: 'apply-freeze', width: 16, height: 8, layers: [{ name: 'base', opacity: 1,
        isVisible: true, hasClipping: false, mixModeStr: 'source-over', image: { fill: 'red' } }] });
    const applyingBundle = applying.exportRevision();
    applying.paint([[8, 4, 1]], { tool: 'brush', size: 8, opacity: 1, color: { r: 0, g: 0, b: 255 } });
    const appliedBundle = await applyingBundle;
    const appliedProject = await HostDocument.openProject(appliedBundle.project);
    if (appliedProject.canvas.getLayer(0).context.getImageData(8, 4, 1, 1).data[0] !== 255) throw new Error('Applied project mixed a later edit');
    for (const output of [appliedBundle.composite, appliedBundle.thumbnail]) {
        const bitmap = await createImageBitmap(output.blob);
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0); bitmap.close();
        if (canvas.width !== output.width || canvas.height !== output.height || canvas.getContext('2d')!.getImageData(8, 4, 1, 1).data[0] !== 255) throw new Error('Applied image dimensions or revision mismatch');
    }
    if (applying.canvas.getLayer(0).context.getImageData(8, 4, 1, 1).data[2] !== 255) throw new Error('Frozen export overwrote later edits');
    appliedProject.destroy(); applying.destroy();
    const transparentRevision = new HostDocument({ projectId: 'transparent-revision', width: 16, height: 8,
        layers: [{ name: 'transparent', opacity: 1, isVisible: true, hasClipping: false, mixModeStr: 'source-over', image: { fill: 'transparent' } }] });
    const transparentBundle = await transparentRevision.exportRevision(4);
    if (transparentBundle.composite.width !== 16 || transparentBundle.thumbnail.width !== 4 || transparentBundle.thumbnail.height !== 2) throw new Error('Revision thumbnail replaced full resolution output');
    const transparentBitmap = await createImageBitmap(transparentBundle.composite.blob);
    const alphaCanvas = document.createElement('canvas'); alphaCanvas.width = 16; alphaCanvas.height = 8;
    alphaCanvas.getContext('2d')!.drawImage(transparentBitmap, 0, 0); transparentBitmap.close();
    if (alphaCanvas.getContext('2d')!.getImageData(0, 0, 1, 1).data[3] !== 0) throw new Error('Editor revision was flattened against display background');
    transparentRevision.destroy();
    const rotating = new HostDocument({ projectId: 'rotate-crop', width: 16, height: 8, layers: [{ name: 'rotate', opacity: 1,
        isVisible: true, hasClipping: false, mixModeStr: 'source-over', image: { fill: 'red' } }] });
    rotating.canvas.drawOperation(0, () => { const context = rotating.canvas.getLayer(0).context; context.fillStyle = 'blue'; context.fillRect(0, 0, 2, 2); });
    rotating.crop({ left: 4, top: 2, width: 8, height: 4 }, false);
    rotating.select([[[[1, 1], [3, 1], [3, 2], [1, 2], [1, 1]]]], 'replace', { feather: 1 });
    rotating.rotateCanvas(90);
    if (rotating.canvas.getWidth() !== 4 || rotating.canvas.getHeight() !== 8) throw new Error('Canvas rotation dimensions mismatch');
    rotating.undo();
    if (rotating.canvas.getWidth() !== 8 || rotating.canvas.getSelection()?.[0]?.[0]?.[0]?.join(',') !== '1,1') throw new Error('Rotation undo changed more than one operation');
    rotating.redo();
    if (rotating.canvas.getSelection()?.[0]?.[0]?.[0]?.join(',') !== '3,1') throw new Error('Rotation selection coordinates mismatch');
    rotating.rotateCanvas(180); rotating.rotateCanvas(180);
    rotating.rotateCanvas(270);
    if (rotating.canvas.getWidth() !== 8 || rotating.canvas.getSelection()?.[0]?.[0]?.[0]?.join(',') !== '1,1') throw new Error('Quarter-turn round trip changed selection');
    rotating.rotateCanvas(90);
    const rotatedProject = await rotating.exportProject(); rotating.destroy();
    const rotatedOpened = await HostDocument.openProject(rotatedProject);
    rotatedOpened.crop({ left: -2, top: -4, width: 8, height: 16 }, false);
    if (rotatedOpened.canvas.getLayer(0).context.getImageData(6, 1, 1, 1).data[2] !== 255) throw new Error('Rotation lost outside crop pixels');
    rotatedOpened.destroy();
    const canvasSizing = new HostDocument({ projectId: 'canvas-size', width: 4, height: 4, layers: [{ name: 'size', opacity: 1,
        isVisible: true, hasClipping: false, mixModeStr: 'source-over', image: { fill: 'red' } }] });
    canvasSizing.resizeCanvas(8, 8, { horizontal: 'center', vertical: 'center' });
    if (canvasSizing.canvas.getLayer(0).context.getImageData(0, 0, 1, 1).data[3] !== 0 || canvasSizing.canvas.getLayer(0).context.getImageData(2, 2, 1, 1).data[0] !== 255 || canvasSizing.canvas.getLayer(0).context.getImageData(6, 6, 1, 1).data[3] !== 0) throw new Error('Canvas resize scaled the subject or failed transparent padding');
    canvasSizing.undo();
    if (canvasSizing.canvas.getWidth() !== 4) throw new Error('Canvas resize was not one undo step');
    for (const [x, horizontal] of (['left', 'center', 'right'] as const).entries()) {
        for (const [y, vertical] of (['top', 'center', 'bottom'] as const).entries()) {
            canvasSizing.resizeCanvas(6, 6, { horizontal, vertical });
            const data = canvasSizing.canvas.getLayer(0).context.getImageData(0, 0, 6, 6).data;
            for (let py = 0; py < 6; py++) for (let px = 0; px < 6; px++) {
                const expected = px >= x && px < x + 4 && py >= y && py < y + 4 ? 255 : 0;
                if (data[(py * 6 + px) * 4 + 3] !== expected) throw new Error('Canvas anchor placement mismatch');
            }
            canvasSizing.undo();
        }
    }
    const sameCanvasActions = canvasSizing.capture().history.totalActions;
    canvasSizing.resizeCanvas(4, 4, { horizontal: 'center', vertical: 'center' });
    if (canvasSizing.capture().history.totalActions !== sameCanvasActions) throw new Error('No-op canvas resize created history');
    canvasSizing.resizeCanvas(2, 2, { horizontal: 'right', vertical: 'bottom' });
    canvasSizing.resizeCanvas(4, 4, { horizontal: 'right', vertical: 'bottom' });
    if (canvasSizing.canvas.getLayer(0).context.getImageData(0, 0, 1, 1).data[3] !== 255) throw new Error('Canvas resize lost hidden pixels');
    canvasSizing.destroy();
    const imageSizing = new HostDocument({ projectId: 'image-size', width: 8, height: 4, layers: [{ name: 'resample', opacity: 1,
        isVisible: true, hasClipping: false, mixModeStr: 'source-over', image: { fill: 'red' } }] });
    imageSizing.canvas.drawOperation(0, () => { const context = imageSizing.canvas.getLayer(0).context; context.fillStyle = 'blue'; context.fillRect(0, 0, 2, 2); });
    imageSizing.crop({ left: 2, top: 0, width: 4, height: 4 }, false);
    imageSizing.select([[[[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]]], 'replace', { feather: 1 });
    let distortionBlocked = false;
    try { imageSizing.resizeImage(8, 4, { interpolation: 'nearest' }); } catch { distortionBlocked = true; }
    if (!distortionBlocked || imageSizing.canvas.getWidth() !== 4) throw new Error('Image resize distorted without explicit permission');
    imageSizing.resizeImage(8, 8, { interpolation: 'nearest' });
    if (imageSizing.canvas.getSelection()?.[0]?.[0]?.[0]?.join(',') !== '2,2' || imageSizing.canvas.getKlHistory().getComposed().selection.feather !== 2) throw new Error('Image resize did not scale selection');
    imageSizing.undo();
    if (imageSizing.canvas.getWidth() !== 4) throw new Error('Image resize was not a single history entry');
    imageSizing.redo();
    const resizedPackage = await imageSizing.exportProject(); imageSizing.destroy();
    const resizedOpened = await HostDocument.openProject(resizedPackage);
    resizedOpened.crop({ left: -4, top: 0, width: 16, height: 8 }, false);
    if (resizedOpened.canvas.getLayer(0).context.getImageData(1, 1, 1, 1).data[2] !== 255) throw new Error('Image resize lost resampled outside pixels');
    resizedOpened.destroy();
    const explicitDistortion = makeWorkspaceImage('explicit-distortion');
    explicitDistortion.resizeImage(8, 16, { interpolation: 'smooth', allowDistortion: true });
    if (explicitDistortion.canvas.getWidth() !== 8 || explicitDistortion.canvas.getLayer(0).context.getImageData(4, 8, 1, 1).data[0] !== 255) throw new Error('Explicit image resampling failed');
    explicitDistortion.destroy();
    const sampling = new HostDocument({ projectId: 'sample-color', width: 2, height: 2,
        layers: ['red', 'blue'].map((fill, index) => ({ name: fill, opacity: index ? 0.5 : 1, isVisible: true,
            hasClipping: false, mixModeStr: 'source-over' as const, image: { fill } })) });
    const sampleHistory = sampling.capture().history.totalActions;
    if (sampling.sampleColor(0.5, 0.5, 'current')?.b !== 255) throw new Error('Current-layer color sample incorrect');
    const mergedSample = sampling.sampleColor(0.5, 0.5, 'merged');
    if (!mergedSample || Math.abs(mergedSample.r - 127) > 1 || Math.abs(mergedSample.b - 128) > 1) throw new Error('Merged color sample ignored layer opacity');
    if (sampling.sampleColor(-1, 0, 'merged') !== null || sampling.capture().history.totalActions !== sampleHistory) throw new Error('Sampling changed history or sampled workspace');
    sampling.destroy();
    const background = makeWorkspaceImage('background-layer');
    const backgroundId = background.canvas.getLayer(0).id;
    background.makeBackground(backgroundId, { r: 255, g: 255, b: 255 });
    if (!background.getLayerLocks(backgroundId).alpha || !background.getLayerLocks(backgroundId).position) throw new Error('Background did not protect transparency and position');
    let backgroundOpacityBlocked = false;
    try { background.setLayerOpacity(backgroundId, 0.5); } catch { backgroundOpacityBlocked = true; }
    if (!backgroundOpacityBlocked) throw new Error('Background opacity was editable');
    background.paint([[8, 8, 1]], { tool: 'eraser', size: 4, opacity: 1, color: { r: 0, g: 0, b: 0 }, backgroundColor: { r: 0, g: 255, b: 0 } });
    const backgroundPixel = background.canvas.getLayer(0).context.getImageData(8, 8, 1, 1).data;
    if (backgroundPixel[1] !== 255 || backgroundPixel[3] !== 255 || backgroundPixel[0] !== 0) throw new Error('Background eraser did not paint background color');
    background.resizeCanvas(18, 18, { horizontal: 'left', vertical: 'top' }, { r: 0, g: 0, b: 255 });
    const padding = background.canvas.getLayer(0).context.getImageData(17, 17, 1, 1).data;
    if (padding[2] !== 255 || padding[3] !== 255) throw new Error('Background canvas expansion did not use background color');
    const backgroundBundle = await background.exportProject(); background.destroy();
    const backgroundOpened = await HostDocument.openProject(backgroundBundle);
    if (!backgroundOpened.getLayerLocks(backgroundId).alpha) throw new Error('Background mode did not persist');
    backgroundOpened.backgroundToLayer(backgroundId, 'Normal');
    backgroundOpened.paint([[8, 8, 1]], { tool: 'eraser', size: 4, opacity: 1, color: { r: 0, g: 0, b: 0 } });
    if (backgroundOpened.canvas.getLayer(0).context.getImageData(8, 8, 1, 1).data[3] !== 0) throw new Error('Converted normal layer still erased to background');
    backgroundOpened.destroy();
    const moving = new HostDocument({ projectId: 'move-pixels', width: 8, height: 4, layers: [{ name: 'move', opacity: 1,
        isVisible: true, hasClipping: false, mixModeStr: 'source-over', image: { fill: 'transparent' } }] });
    moving.canvas.drawOperation(0, () => { const context = moving.canvas.getLayer(0).context; context.fillStyle = 'blue'; context.fillRect(0, 0, 2, 2); });
    moving.select([[[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]], 'replace');
    const beforeMovePreview = moving.capture().history.totalActions;
    const movePreview = moving.previewPixelMove(6, 0);
    if (movePreview.canvas.getContext('2d')!.getImageData(6, 0, 1, 1).data[2] !== 255 || moving.capture().history.totalActions !== beforeMovePreview || moving.canvas.getLayer(0).context.getImageData(0, 0, 1, 1).data[2] !== 255) throw new Error('Pixel move preview changed source or missed destination');
    moving.movePixels(6, 0);
    if (moving.canvas.getLayer(0).context.getImageData(0, 0, 1, 1).data[3] !== 0 || moving.canvas.getLayer(0).context.getImageData(6, 0, 1, 1).data[2] !== 255) throw new Error('Selected pixel move did not clear and relocate');
    moving.undo();
    if (moving.canvas.getLayer(0).context.getImageData(0, 0, 1, 1).data[2] !== 255) throw new Error('Pixel move undo failed');
    const movingLayerId = moving.canvas.getLayer(0).id;
    moving.setLayerLocks(movingLayerId, { position: true });
    const lockedMoveActions = moving.capture().history.totalActions;
    let lockedMoveBlocked = false;
    try { moving.movePixels(1, 0); } catch { lockedMoveBlocked = true; }
    if (!lockedMoveBlocked || moving.capture().history.totalActions !== lockedMoveActions) throw new Error('Position-locked move changed state');
    moving.setLayerLocks(movingLayerId, { position: false });
    moving.deselect(); moving.movePixels(-2, 0);
    const movedPackage = await moving.exportProject(); moving.destroy();
    const movedOpened = await HostDocument.openProject(movedPackage);
    movedOpened.resizeCanvas(10, 4, { horizontal: 'right', vertical: 'top' });
    if (movedOpened.canvas.getLayer(0).context.getImageData(0, 0, 1, 1).data[2] !== 255) throw new Error('Off-canvas moved pixels were discarded');
    movedOpened.destroy();
    const cropRestored = await HostDocument.openProject(cropProject);
    cropRestored.crop({ left: -4, top: -4, width: 16, height: 16 }, false);
    const outside = Array.from(cropRestored.canvas.getLayer(0).context.getImageData(1, 1, 1, 1).data);
    const inside = Array.from(cropRestored.canvas.getLayer(0).context.getImageData(8, 8, 1, 1).data);
    if (outside.join(',') !== '255,0,0,255' || inside.join(',') !== '0,0,255,255') throw new Error('Non-destructive crop lost outside or edited inside pixels');
    cropRestored.crop({ left: 4, top: 4, width: 8, height: 8 }, true);
    cropRestored.crop({ left: -4, top: -4, width: 16, height: 16 }, false);
    if (cropRestored.canvas.getLayer(0).context.getImageData(1, 1, 1, 1).data[3] !== 0) throw new Error('Destructive crop kept deleted pixels');
    cropRestored.destroy();
    attrRestored.destroy();
    const destination = new HostDocument({ projectId: 'destination', width: 32, height: 32, layers: [{
        name: 'base', opacity: 1, isVisible: true, hasClipping: false, mixModeStr: 'source-over', image: { fill: 'transparent' },
    }] });
    destination.pastePixels(clip, true);
    if (destination.canvas.getLayerCount() !== 2 || destination.canvas.getLayer(1).context.getImageData(3, 3, 1, 1).data[3] !== 255) throw new Error('Paste in place failed');
    destination.undo();
    if (destination.canvas.getLayerCount() !== 1) throw new Error('Paste undo failed');
    destination.pastePixels(clip, false);
    if (destination.canvas.getLayer(1).context.getImageData(13, 13, 1, 1).data[3] !== 255) throw new Error('Centered paste failed');
    destination.destroy();
    painting.destroy();
    const surfaceWorkspace = new HostWorkspace();
    surfaceWorkspace.sync(['pointer']);
    const surfaceDocument = surfaceWorkspace.open('pointer', () => new HostDocument({ projectId: 'pointer', width: 16, height: 16, layers: [{
        name: 'pointer', opacity: 1, isVisible: true, hasClipping: false, mixModeStr: 'source-over', image: { fill: 'white' },
    }] }));
    const pointerContainer = document.createElement('div'); pointerContainer.style.cssText = 'width:256px;height:256px'; document.body.append(pointerContainer);
    const pointerDisplay = new HostCanvasSurface(pointerContainer, surfaceWorkspace);
    const surface = pointerDisplay.canvas;
    surface.id = 'pointer-surface';
    surface.tabIndex = 0;
    surface.style.cssText = 'display:block;width:256px;height:256px;touch-action:none';
    const keyboardInput = document.createElement('input');
    keyboardInput.id = 'keyboard-input';
    document.body.append(keyboardInput);
    let commandCount = 0;
    bindKlecksKeyboard(document.body, () => ({ platform: 'windows', enabled: true, pending: surface.dataset.pending === 'true' }), command => {
        return routeKlecksCommand(command, { workspace: surfaceWorkspace,
            pending: () => surface.dataset.pending === 'true',
            changed: () => { surface.dataset.commandCount = String(++commandCount); pointerDisplay.redraw(); },
            error: error => { surface.dataset.error = String(error); }, host: () => false });
    });
    let movePortIdentity = { sessionId: 'probe-case', viewId: 'mouse-move', generation: 1 };
    if (location.hash.length > 1 && window.parent !== window) {
        bindKlecksFrameHandshake(window, { parent: window.parent, origin: location.origin, nonce: location.hash.slice(1) }, port => {
            const releaseCommands = bindKlecksCommandPort(port, () => ({ sessionId: 'probe-case', viewId: 'pointer', generation: 1 }), command =>
                routeKlecksCommand(command, { workspace: surfaceWorkspace, pending: () => surface.dataset.pending === 'true',
                    changed: () => { surface.dataset.commandCount = String(++commandCount); pointerDisplay.redraw(); },
                    error: error => { surface.dataset.error = String(error); }, host: () => false }));
            const owner = new HostFrameWorkspace(movePortIdentity.sessionId, moveRuntime, [movePortIdentity]);
            const releaseProjects = owner.bind(port);
            return () => { releaseProjects(); releaseCommands(); };
        });
    }
    let viewport = { zoom: 16, pixelRatio: 1, x: 0, y: 0 };
    bindKlecksPointerInput(surface, {
        getViewport: () => surfaceWorkspace.viewport ?? viewport,
        setViewport: value => { viewport = value; surfaceWorkspace.setViewport(value); surface.dataset.pan = `${value.x},${value.y}`; },
        getTool: () => surface.dataset.tool === 'polygon' ? 'polygon' : surface.dataset.tool === 'hand' ? 'hand' : surface.dataset.tool === 'rectangle' ? 'rectangle' : 'brush',
        onPendingChange: pending => { surface.dataset.pending = String(pending); },
        previewSelection: region => pointerDisplay.previewSelection(region),
        sampleColor: point => { const color = surfaceDocument.sampleColor(point[0], point[1], 'merged'); surface.dataset.sampled = color ? `${color.r},${color.g},${color.b}` : 'transparent'; },
        select: (region, mode) => { surface.dataset.selectionTrace = JSON.stringify(region); surfaceDocument.select(region, mode); pointerDisplay.previewSelection(null); },
        beginStroke: point => surfaceDocument.beginStroke(point, { tool: 'brush', size: 4, opacity: 1, color: { r: 0, g: 0, b: 0 } }),
        moveStroke: point => surfaceDocument.moveStroke(point),
        endStroke: () => surfaceDocument.endStroke(),
        cancelStroke: () => surfaceDocument.cancelStroke(),
        redraw: () => pointerDisplay.redraw(),
        onError: error => { surface.dataset.error = String(error); },
    });
    (window as any).hostPointerProbe = {
        actions: () => surfaceDocument.capture().history.totalActions,
        layerCount: () => surfaceDocument.canvas.getLayerCount(),
        pixel: (x: number, y: number) => Array.from(surfaceDocument.canvas.getLayer(0).context.getImageData(x, y, 1, 1).data),
        undo: () => surfaceDocument.undo(),
        resetView: () => { viewport = { zoom: 16, pixelRatio: 1, x: 0, y: 0 }; surfaceWorkspace.setViewport(viewport); pointerDisplay.redraw(); },
        copy: () => { const clip = surfaceDocument.copyPixels(); return { x: clip.x, y: clip.y, width: clip.image.width }; },
    };
    const moveContainer = document.createElement('div'); moveContainer.style.cssText = 'width:192px;height:192px'; document.body.append(moveContainer);
    const moveRuntime = new HostEditorRuntime(moveContainer, 'windows', { changed: () => {}, error: error => { moveContainer.dataset.error = String(error); } });
    moveRuntime.canvas.id = 'runtime-move-surface'; moveRuntime.sync(['mouse-move']);
    await moveRuntime.openRaster('mouse-move', 'Move', async () => ({ bytes: externalPng.bytes, widthPx: 2, heightPx: 2 }));
    moveRuntime.setTool('move');
    (window as any).hostMoveProbe = {
        configureFrameSession: (sessionId: string) => { movePortIdentity = { ...movePortIdentity, sessionId }; },
        source: () => ({ bytes: Array.from(externalPng.bytes), widthPx: 2, heightPx: 2, initialLayerKind: 'regular' }),
        initializeProject: async (identity: typeof movePortIdentity, input: WireProject) => {
            moveRuntime.sync([identity.viewId]);
            await moveRuntime.openProject(identity.viewId, async () => ({ version: 1, metadata: input.metadata,
                psd: new Blob([new Uint8Array(input.psd).buffer]), backings: input.backings.map(item => ({ id: item.id, blob: new Blob([new Uint8Array(item.bytes).buffer]) })) }));
            movePortIdentity = { ...identity };
        },
        editForSave: () => { const size = moveRuntime.state.size!; moveRuntime.resizeCanvas(size.width + 1, size.height, { horizontal: 'left', vertical: 'top' }); },
        signature: () => { const image = HostDocument.restore(moveRuntime.captureActive()!); try { return projectSignature(image); } finally { image.destroy(); } },
        edit: () => moveRuntime.movePixels(1, 0),
        state: () => moveRuntime.state,
        cropTool: () => moveRuntime.setTool('crop'),
        size: () => moveRuntime.state.size,
        actions: () => moveRuntime.captureActive()!.history.totalActions,
        pending: () => moveRuntime.state.pending,
        pixel: (x: number, y: number) => {
            const image = HostDocument.restore(moveRuntime.captureActive()!);
            try { return Array.from(image.canvas.getLayer(0).context.getImageData(x, y, 1, 1).data); } finally { image.destroy(); }
        },
    };
    const projectSignature = (image: HostDocument) => ({
        size: { width: image.canvas.getWidth(), height: image.canvas.getHeight() },
        selection: image.canvas.getKlHistory().getComposed().selection,
        activeLayerIndex: image.canvas.getLayers().find(layer => layer.id === image.canvas.getKlHistory().getComposed().activeLayerId)?.index,
        layers: image.canvas.getLayers().map(layer => ({
            name: layer.name, opacity: layer.opacity, visible: layer.isVisible, mix: layer.mixModeStr,
            locks: image.getLayerLocks(layer.id),
            pixels: Array.from(layer.context.getImageData(0, 0, image.canvas.getWidth(), image.canvas.getHeight()).data),
        })),
    });
    type WireProject = { metadata: THostProject['metadata']; psd: number[]; backings: { id: string; bytes: number[] }[] };
    (window as any).hostProjectProbe = {
        initializeRaster: async (input: { bytes: number[]; widthPx: number; heightPx: number; initialLayerKind?: 'regular' | 'background' }) => {
            const image = await HostDocument.fromPng('full-source-probe', 'Source', { ...input, bytes: new Uint8Array(input.bytes) });
            try { return projectSignature(image); } finally { image.destroy(); }
        },
        prepare: async () => {
            const image = new HostDocument({ projectId: 'package-probe', width: 16, height: 16,
                layers: ['red', 'transparent'].map(fill => ({ name: fill, opacity: 0.7, isVisible: true,
                    hasClipping: false, mixModeStr: 'source-over' as const, image: { fill } })) });
            try {
                image.crop({ left: 4, top: 4, width: 8, height: 8 }, false);
                image.paint([[4, 4, 1]], { tool: 'brush', size: 4, opacity: 1, color: { r: 0, g: 0, b: 255 } });
                image.select([[[[1, 1], [6, 1], [6, 6], [1, 6], [1, 1]]]], 'replace', { feather: 2, antiAlias: false });
                image.setLayerLocks(image.canvas.getLayer(1).id, { position: true, alpha: true });
                image.setLayerVisibility(image.canvas.getLayer(0).id, false);
                image.deselect();
                const saved = await image.exportProject();
                const bundle = { metadata: saved.metadata, psd: Array.from(new Uint8Array(await saved.psd.arrayBuffer())),
                    backings: await Promise.all(saved.backings.map(async item => ({ id: item.id, bytes: Array.from(new Uint8Array(await item.blob.arrayBuffer())) }))) };
                image.crop({ left: -4, top: -4, width: 16, height: 16 }, false);
                return { bundle, expected: projectSignature(image) };
            } finally { image.destroy(); }
        },
        restore: async (input: WireProject, expand = true) => {
            const image = await HostDocument.openProject({ version: 1, metadata: input.metadata,
                psd: new Blob([new Uint8Array(input.psd)]),
                backings: input.backings.map(item => ({ id: item.id, blob: new Blob([new Uint8Array(item.bytes)], { type: 'image/png' }) })) });
            try { if (expand) image.crop({ left: -4, top: -4, width: 16, height: 16 }, false); return projectSignature(image); }
            finally { image.destroy(); }
        },
    };
    document.getElementById('result')!.textContent = JSON.stringify({ passed: true, pixel, documents: 9, brush: true, brushNumericKeys: true, shiftBrushLine: true, shiftDragAndMarqueeSpace: true, selectionBoundaryDrag: true, keyboardNudge: true, keyboardReselect: true, eraser: true, interactiveStroke: true, clipboard: true, selectionModes: true, cutAndLayers: true, layerAttributes: true, layerLocks: true, projectRestore: true, opacityFlow: true, hardness: true, cropBacking: true, feather: true, workspace: true, frameCollectionLifecycle: true });
} catch (error) {
    document.getElementById('result')!.textContent = JSON.stringify({ passed: false, error: String(error) });
}
}
void run();
