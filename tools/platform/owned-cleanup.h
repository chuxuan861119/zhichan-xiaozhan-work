// Descriptor-relative cleanup: no child lookup follows a symlink, and renaming
// an ancestor cannot redirect traversal into an unrelated directory.
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int owned_same(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}
static int owned_children(int fd, dev_t device) {
    DIR *dir = fdopendir(dup(fd));
    if (!dir) return -1;
    int answer = 0;
    struct dirent *entry;
    errno = 0;
    while ((entry = readdir(dir)) != NULL) {
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        struct stat info;
        if (fstatat(fd, entry->d_name, &info, AT_SYMLINK_NOFOLLOW) || info.st_dev != device) { answer = -1; break; }
        if (S_ISDIR(info.st_mode)) {
            int child = openat(fd, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
            struct stat opened, current;
            if (child < 0) { answer = -1; break; }
            int result = fstat(child, &opened) || !owned_same(&info, &opened) || owned_children(child, device);
            close(child);
            if (result || fstatat(fd, entry->d_name, &current, AT_SYMLINK_NOFOLLOW) ||
                !owned_same(&info, &current) || unlinkat(fd, entry->d_name, AT_REMOVEDIR)) { answer = -1; break; }
        } else if (S_ISREG(info.st_mode)) {
            if (unlinkat(fd, entry->d_name, 0)) { answer = -1; break; }
        } else { answer = -1; break; }
        errno = 0;
    }
    if (errno) answer = -1;
    closedir(dir);
    return answer;
}
static int owned_remove(const char *absolute, const char *device, const char *inode, const char *birth) {
    if (!absolute || absolute[0] != '/' || !absolute[1]) return -1;
    char *path = strdup(absolute + 1);
    if (!path) return -1;
    // Linux sandbox ancestors may allow path traversal but deny directory listing.
    // O_PATH pins the same no-follow directory identity without asking to read it.
#if defined(__linux__) && defined(O_PATH)
    const int ancestor_flags = O_PATH | O_DIRECTORY | O_NOFOLLOW;
#else
    const int ancestor_flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
#endif
    int parent = open("/", ancestor_flags);
    char *save = NULL, *name = strtok_r(path, "/", &save);
    int answer = -1;
    while (parent >= 0 && name) {
        if (!strcmp(name, ".") || !strcmp(name, "..")) break;
        char *next = strtok_r(NULL, "/", &save);
        if (next) {
            int child = openat(parent, name, ancestor_flags);
            close(parent); parent = child; name = next; continue;
        }
        struct stat info;
        if (fstatat(parent, name, &info, AT_SYMLINK_NOFOLLOW)) {
            if (errno == ENOENT) answer = 0;
            break;
        }
        char actual_device[64], actual_inode[64];
        snprintf(actual_device, sizeof(actual_device), "%ju", (uintmax_t)info.st_dev);
        snprintf(actual_inode, sizeof(actual_inode), "%ju", (uintmax_t)info.st_ino);
        if (strcmp(device, actual_device) || strcmp(inode, actual_inode)) break;
#ifdef __APPLE__
        char actual_birth[64];
        snprintf(actual_birth, sizeof(actual_birth), "%ju", (uintmax_t)info.st_birthtimespec.tv_sec * 1000000000u + (uintmax_t)info.st_birthtimespec.tv_nsec);
        if (strcmp(birth, actual_birth)) break;
#else
        (void)birth; // Node has already checked birthtime; inode is checked again through the pinned descriptor.
#endif
        if (S_ISDIR(info.st_mode)) {
            int root = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
            struct stat opened, current;
            if (root < 0) break;
            int result = fstat(root, &opened) || !owned_same(&info, &opened) || owned_children(root, info.st_dev);
            close(root);
            if (result || fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) || !owned_same(&info, &current)) break;
            answer = unlinkat(parent, name, AT_REMOVEDIR);
        } else if (S_ISREG(info.st_mode)) answer = unlinkat(parent, name, 0);
        break;
    }
    if (parent >= 0) close(parent);
    free(path);
    return answer;
}
