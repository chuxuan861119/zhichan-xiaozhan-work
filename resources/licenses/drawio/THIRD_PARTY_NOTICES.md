# draw.io v30.0.4 third-party materials

The bundled draw.io runtime is derived from the Apache-2.0 licensed upstream project at
https://github.com/jgraph/drawio, pinned to tag `v30.0.4` and commit
`88ee1f5ab4d40603a8f3aaa0d9d6dc3794c6b3f0`.

The bundle is generated only from the files recorded in `resources/drawio/manifest.json`.
Their provenance is the upstream paths in the curated allowlist in
`scripts/drawio-bundle-policy.mjs`. The upstream distribution at the pinned tag has no
`NOTICE` file; see `NOTICE` in this directory.

No draw.io plugins, server/connect integrations, cloud services, source maps, or cloud-brand
stencil libraries are included in the bundle.

`EMBEDDED_DEPENDENCIES.txt` preserves the licenses and attribution comments of
libraries embedded in the shipped JavaScript bundles. `DEPENDENCIES.json` records
the exact bundle hashes and the sources of these license materials. The Mermaid
release dependency closure is included conservatively; tree-shaken dependencies
are not asserted to run in this application. DOMPurify uses the Apache-2.0 option,
JSZip uses MIT, and CryptoJS 3.1.2 uses its archived BSD-3-Clause terms.

Files adapted for offline integration and Simplified Chinese defaults carry
individual modification comments. Original upstream copyright notices remain.
