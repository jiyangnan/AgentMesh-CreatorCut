#ifndef CREATORCUT_SECURE_SWAP_DARWIN_SHIM_H
#define CREATORCUT_SECURE_SWAP_DARWIN_SHIM_H

#include <stddef.h>
#include <stdint.h>

/*
 * Narrow Darwin ABI used by the raw-Rust prototype.  Every pathname accepted
 * here is either a canonical absolute project-root path (opened with
 * O_NOFOLLOW_ANY) or
 * one validated, single path component relative to an already-held directory
 * descriptor.  The shim deliberately exposes no recursive or destructive
 * primitive.
 */

struct ss_stat {
    uint64_t dev;
    uint64_t ino;
    uint64_t nlink;
    uint64_t size;
    uint32_t mode;
    uint32_t uid;
    uint32_t gid;
    uint32_t gen;
    int64_t mtime_sec;
    int64_t mtime_nsec;
    int64_t ctime_sec;
    int64_t ctime_nsec;
};

/* File-descriptor and metadata operations.  Failures are returned as -errno. */
int ss_open_project_root(const uint8_t *path, size_t path_len);
int ss_open_dir_at(int dir_fd, const uint8_t *name, size_t name_len);
int ss_open_file_at(int dir_fd, const uint8_t *name, size_t name_len);
int ss_open_sync_file_at(int dir_fd, const uint8_t *name, size_t name_len);
int ss_open_lock_at(int dir_fd, const uint8_t *name, size_t name_len);
int ss_create_wal_at(int dir_fd, const uint8_t *name, size_t name_len);
int ss_open_wal_at(int dir_fd, const uint8_t *name, size_t name_len);
int ss_stat_fd(int fd, struct ss_stat *out);
int ss_stat_at(int dir_fd, const uint8_t *name, size_t name_len,
               struct ss_stat *out);

/* Directory iteration owns a fresh openat(".") description and never consumes dir_fd. */
void *ss_dir_open(int dir_fd);
int ss_dir_next(void *handle, uint8_t *name_out, size_t name_cap,
                size_t *name_len_out);
int ss_dir_close(void *handle);

/*
 * Returns zero only when the object has no ACL and ATTR_CMNEXT_EXT_FLAGS
 * positively reports EF_NO_XATTRS.  Unsupported/ambiguous reports fail closed.
 */
int ss_require_plain_security(int fd);
/* Returns 0 when absent, 1 when present, negative errno on failure. */
int ss_read_provenance(int fd, uint8_t *output, size_t output_cap,
                       size_t *output_len);

/* Bit 0 = RENAME_SWAP, bit 1 = flock, bit 2 = extended attributes,
 * bit 3 = extended security.  A bit is set only when both valid and supported.
 */
int ss_volume_capabilities(int root_fd, uint32_t *out_bits);

/* Returns 0 on lock, 1 when another holder owns the lock, negative errno otherwise. */
int ss_lock_exclusive(int fd);
int ss_unlock(int fd);
int ss_sync_regular(int fd); /* fsync followed by F_FULLFSYNC */
int ss_sync_directory(int fd); /* directory fsync only */

int ss_swap_at(int root_fd,
               const uint8_t *active, size_t active_len,
               const uint8_t *stage, size_t stage_len);

/* Reserved for an atomic no-clobber WAL publication variant. */
int ss_rename_exclusive_at(int dir_fd,
                           const uint8_t *from, size_t from_len,
                           const uint8_t *to, size_t to_len);

#endif
