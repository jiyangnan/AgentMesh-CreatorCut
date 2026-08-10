#if !defined(__APPLE__) || !defined(__MACH__)
#error "secure-swap-prototype is Darwin-only"
#endif

#define _DARWIN_C_SOURCE 1

#include "darwin_shim.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/attr.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/stdio.h>
#include <sys/xattr.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

static int ss_component(const uint8_t *bytes, size_t len, char **out) {
    if (bytes == NULL || out == NULL || len == 0 || len > 255) {
        return -EINVAL;
    }
    if ((len == 1 && bytes[0] == '.') ||
        (len == 2 && bytes[0] == '.' && bytes[1] == '.')) {
        return -EINVAL;
    }
    for (size_t i = 0; i < len; i++) {
        if (bytes[i] == 0 || bytes[i] == '/') {
            return -EINVAL;
        }
    }
    char *value = (char *)malloc(len + 1);
    if (value == NULL) {
        return -ENOMEM;
    }
    memcpy(value, bytes, len);
    value[len] = 0;
    *out = value;
    return 0;
}

static int ss_path(const uint8_t *bytes, size_t len, char **out) {
    if (bytes == NULL || out == NULL || len == 0 || len > 4096 ||
        bytes[0] != '/' || (len > 1 && bytes[len - 1] == '/')) {
        return -EINVAL;
    }
    for (size_t i = 0; i < len; i++) {
        if (bytes[i] == 0) {
            return -EINVAL;
        }
    }
    if (len == 1) {
        char *value = (char *)malloc(2);
        if (value == NULL) {
            return -ENOMEM;
        }
        value[0] = '/';
        value[1] = 0;
        *out = value;
        return 0;
    }
    size_t component_start = 1;
    for (size_t i = 1; i <= len; i++) {
        if (i != len && bytes[i] != '/') {
            continue;
        }
        size_t component_len = i - component_start;
        if (component_len == 0 || component_len > 255 ||
            (component_len == 1 && bytes[component_start] == '.') ||
            (component_len == 2 && bytes[component_start] == '.' &&
             bytes[component_start + 1] == '.')) {
            return -EINVAL;
        }
        component_start = i + 1;
    }
    char *value = (char *)malloc(len + 1);
    if (value == NULL) {
        return -ENOMEM;
    }
    memcpy(value, bytes, len);
    value[len] = 0;
    *out = value;
    return 0;
}

static int ss_fd_result(int value) {
    return value < 0 ? -errno : value;
}

int ss_open_project_root(const uint8_t *path, size_t path_len) {
    char *value = NULL;
    int rc = ss_path(path, path_len, &value);
    if (rc != 0) {
        return rc;
    }
    /* O_NOFOLLOW_ANY already covers the leaf; Darwin rejects combining it
     * with O_NOFOLLOW as EINVAL. */
    int fd = openat(AT_FDCWD, value,
                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC);
    int saved = errno;
    free(value);
    errno = saved;
    return ss_fd_result(fd);
}

static int ss_open_component(int dir_fd, const uint8_t *name, size_t name_len,
                             int flags, mode_t mode, int create) {
    char *value = NULL;
    int rc = ss_component(name, name_len, &value);
    if (rc != 0) {
        return rc;
    }
    int fd = create
        ? openat(dir_fd, value, flags | O_NOFOLLOW | O_CLOEXEC, mode)
        : openat(dir_fd, value, flags | O_NOFOLLOW | O_CLOEXEC);
    int saved = errno;
    free(value);
    errno = saved;
    return ss_fd_result(fd);
}

int ss_open_dir_at(int dir_fd, const uint8_t *name, size_t name_len) {
    return ss_open_component(dir_fd, name, name_len,
                             O_RDONLY | O_DIRECTORY, 0, 0);
}

int ss_open_file_at(int dir_fd, const uint8_t *name, size_t name_len) {
    return ss_open_component(dir_fd, name, name_len, O_RDONLY, 0, 0);
}

int ss_open_sync_file_at(int dir_fd, const uint8_t *name, size_t name_len) {
    return ss_open_component(dir_fd, name, name_len, O_RDWR, 0, 0);
}

int ss_open_lock_at(int dir_fd, const uint8_t *name, size_t name_len) {
    return ss_open_component(dir_fd, name, name_len, O_RDWR, 0, 0);
}

int ss_create_wal_at(int dir_fd, const uint8_t *name, size_t name_len) {
    return ss_open_component(dir_fd, name, name_len,
                             O_RDWR | O_APPEND | O_CREAT | O_EXCL,
                             S_IRUSR | S_IWUSR, 1);
}

int ss_open_wal_at(int dir_fd, const uint8_t *name, size_t name_len) {
    return ss_open_component(dir_fd, name, name_len, O_RDWR | O_APPEND, 0, 0);
}

