# Sharp/libvips Windows x64 notice and replacement instructions

The application loads `libvips-42.dll` dynamically through the unpacked
`@img/sharp-win32-x64` native module. The DLL contains libvips and the static
web-profile libraries listed in `SOURCE_MANIFEST.json`. The LGPL-covered
portions are offered under LGPL-3.0 by exercise of their “or any later
version” clauses. The complete GPL-3.0 and LGPL-3.0 texts are supplied beside
this notice.

Reverse engineering for debugging modifications is permitted. Nothing in the
application license forbids reverse engineering that is needed to debug a
user-modified LGPL-covered library.

## Replace libvips-42.dll

1. Close 知产小栈专利工作台 and back up the installed
   `resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll`.
2. Build an ABI-compatible Windows x64 `libvips-42.dll` from the supplied
   preferred source archives and build scripts, or obtain another compatible
   modified build.
3. Replace that installed DLL while preserving the exact filename
   `libvips-42.dll`, then restart the application.

The replacement must preserve the ABI expected by sharp 0.35.5 and libvips
8.18.7. A modified replacement is not covered by application support or
warranty. No signature or authorization key is required to replace the DLL.

## Corresponding Source and build materials

The corresponding source package is available without registration or charge at
https://zcxzz.cn/open-source/. The installed resources/OPEN_SOURCE_DOWNLOADS.txt
records the exact versioned archive URL and SHA-256 for this release.
Inside that archive, `sources/` contains the official preferred source for all nine
LGPL-covered components in this exact Windows bundle, plus the exact tagged
sharp-libvips and build-win64-mxe recipes and the referenced MXE revision.
Those build archives include the modifications, patches, version pins,
checksums, and installation/package scripts used for the distributed web
profile. `SOURCE_MANIFEST.json` records every archive URL and SHA-256.

The build recipe refers to `ghcr.io/libvips/build-win64-mxe:latest`; the tag
does not record an immutable image digest. The build base image tag was not
pinned to an immutable digest. Therefore these materials do not claim a
bit-for-bit reproducible build. This limitation does not remove the supplied
preferred source, modifications, or build and installation scripts.
