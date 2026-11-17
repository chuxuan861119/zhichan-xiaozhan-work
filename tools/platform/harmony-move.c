// In-process Node NAPI binding. Never spawn a process in the Harmony runtime.
#include <errno.h>
#include <dlfcn.h>
#include <math.h>
#include <window_manager/oh_display_manager.h>
#include <fcntl.h>
#include <node_api.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>
#include "owned-cleanup.h"

static char *read_text(napi_env env, napi_value value) {
    size_t n = 0;
    if (napi_get_value_string_utf8(env, value, NULL, 0, &n) != napi_ok || n == 0 || n > 32768) return NULL;
    char *path = calloc(n + 1, 1);
    if (!path) return NULL;
    size_t written = 0;
    if (napi_get_value_string_utf8(env, value, path, n + 1, &written) != napi_ok || written != n || memchr(path, 0, n)) {
        free(path); return NULL;
    }
    return path;
}
static napi_value move(napi_env env, napi_callback_info info) {
    size_t count = 2;
    napi_value args[2], answer;
    const char *result = "EINVAL";
    if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 2) return NULL;
    char *source = read_text(env, args[0]), *target = read_text(env, args[1]);
    if (source && target && source[0] == '/' && target[0] == '/') {
        if (syscall(SYS_renameat2, AT_FDCWD, source, AT_FDCWD, target, 1u) == 0) result = "OK";
        else switch (errno) {
            case EEXIST: case ENOTEMPTY: result = "EEXIST"; break;
            case EXDEV: result = "EXDEV"; break;
            case ENOSPC: result = "ENOSPC"; break;
            case EACCES: case EPERM: result = "EACCES"; break;
            case ENOENT: result = "ENOENT"; break;
            case ENOSYS: case ENOTSUP: case EINVAL: result = "UNSUPPORTED_ATOMIC_SWAP"; break;
            default: result = "EIO";
        }
    }
    free(source); free(target);
    if (napi_create_string_utf8(env, result, NAPI_AUTO_LENGTH, &answer) != napi_ok) return NULL;
    return answer;
}
static napi_value remove_owned(napi_env env, napi_callback_info info) {
    size_t count = 4;
    napi_value args[4], answer;
    if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 4) return NULL;
    char *root = read_text(env, args[0]), *device = read_text(env, args[1]);
    char *inode = read_text(env, args[2]), *birth = read_text(env, args[3]);
    int result = root && device && inode && birth ? owned_remove(root, device, inode, birth) : -1;
    free(root); free(device); free(inode); free(birth);
    if (napi_create_string_utf8(env, result == 0 ? "OK" : "EIO", NAPI_AUTO_LENGTH, &answer) != napi_ok) return NULL;
    return answer;
}
static napi_value display_width(napi_env env, napi_callback_info info) {
    size_t count = 1;
    napi_value args[1], answer;
    uint32_t id = 0;
    double width = 0;
    if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
        napi_get_value_uint32(env, args[0], &id) != napi_ok) return NULL;
    void *library = dlopen("libnative_display_manager.so", RTLD_NOW | RTLD_LOCAL);
    if (library) {
        typedef NativeDisplayManager_ErrorCode (*create_fn)(uint32_t, NativeDisplayManager_DisplayInfo **);
        typedef void (*destroy_fn)(NativeDisplayManager_DisplayInfo *);
        create_fn create = (create_fn)dlsym(library, "OH_NativeDisplayManager_CreateDisplayById");
        destroy_fn destroy = (destroy_fn)dlsym(library, "OH_NativeDisplayManager_DestroyDisplay");
        NativeDisplayManager_DisplayInfo *display = NULL;
        if (create && destroy && create(id, &display) == DISPLAY_MANAGER_OK && display) {
            bool rotated = display->rotation == DISPLAY_MANAGER_ROTATION_90 || display->rotation == DISPLAY_MANAGER_ROTATION_270;
            double pixels = rotated ? display->physicalHeight : display->physicalWidth;
            double dpi = rotated ? display->yDPI : display->xDPI;
            if (display->isAlive && pixels > 0 && dpi > 0) width = pixels * 25.4 / dpi;
            destroy(display);
        }
        dlclose(library);
    }
    if (!isfinite(width) || width < 100 || width > 3000) width = 0;
    if (napi_create_double(env, width, &answer) != napi_ok) return NULL;
    return answer;
}
static napi_value initialize(napi_env env, napi_value exports) {
    napi_value operation;
    if (napi_create_function(env, "moveNoReplace", NAPI_AUTO_LENGTH, move, NULL, &operation) != napi_ok ||
        napi_set_named_property(env, exports, "moveNoReplace", operation) != napi_ok) return NULL;
    if (napi_create_function(env, "displayWidthMm", NAPI_AUTO_LENGTH, display_width, NULL, &operation) != napi_ok ||
        napi_set_named_property(env, exports, "displayWidthMm", operation) != napi_ok) return NULL;
    if (napi_create_function(env, "removeOwned", NAPI_AUTO_LENGTH, remove_owned, NULL, &operation) != napi_ok ||
        napi_set_named_property(env, exports, "removeOwned", operation) != napi_ok) return NULL;
    return exports;
}
NAPI_MODULE(move_no_replace, initialize)