static void ss_copy_stat(const struct stat *source, struct ss_stat *out) {
    out->dev = (uint64_t)source->st_dev;
    out->ino = (uint64_t)source->st_ino;
    out->nlink = (uint64_t)source->st_nlink;
    out->size = source->st_size < 0 ? 0 : (uint64_t)source->st_size;
    out->mode = (uint32_t)source->st_mode;
    out->uid = (uint32_t)source->st_uid;
    out->gid = (uint32_t)source->st_gid;
    out->gen = (uint32_t)source->st_gen;
    out->mtime_sec = (int64_t)source->st_mtimespec.tv_sec;
    out->mtime_nsec = (int64_t)source->st_mtimespec.tv_nsec;
    out->ctime_sec = (int64_t)source->st_ctimespec.tv_sec;
    out->ctime_nsec = (int64_t)source->st_ctimespec.tv_nsec;
}

int ss_stat_fd(int fd, struct ss_stat *out) {
    if (out == NULL) {
        return -EINVAL;
    }
    struct stat value;
    if (fstat(fd, &value) != 0) {
        return -errno;
    }
    ss_copy_stat(&value, out);
    return 0;
}

int ss_stat_at(int dir_fd, const uint8_t *name, size_t name_len,
               struct ss_stat *out) {
    if (out == NULL) {
        return -EINVAL;
    }
    char *value = NULL;
    int rc = ss_component(name, name_len, &value);
    if (rc != 0) {
        return rc;
    }
    struct stat st;
    rc = fstatat(dir_fd, value, &st, AT_SYMLINK_NOFOLLOW);
    int saved = errno;
    free(value);
    if (rc != 0) {
        return -saved;
    }
    ss_copy_stat(&st, out);
    return 0;
}

