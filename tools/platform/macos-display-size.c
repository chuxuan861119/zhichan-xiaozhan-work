#include <CoreGraphics/CoreGraphics.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
    if (argc > 2) return 2;
    char *end = NULL;
    errno = 0;
    unsigned long parsed = argc == 1 ? CGMainDisplayID() : strtoul(argv[1], &end, 10);
    if ((argc == 2 && (errno || !end || *end)) || parsed > UINT32_MAX) return 2;
    CGDirectDisplayID display = (CGDirectDisplayID)parsed;
    if (!CGDisplayIsActive(display)) return 1;
    CGSize size = CGDisplayScreenSize(display);
    // CoreGraphics can synthesize a 72dpi size when display metadata is missing.
    double dpi = CGDisplayPixelsWide(display) * 25.4 / size.width;
    if (!isfinite(dpi) || fabs(dpi - 72.0) < 0.1) return 1;
    double rotation = fmod(fabs(CGDisplayRotation(display)), 180.0);
    double width = rotation > 45 && rotation < 135 ? size.height : size.width;
    if (!isfinite(width) || width < 100 || width > 3000) return 1;
    printf("%.3f\n", width);
    return 0;
}
