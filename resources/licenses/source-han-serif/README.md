# Source Han Serif CN 2.003

Official, unmodified Adobe fonts from commit
`7889f11bf31170b5d092a083b357c8c8130f89e0`:
https://github.com/adobe-fonts/source-han-serif/tree/7889f11bf31170b5d092a083b357c8c8130f89e0/SubsetOTF/CN

Regular and SemiBold are stored in `src/shared/document/fonts` and bundled by
electron-vite for the renderer and print process. The build license audit verifies
their SHA-256 hashes and includes the full accompanying SIL OFL 1.1 license in
`THIRD_PARTY_NOTICES.txt`. The original copyright and reserved font name remain
unchanged. The font files are not renamed, converted, or modified.

The explicit "Source Han Serif CN" family is available on Windows, macOS and
HarmonyOS. Editor and print/PDF load the same Regular and SemiBold files. Legacy
SimSun/宋体 names retain a bundled rendering fallback on macOS and HarmonyOS;
Windows uses its locally installed SimSun. New system templates use Windows
SimSun, macOS PingFang SC or HarmonyOS Sans SC. Custom templates and existing
documents retain their stored font names.

DOCX maps Source Han Serif CN, PingFang SC and HarmonyOS Sans SC to SimSun by
name only, preserves FangSong/KaiTi, and does not embed any font files. The CN
character set uses system fallback outside its coverage. Font substitution does
not replace text, but identical pagination or glyph coverage is not guaranteed.