void *ss_dir_open(int dir_fd) {
    /*
     * dup(2) would share the directory seek offset with dir_fd, causing a
     * second digest pass to begin at EOF. Opening "." creates a fresh open-file
     * description while remaining anchored to the already-validated FD.
     */
    int copy = openat(dir_fd, ".",
                      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (copy < 0) {
        return NULL;
    }
    DIR *dir = fdopendir(copy);
    if (dir == NULL) {
        int saved = errno;
        close(copy);
        errno = saved;
        return NULL;
    }
    return (void *)dir;
}

int ss_dir_next(void *handle, uint8_t *name_out, size_t name_cap,
                size_t *name_len_out) {
    if (handle == NULL || name_out == NULL || name_len_out == NULL) {
        return -EINVAL;
    }
    DIR *dir = (DIR *)handle;
    errno = 0;
    struct dirent *entry = readdir(dir);
    if (entry == NULL) {
        return errno == 0 ? 0 : -errno;
    }
    size_t len = (size_t)entry->d_namlen;
    if (len == 0 || len > name_cap) {
        return -ENAMETOOLONG;
    }
    memcpy(name_out, entry->d_name, len);
    *name_len_out = len;
    return 1;
}

int ss_dir_close(void *handle) {
    if (handle == NULL) {
        return -EINVAL;
    }
    return closedir((DIR *)handle) == 0 ? 0 : -errno;
}

int ss_require_plain_security(int fd) {
    /* On APFS, no extended ACL is represented as NULL plus ENOENT. Any
     * retrievable ACL object is rejected, including an explicitly empty one. */
    errno = 0;
    acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
    if (acl != NULL) {
        acl_free(acl);
        return -EPERM;
    }
    if (errno != ENOENT) {
        return -errno;
    }

    /*
     * macOS attaches com.apple.provenance to files created by this host and
     * does not make it reliably removable. It is the sole accepted xattr;
     * resource forks, quarantine, Finder metadata, and every user xattr are
     * rejected. ctime is bound by the surrounding stat/digest checks.
     */
    ssize_t names_len = flistxattr(fd, NULL, 0, 0);
    if (names_len < 0) {
        return -errno;
    }
    if (names_len == 0) {
        return 0;
    }
    if (names_len > 4096) {
        return -E2BIG;
    }
    char *names = (char *)malloc((size_t)names_len);
    if (names == NULL) {
        return -ENOMEM;
    }
    ssize_t read_len = flistxattr(fd, names, (size_t)names_len, 0);
    if (read_len != names_len) {
        int saved = read_len < 0 ? errno : EAGAIN;
        free(names);
        return -saved;
    }
    static const char allowed[] = "com.apple.provenance";
    size_t offset = 0;
    while (offset < (size_t)read_len) {
        size_t remaining = (size_t)read_len - offset;
        size_t length = strnlen(names + offset, remaining);
        if (length == remaining || length != sizeof(allowed) - 1 ||
            memcmp(names + offset, allowed, sizeof(allowed)) != 0) {
            free(names);
            return -EPERM;
        }
        offset += length + 1;
    }
    free(names);
    return 0;
}

int ss_read_provenance(int fd, uint8_t *output, size_t output_cap,
                       size_t *output_len) {
    if (output == NULL || output_len == NULL) {
        return -EINVAL;
    }
    static const char name[] = "com.apple.provenance";
    errno = 0;
    ssize_t length = fgetxattr(fd, name, NULL, 0, 0, 0);
    if (length < 0) {
        if (errno == ENOATTR) {
            *output_len = 0;
            return 0;
        }
        return -errno;
    }
    if ((size_t)length > output_cap) {
        return -ERANGE;
    }
    ssize_t read_length = fgetxattr(fd, name, output, output_cap, 0, 0);
    if (read_length != length) {
        return read_length < 0 ? -errno : -EAGAIN;
    }
    *output_len = (size_t)read_length;
    return 1;
}

int ss_volume_capabilities(int root_fd, uint32_t *out_bits) {
    if (out_bits == NULL) {
        return -EINVAL;
    }
    struct attrlist attrs;
    memset(&attrs, 0, sizeof(attrs));
    attrs.bitmapcount = ATTR_BIT_MAP_COUNT;
    attrs.volattr = ATTR_VOL_INFO | ATTR_VOL_CAPABILITIES;

    struct {
        uint32_t length;
        vol_capabilities_attr_t caps;
    } result;
    memset(&result, 0, sizeof(result));
    if (fgetattrlist(root_fd, &attrs, &result, sizeof(result), 0) != 0) {
        return -errno;
    }
    if (result.length < sizeof(result)) {
        return -EPROTO;
    }

    uint32_t bits = 0;
    const uint32_t valid = result.caps.valid[VOL_CAPABILITIES_INTERFACES];
    const uint32_t caps = result.caps.capabilities[VOL_CAPABILITIES_INTERFACES];
#define SS_CAP(bit, output) do { if ((valid & (bit)) != 0 && (caps & (bit)) != 0) bits |= (output); } while (0)
    SS_CAP(VOL_CAP_INT_RENAME_SWAP, 1u << 0);
    SS_CAP(VOL_CAP_INT_FLOCK, 1u << 1);
    SS_CAP(VOL_CAP_INT_EXTENDED_ATTR, 1u << 2);
    SS_CAP(VOL_CAP_INT_EXTENDED_SECURITY, 1u << 3);
#undef SS_CAP
    *out_bits = bits;
    return 0;
}

int ss_lock_exclusive(int fd) {
    if (flock(fd, LOCK_EX | LOCK_NB) == 0) {
        return 0;
    }
    return errno == EWOULDBLOCK ? 1 : -errno;
}

int ss_unlock(int fd) {
    return flock(fd, LOCK_UN) == 0 ? 0 : -errno;
}

int ss_sync_regular(int fd) {
    if (fsync(fd) != 0) {
        return -errno;
    }
    if (fcntl(fd, F_FULLFSYNC) != 0) {
        return -errno;
    }
    return 0;
}

int ss_sync_directory(int fd) {
    return fsync(fd) == 0 ? 0 : -errno;
}

static int ss_rename_at(int dir_fd,
                        const uint8_t *from, size_t from_len,
                        const uint8_t *to, size_t to_len,
                        unsigned int flags) {
    char *from_value = NULL;
    char *to_value = NULL;
    int rc = ss_component(from, from_len, &from_value);
    if (rc != 0) {
        return rc;
    }
    rc = ss_component(to, to_len, &to_value);
    if (rc != 0) {
        free(from_value);
        return rc;
    }
    rc = renameatx_np(dir_fd, from_value, dir_fd, to_value, flags);
    int saved = errno;
    free(from_value);
    free(to_value);
    return rc == 0 ? 0 : -saved;
}

int ss_swap_at(int root_fd,
               const uint8_t *active, size_t active_len,
               const uint8_t *stage, size_t stage_len) {
    /* Both names are strict single components beneath the same held dirfd.
     * RENAME_RESOLVE_BENEATH is redundant here and unavailable before the
     * macOS 26 SDK/kernel, so keep the portable no-follow contract. */
    return ss_rename_at(root_fd, active, active_len, stage, stage_len,
                        RENAME_SWAP | RENAME_NOFOLLOW_ANY);
}

int ss_rename_exclusive_at(int dir_fd,
                           const uint8_t *from, size_t from_len,
                           const uint8_t *to, size_t to_len) {
    return ss_rename_at(dir_fd, from, from_len, to, to_len,
                        RENAME_EXCL | RENAME_NOFOLLOW_ANY);
}
