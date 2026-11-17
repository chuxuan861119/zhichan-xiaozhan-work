# macOS Sharp/libvips materials

The macOS package dynamically loads the unmodified libvips library from
`Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-<arch>/lib/`.
The exact binary digest, component inventory, source archives and license notices
are recorded in SOURCE_MANIFEST.darwin-<arch>.json and COMPONENT_MATERIALS.darwin-<arch>.json.
Corresponding source, patches and build recipes are available without registration
or charge at https://zcxzz.cn/open-source/. The installed resources/OPEN_SOURCE_DOWNLOADS.txt
records the exact archive URL and SHA-256. Inside that archive, shared sources are
in sources/; macOS version differences use mac-* files.
The build recipe is included in sources/sharp-libvips-v1.3.4.tar.gz (build/posix.sh).
That recipe applies upstream patches and retrieves toolchains; a byte-identical rebuild
is not asserted. Build using the target architecture and the documented upstream recipe.

Recipients may replace the LGPL library in a copy of the application with a compatible
modified build. Preserve its install name, exported ABI and architecture. Changing the
bundle invalidates its signature; re-sign the modified local copy, including nested
binaries, with the user's own identity or an ad-hoc signature. The application entitlements
allow loading modified libraries. The product does not forbid reverse engineering for
debugging modifications to LGPL components. These permissions do not replace or limit
the bundled LGPL/GPL license terms. No vendor signing key is needed for a local modified copy.

GNU GPL v3 and LGPL v3 texts are included in licenses/. Individual upstream license and
copyright notices, including LGPL v2.1 components, are included in licenses/components/.
These materials identify the distributed software; they do not claim legal certification.
