// Atomic no-replace moves for the existing journaled import/recovery protocol.
// Paths use a length-prefixed UTF-8 stdin protocol, never command-line arguments.
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stdio.h>
#include "owned-cleanup.h"

static char *read_field(void) {
    unsigned char size[4];
    if (fread(size, 1, 4, stdin) != 4) return NULL;
    uint32_t n = (uint32_t)size[0] | (uint32_t)size[1] << 8 | (uint32_t)size[2] << 16 | (uint32_t)size[3] << 24;
    if (n == 0 || n > 32768) return NULL;
    char *path = calloc((size_t)n + 1, 1);
    if (!path) return NULL;
    if (fread(path, 1, n, stdin) != n || memchr(path, 0, n)) {
        free(path); return NULL;
    }
    return path;
}
int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--remove-owned")) {
        char *root = read_field(), *device = read_field(), *inode = read_field(), *birth = read_field();
        int result = root && device && inode && birth && fgetc(stdin) == EOF ? owned_remove(root, device, inode, birth) : -1;
        free(root); free(device); free(inode); free(birth);
        fputs(result == 0 ? "OK" : "EIO", stdout);
        return result == 0 ? 0 : 1;
    }
    char *source = read_field(), *target = read_field();
    const char *result = "EINVAL";
    if (source && target && source[0] == '/' && target[0] == '/' && fgetc(stdin) == EOF) {
        if (renamex_np(source, target, RENAME_EXCL) == 0) result = "OK";
        else switch (errno) {
            case EEXIST: case ENOTEMPTY: result = "EEXIST"; break;
            case EXDEV: result = "EXDEV"; break;
            case ENOSPC: result = "ENOSPC"; break;
            case EACCES: case EPERM: result = "EACCES"; break;
            case ENOENT: result = "ENOENT"; break;
            case ENOTSUP: case EINVAL: result = "UNSUPPORTED_ATOMIC_SWAP"; break;
            default: result = "EIO";
        }
    }
    free(source); free(target);
    fputs(result, stdout);
    return strcmp(result, "OK") == 0 ? 0 : 1;
}
