# Klecks source baseline

Source: https://github.com/bitbof/klecks

Pinned commit: cfd66e88743351816b29822f5c12a0363c309554

License: MIT; original LICENSE retained.

Additional host adaptations: zoom marquee/scrubby navigation, display-only crop/transform handles and brush adjustment HUD; selected-pixel affine transforms and selection-only transforms; bounded serializable soft-selection coverage, including inverse coverage and affine mappings across project reopen; explicit clipboard and save-request ports. The host evaluates selection coverage under its resource estimate. These are fork features, not upstream SDK guarantees or claims of Adobe pixel equivalence. See the chronological implementation record for current verification and outstanding UI integration.

Host runtime adds bounded brush size/hardness command handling and a separate display-only tool cursor. Full-size circular tip rendering follows document zoom/DPR and is not part of document pixels. Neither brush parameter detents nor cursor artwork are certified pixel-identical to Adobe Photoshop; UI preferences and remaining gestures are tracked in the host alignment review.

The host pixel-transform helper renders an owned affine raster without mutating its source, preserves document offsets outside the visible canvas, and scans alpha in bounded bands. The host owns history/preview integration and callers must reserve operation memory before use. Its development-only pixel probe is excluded from production entry graphs; these additions do not claim Adobe resampling equivalence.

HostDocument now uses that helper for whole-layer composite previews and single-history affine commits, retaining off-canvas backing through project reopen. Active selection transforms remain explicitly unconnected rather than transforming an entire layer by mistake. HostEditorRuntime gesture ownership, resource admission and transform controls are still pending; this is not an upstream API or a completed user-facing transform tool.

Imported using git archive from the verified local trial repository, selecting tracked src, LICENSE, README.md, package.json and package-lock.json only. Trial scripts, browser profiles, node_modules and generated output are excluded. Upstream source formatting is preserved and excluded from the host formatter. This directory is not yet wired into the production application bundle.

Host fork changes: KlHistory exports/restores isolated in-memory snapshots including the redo branch and current index. Snapshots reject paused operations; this API is not an untrusted persistent-file decoder. Pixel ImageData cloning and browser restoration still require browser-level verification.

HostDocument provides UI-independent document lifecycle, snapshots, frozen PSD encoding and incremental stroke begin/move/end/cancel commands. It blocks history navigation and snapshots during an unfinished stroke. These host entry points and host-probe are fork additions, not upstream SDK APIs.

PSD encoding copies the returned Buffer into a regular ArrayBuffer for the browser Blob boundary. tsconfig.host.json checks the host entry and its transitive dependencies independently of the upstream service-worker compilation environment; run language/icon generation first.

PenBrush adds optional circular-tip hardness (default 1 preserves upstream behavior). The host uses a separate stroke-coverage canvas to implement opacity caps and independent flow, using the same pen coverage for regular erasing. These semantic adaptations are not claims of Adobe brush-rendering equivalence.

HostWorkspace owns one live document and per-image suspended engine snapshots. Its incremental reconciliation and switching preserve histories without reinitializing retained images; business deletion confirmation and persistent case writes remain the host application's responsibility. Host selection masks carry feather/anti-alias metadata and share coverage across paint, copy and clear; browser blur is not claimed to match Adobe's kernel.

runtime-project-port is a host-only adapter on the authenticated parent MessagePort. It exports frozen binary projects and keeps internal history/save tokens private; a one-use host confirmation calls markSaved. Parent-side durable case commits remain outside the fork. This adapter is not an upstream Klecks API or a production bundle entry.

HostFrameWorkspace binds a case-scoped incremental image collection to the authenticated document/project protocols. Replaced generations invalidate old engine states; cancelLoading invalidates pending decoding without changing the current image. Full persisted metadata validation belongs to the main-process bridge, not these transport adapters.

host-editor.ts/html provide a dedicated canvas-only production entry authenticated to the patent-app://app parent, with no probe globals or upstream startup UI. PSD Blob encoding uses ag-psd's browser-native writePsdUint8Array instead of writePsdBuffer, avoiding a runtime Node Buffer dependency while retaining an owned ArrayBuffer copy.

HostFrameWorkspace also binds the host tool-control namespace for bounded tool choice, brush parameters, fit and zoom. Commands check the active image generation before touching runtime state; this is separate from binary project transport and upstream application menus.

The runtime exposes disposable change subscriptions, including brush-option changes. HostFrameWorkspace publishes bounded scalar editor state on the authenticated port, without canvas/history objects or persistence tokens; collection reconciliation emits only internally consistent image identities.

The host tool namespace includes validated layer commands and read-only layer metadata. HostDocument truncates duplicated layer names to the persisted 200-character limit inside the duplicate history transaction; upstream's unbounded copy suffix otherwise makes valid source names unsavable.

HostEditorRuntime reserves estimated workspace resources before raster/project engine decoding and project/revision encoding, releasing reservations on failure. The injectable host policy is an admission estimate, not RSS measurement or a complete memory-safety guarantee; per-operation and cross-case coverage remains host work.

Runtime admission also covers gesture buffers, selected layer mutations, clipboard commands, crop application and image/canvas geometry operations. Gesture reservations survive preview updates and release on finish/cancel/failure; over-budget edits do not discard history or source documents.

HostDocument.openProject preflights the internal flat RGB PSD layout before calling ag-psd, bounding actual layer rectangles/channels and rejecting ungenerated complex records and ZIP streams. This is an internal-engine profile, not a general PSD importer. Decode reuses the inspected bytes and skips thumbnails.

KlHistory supports an optional host undo-step/estimated-byte policy preserved in in-memory suspension snapshots. HostDocument defaults to 100 steps and 128 MiB of estimated history; only over-budget oldest prefixes are composed into a retained base on push. An oversized base remains intact. Upstream callers without a host policy retain their original trimming behavior.

Host exports clone the composed current state once instead of cloning whole undo/redo histories. Project/composite/thumbnail encode from the same private immutable revision; encoding frees its temporary canvases on completion or failure. Off-canvas backing data stays part of the frozen state.

The host canvas entry accepts the parent's granted workspace quota (512 MiB to 2 GiB) and applies it to runtime admission. Invalid quotas fail before engine creation; case/frame credentials and their lifetime remain owned by the parent/main process, not the iframe.

The runtime supports case/operation-owned checkpoint interaction locks. It rejects acquiring a lock during unfinished input, blocks edits while locked, and permits internal document activation and project freezing; a stale token cannot unlock another checkpoint operation.

The runtime tracks a frame-local checkpoint revision for composed content, selection/current layer and viewport, independently of explicit-save dirtiness. Input locks and unchanged document activation do not advance it. Pointer viewport updates publish state immediately; no pixel data or history tokens enter the status stream.
