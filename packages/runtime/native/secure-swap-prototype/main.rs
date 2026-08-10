#![forbid(unsafe_op_in_unsafe_fn)]

#[cfg(not(target_os = "macos"))]
compile_error!("secure-swap-prototype is Darwin-only");

mod sha256;

use sha256::{constant_time_eq, crc32, hash, Sha256};
use std::collections::{BTreeSet, HashSet};
use std::ffi::c_void;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::mem::MaybeUninit;
#[cfg(secure_swap_synthetic)]
use std::mem::ManuallyDrop;
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(secure_swap_synthetic)]
use std::os::fd::RawFd;

const MAGIC: &[u8; 4] = b"CCSW";
const PROTOCOL_SCHEMA: u16 = 1;
const DIGEST_SCHEMA: u16 = 2;
const WAL_SCHEMA: u16 = 2;
const BUILD_ID: [u8; 32] = *b"CCSW-M1-PROTOTYPE-20260810-0001D";

const OP_PROBE: u8 = 1;
const OP_CAPABILITIES: u8 = 2;
const OP_SWAP_FORWARD: u8 = 3;
const OP_RECOVER_FORWARD: u8 = 4;

const MAX_FRAME: usize = 128 * 1024;
const MAX_ROOT_PATH: usize = 4096;
const MAX_ENTRIES: u64 = 4096;
const MAX_TREE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_DEPTH: usize = 32;
const MAX_RELATIVE_BYTES: usize = 4096;
const MAX_WAL_BYTES: u64 = 1024 * 1024;
const MAX_PROVENANCE_BYTES: usize = 256;

const TYPE_MASK: u32 = 0o170000;
const TYPE_DIRECTORY: u32 = 0o040000;
const TYPE_REGULAR: u32 = 0o100000;
const GROUP_OR_WORLD_WRITE: u32 = 0o022;

const ACTIVE_NAME: &[u8] = b".creatorcut";
const CONTROL_NAME: &[u8] = b".creatorcut-control";
const LOCK_NAME: &[u8] = b"writer.lock";
const WAL_DIRECTORY_NAME: &[u8] = b"wal";
const MARKER_NAME: &[u8] = b"storage-authority.json";

const CAP_SWAP: u32 = 1 << 0;
const CAP_FLOCK: u32 = 1 << 1;

const BARRIER_AFTER_PREPARED: u32 = 1 << 0;
const BARRIER_AFTER_SWAP_SYSCALL: u32 = 1 << 1;
const BARRIER_AFTER_ROOT_SYNC: u32 = 1 << 2;
const BARRIER_AFTER_SWAPPED: u32 = 1 << 3;
const BARRIER_AFTER_COMMITTED: u32 = 1 << 4;
const BARRIER_ALL: u32 = BARRIER_AFTER_PREPARED
    | BARRIER_AFTER_SWAP_SYSCALL
    | BARRIER_AFTER_ROOT_SYNC
    | BARRIER_AFTER_SWAPPED
    | BARRIER_AFTER_COMMITTED;

#[cfg(secure_swap_synthetic)]
const SYNTHETIC_BARRIER_FD: RawFd = 198;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct RawStat {
    dev: u64,
    ino: u64,
    nlink: u64,
    size: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    generation: u32,
    mtime_sec: i64,
    mtime_nsec: i64,
    ctime_sec: i64,
    ctime_nsec: i64,
}

unsafe extern "C" {
    fn ss_open_project_root(path: *const u8, path_len: usize) -> i32;
    fn ss_open_dir_at(dir_fd: i32, name: *const u8, name_len: usize) -> i32;
    fn ss_open_file_at(dir_fd: i32, name: *const u8, name_len: usize) -> i32;
    fn ss_open_sync_file_at(dir_fd: i32, name: *const u8, name_len: usize) -> i32;
    fn ss_open_lock_at(dir_fd: i32, name: *const u8, name_len: usize) -> i32;
    fn ss_create_wal_at(dir_fd: i32, name: *const u8, name_len: usize) -> i32;
    fn ss_open_wal_at(dir_fd: i32, name: *const u8, name_len: usize) -> i32;
    fn ss_stat_fd(fd: i32, out: *mut RawStat) -> i32;
    fn ss_stat_at(dir_fd: i32, name: *const u8, name_len: usize, out: *mut RawStat) -> i32;
    fn ss_dir_open(dir_fd: i32) -> *mut c_void;
    fn ss_dir_next(
        handle: *mut c_void,
        name_out: *mut u8,
        name_cap: usize,
        name_len_out: *mut usize,
    ) -> i32;
    fn ss_dir_close(handle: *mut c_void) -> i32;
    fn ss_require_plain_security(fd: i32) -> i32;
    fn ss_read_provenance(
        fd: i32,
        output: *mut u8,
        output_cap: usize,
        output_len: *mut usize,
    ) -> i32;
    fn ss_volume_capabilities(root_fd: i32, out_bits: *mut u32) -> i32;
    fn ss_lock_exclusive(fd: i32) -> i32;
    fn ss_unlock(fd: i32) -> i32;
    fn ss_sync_regular(fd: i32) -> i32;
    fn ss_sync_directory(fd: i32) -> i32;
    fn ss_swap_at(
        root_fd: i32,
        active: *const u8,
        active_len: usize,
        stage: *const u8,
        stage_len: usize,
    ) -> i32;
}

#[derive(Clone, Copy, Debug)]
#[repr(u16)]
enum ErrorCode {
    Protocol = 1,
    Unsupported = 2,
    InvalidRequest = 3,
    Io = 4,
    UnsafeObject = 5,
    Limit = 6,
    Conflict = 7,
    Wal = 8,
    Capability = 9,
    Internal = 10,
    RecoveryRequired = 11,
}

#[derive(Clone, Copy, Debug)]
struct Failure {
    code: ErrorCode,
    message: &'static str,
}

type Result<T> = std::result::Result<T, Failure>;

fn fail<T>(code: ErrorCode, message: &'static str) -> Result<T> {
    Err(Failure { code, message })
}

fn ffi_ok(value: i32, message: &'static str) -> Result<()> {
    if value == 0 {
        Ok(())
    } else {
        fail(ErrorCode::Io, message)
    }
}

fn owned_fd(value: i32, message: &'static str) -> Result<File> {
    if value < 0 {
        return fail(ErrorCode::Io, message);
    }
    // SAFETY: the shim returns a fresh, owned descriptor on non-negative success.
    Ok(unsafe { File::from_raw_fd(value) })
}

fn open_absolute_directory(path: &[u8]) -> Result<File> {
    if path.is_empty()
        || path.len() > MAX_ROOT_PATH
        || path[0] != b'/'
        || path.contains(&0)
    {
        return fail(ErrorCode::InvalidRequest, "invalid project root");
    }
    // SAFETY: path is live for the duration of the call and the shim copies it.
    let value = unsafe { ss_open_project_root(path.as_ptr(), path.len()) };
    owned_fd(value, "absolute directory open failed")
}

fn open_project_root(path: &[u8]) -> Result<File> {
    if path.len() < 2 {
        return fail(ErrorCode::InvalidRequest, "invalid project root");
    }
    let file = open_absolute_directory(path).map_err(|_| Failure {
        code: ErrorCode::Io,
        message: "project root open failed",
    })?;
    let stat = stat_fd(&file)?;
    require_directory(&stat)?;
    if stat.mode & GROUP_OR_WORLD_WRITE != 0 {
        return fail(ErrorCode::UnsafeObject, "project root is group/world writable");
    }
    require_plain_security(&file)?;
    Ok(file)
}

fn split_project_root(path: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    if path.len() < 2 || path[path.len() - 1] == b'/' {
        return fail(ErrorCode::InvalidRequest, "invalid project root");
    }
    let slash = path.iter().rposition(|byte| *byte == b'/').ok_or(Failure {
        code: ErrorCode::InvalidRequest,
        message: "invalid project root",
    })?;
    let parent = if slash == 0 { b"/".to_vec() } else { path[..slash].to_vec() };
    let leaf = path[slash + 1..].to_vec();
    validate_component(&leaf)?;
    Ok((parent, leaf))
}

fn project_root_path_digest(path: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"CCSW-PROJECT-ROOT-PATH-V1\0");
    hasher.update(&(path.len() as u32).to_be_bytes());
    hasher.update(path);
    hasher.finalize()
}

fn open_dir_at(parent: &File, name: &[u8]) -> Result<File> {
    validate_component(name)?;
    // SAFETY: name is a validated component and remains live for this call.
    let value = unsafe { ss_open_dir_at(parent.as_raw_fd(), name.as_ptr(), name.len()) };
    owned_fd(value, "directory open failed")
}

fn open_file_at(parent: &File, name: &[u8]) -> Result<File> {
    validate_component(name)?;
    // SAFETY: name is a validated component and remains live for this call.
    let value = unsafe { ss_open_file_at(parent.as_raw_fd(), name.as_ptr(), name.len()) };
    owned_fd(value, "file open failed")
}

fn open_sync_file_at(parent: &File, name: &[u8]) -> Result<File> {
    validate_component(name)?;
    // SAFETY: name is a validated component and remains live for this call.
    let value = unsafe {
        ss_open_sync_file_at(parent.as_raw_fd(), name.as_ptr(), name.len())
    };
    owned_fd(value, "stage file durability open failed")
}

fn open_lock_at(parent: &File, name: &[u8]) -> Result<File> {
    validate_component(name)?;
    // SAFETY: name is a validated component and remains live for this call.
    let value = unsafe { ss_open_lock_at(parent.as_raw_fd(), name.as_ptr(), name.len()) };
    owned_fd(value, "lock open failed")
}

fn create_wal_at(parent: &File, name: &[u8]) -> Result<File> {
    validate_component(name)?;
    // SAFETY: name is a validated component and remains live for this call.
    let value = unsafe { ss_create_wal_at(parent.as_raw_fd(), name.as_ptr(), name.len()) };
    owned_fd(value, "WAL creation failed")
}

fn open_wal_at(parent: &File, name: &[u8]) -> Result<File> {
    validate_component(name)?;
    // SAFETY: name is a validated component and remains live for this call.
    let value = unsafe { ss_open_wal_at(parent.as_raw_fd(), name.as_ptr(), name.len()) };
    owned_fd(value, "WAL open failed")
}

fn stat_fd(file: &File) -> Result<RawStat> {
    let mut output = MaybeUninit::<RawStat>::uninit();
    // SAFETY: output points at writable storage of the exact C ABI type.
    let rc = unsafe { ss_stat_fd(file.as_raw_fd(), output.as_mut_ptr()) };
    ffi_ok(rc, "descriptor stat failed")?;
    // SAFETY: the shim initializes the full output structure on success.
    Ok(unsafe { output.assume_init() })
}

fn stat_at(parent: &File, name: &[u8]) -> Result<RawStat> {
    validate_component(name)?;
    let mut output = MaybeUninit::<RawStat>::uninit();
    // SAFETY: name and output are valid for the duration of the call.
    let rc = unsafe {
        ss_stat_at(
            parent.as_raw_fd(),
            name.as_ptr(),
            name.len(),
            output.as_mut_ptr(),
        )
    };
    ffi_ok(rc, "name stat failed")?;
    // SAFETY: the shim initializes the full output structure on success.
    Ok(unsafe { output.assume_init() })
}

fn require_plain_security(file: &File) -> Result<()> {
    // SAFETY: file owns a valid descriptor for the duration of the call.
    let rc = unsafe { ss_require_plain_security(file.as_raw_fd()) };
    if rc == 0 {
        Ok(())
    } else {
        fail(ErrorCode::UnsafeObject, "ACL/xattr policy rejected object")
    }
}

fn provenance_digest(file: &File) -> Result<[u8; 32]> {
    let mut bytes = [0u8; MAX_PROVENANCE_BYTES];
    let mut length = 0usize;
    // SAFETY: the output buffer and length pointer remain valid for the call.
    let present = unsafe {
        ss_read_provenance(
            file.as_raw_fd(),
            bytes.as_mut_ptr(),
            bytes.len(),
            &mut length,
        )
    };
    if present < 0 || length > bytes.len() {
        return fail(ErrorCode::UnsafeObject, "provenance xattr read rejected");
    }
    if present != 0 && present != 1 {
        return fail(ErrorCode::Internal, "provenance xattr ABI rejected");
    }
    Ok(provenance_value_digest(present as u8, &bytes[..length]))
}

fn provenance_value_digest(present: u8, bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"CCSW-PROVENANCE-DIGEST-V1\0");
    hasher.update(&[present]);
    hasher.update(&(bytes.len() as u32).to_be_bytes());
    hasher.update(bytes);
    hasher.finalize()
}

fn volume_capabilities(root: &File) -> Result<u32> {
    let mut output = 0u32;
    // SAFETY: output is a valid pointer and root remains open.
    let rc = unsafe { ss_volume_capabilities(root.as_raw_fd(), &mut output) };
    ffi_ok(rc, "volume capability query failed")?;
    Ok(output)
}

fn sync_regular(file: &File) -> Result<()> {
    // SAFETY: file remains open; the shim performs fsync then F_FULLFSYNC.
    ffi_ok(
        unsafe { ss_sync_regular(file.as_raw_fd()) },
        "regular-file durability failed",
    )
}

fn sync_directory(file: &File) -> Result<()> {
    // SAFETY: file remains open and was validated as a directory.
    ffi_ok(
        unsafe { ss_sync_directory(file.as_raw_fd()) },
        "directory durability failed",
    )
}

fn validate_component(name: &[u8]) -> Result<()> {
    if name.is_empty()
        || name.len() > 255
        || name == b"."
        || name == b".."
        || name.contains(&0)
        || name.contains(&b'/')
    {
        return fail(ErrorCode::InvalidRequest, "invalid path component");
    }
    Ok(())
}

fn require_directory(stat: &RawStat) -> Result<()> {
    if stat.mode & TYPE_MASK == TYPE_DIRECTORY {
        Ok(())
    } else {
        fail(ErrorCode::UnsafeObject, "expected directory")
    }
}

fn require_regular(stat: &RawStat) -> Result<()> {
    if stat.mode & TYPE_MASK != TYPE_REGULAR {
        return fail(ErrorCode::UnsafeObject, "expected regular file");
    }
    if stat.nlink != 1 {
        return fail(ErrorCode::UnsafeObject, "hard-linked file rejected");
    }
    Ok(())
}

fn stable_stat(left: &RawStat, right: &RawStat) -> bool {
    left == right
}

fn same_identity(left: &RawStat, right: &RawStat) -> bool {
    left.dev == right.dev
        && left.ino == right.ino
        && left.generation == right.generation
        && left.mode == right.mode
        && left.uid == right.uid
        && left.gid == right.gid
        && left.nlink == right.nlink
        && left.size == right.size
}

fn same_bound_root(left: &RawStat, right: &RawStat) -> bool {
    left.dev == right.dev
        && left.ino == right.ino
        && left.generation == right.generation
        && left.uid == right.uid
        && left.gid == right.gid
        && left.mode == right.mode
}

fn same_wal_identity(left: &RawStat, right: &RawStat) -> bool {
    left.dev == right.dev
        && left.ino == right.ino
        && left.generation == right.generation
        && left.mode == right.mode
        && left.uid == right.uid
        && left.gid == right.gid
        && left.nlink == right.nlink
}

struct DirectoryReader(*mut c_void);

impl DirectoryReader {
    fn open(file: &File) -> Result<Self> {
        // SAFETY: the shim duplicates the valid descriptor before fdopendir.
        let handle = unsafe { ss_dir_open(file.as_raw_fd()) };
        if handle.is_null() {
            fail(ErrorCode::Io, "directory iteration open failed")
        } else {
            Ok(Self(handle))
        }
    }

    fn next(&mut self) -> Result<Option<Vec<u8>>> {
        let mut buffer = [0u8; 255];
        let mut length = 0usize;
        // SAFETY: handle is owned by self and both output buffers are valid.
        let rc = unsafe {
            ss_dir_next(
                self.0,
                buffer.as_mut_ptr(),
                buffer.len(),
                &mut length,
            )
        };
        match rc {
            0 => Ok(None),
            1 if length <= buffer.len() => Ok(Some(buffer[..length].to_vec())),
            _ => fail(ErrorCode::Io, "directory iteration failed"),
        }
    }
}

impl Drop for DirectoryReader {
    fn drop(&mut self) {
        // SAFETY: this handle is uniquely owned and is closed exactly once.
        let _ = unsafe { ss_dir_close(self.0) };
    }
}

fn sorted_names(directory: &File) -> Result<Vec<Vec<u8>>> {
    let mut reader = DirectoryReader::open(directory)?;
    let mut names = Vec::new();
    while let Some(name) = reader.next()? {
        if name == b"." || name == b".." {
            continue;
        }
        validate_component(&name)?;
        names.push(name);
        if names.len() as u64 > MAX_ENTRIES {
            return fail(ErrorCode::Limit, "entry cap exceeded");
        }
    }
    names.sort();
    names.dedup();
    Ok(names)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TreePolicy {
    ActiveOpaque,
    PublicStage,
}

#[derive(Clone, Debug)]
struct TreeDigest {
    identity: RawStat,
    digest: [u8; 32],
    marker_digest: Option<[u8; 32]>,
}

impl TreeDigest {
    fn matches(&self, other: &Self) -> bool {
        same_identity(&self.identity, &other.identity)
            && constant_time_eq(&self.digest, &other.digest)
            && self.marker_digest == other.marker_digest
    }
}

#[derive(Default)]
struct StageShape {
    root_names: BTreeSet<Vec<u8>>,
    versions: BTreeSet<u64>,
    fine_cut_members: usize,
    tasks_entries: usize,
    marker_digest: Option<[u8; 32]>,
}

struct WalkState {
    hasher: Sha256,
    entries: u64,
    bytes: u64,
    root_dev: u64,
    owner_uid: u32,
    seen_directories: HashSet<(u64, u64)>,
    policy: TreePolicy,
    stage: StageShape,
}

fn digest_tree(
    root: &File,
    policy: TreePolicy,
    expected_dev: u64,
    expected_uid: u32,
) -> Result<TreeDigest> {
    let before = stat_fd(root)?;
    require_directory(&before)?;
    require_tree_object(&before, expected_dev, expected_uid)?;
    require_plain_security(root)?;

    let mut state = WalkState {
        hasher: Sha256::new(),
        entries: 0,
        bytes: 0,
        root_dev: expected_dev,
        owner_uid: expected_uid,
        seen_directories: HashSet::new(),
        policy,
        stage: StageShape::default(),
    };
    state.hasher.update(b"CCSW-TREE-DIGEST-V2\0");
    if !state.seen_directories.insert((before.dev, before.ino)) {
        return fail(ErrorCode::UnsafeObject, "directory cycle rejected");
    }
    let root_provenance = provenance_digest(root)?;
    hash_entry(
        &mut state.hasher,
        b"",
        1,
        &before,
        &[0; 32],
        &root_provenance,
    );
    walk_directory(root, b"", 0, &mut state)?;

    if policy == TreePolicy::PublicStage {
        sync_directory(root)?;
    }
    let after = stat_fd(root)?;
    if !stable_stat(&before, &after) {
        return fail(ErrorCode::Conflict, "tree changed during digest");
    }
    if policy == TreePolicy::PublicStage {
        validate_stage_shape(&state.stage)?;
    }
    Ok(TreeDigest {
        identity: before,
        digest: state.hasher.finalize(),
        marker_digest: state.stage.marker_digest,
    })
}

fn walk_directory(
    directory: &File,
    relative: &[u8],
    depth: usize,
    state: &mut WalkState,
) -> Result<()> {
    if depth >= MAX_DEPTH {
        return fail(ErrorCode::Limit, "depth cap exceeded");
    }
    let names = sorted_names(directory)?;
    if state.policy == TreePolicy::PublicStage && relative == b"tasks" {
        state.stage.tasks_entries = names.len();
    }
    for name in names {
        state.entries = state.entries.checked_add(1)
            .ok_or(Failure { code: ErrorCode::Limit, message: "entry counter overflow" })?;
        if state.entries > MAX_ENTRIES {
            return fail(ErrorCode::Limit, "entry cap exceeded");
        }
        let child_relative = join_relative(relative, &name)?;
        let by_name = stat_at(directory, &name)?;
        let object_type = by_name.mode & TYPE_MASK;
        match object_type {
            TYPE_DIRECTORY => {
                let child = open_dir_at(directory, &name)?;
                let opened = stat_fd(&child)?;
                if !stable_stat(&by_name, &opened) {
                    return fail(ErrorCode::Conflict, "directory identity changed before open");
                }
                require_tree_object(&opened, state.root_dev, state.owner_uid)?;
                require_plain_security(&child)?;
                let provenance = provenance_digest(&child)?;
                validate_stage_entry(state, relative, &name, true)?;
                if !state.seen_directories.insert((opened.dev, opened.ino)) {
                    return fail(ErrorCode::UnsafeObject, "directory cycle rejected");
                }
                hash_entry(
                    &mut state.hasher,
                    &child_relative,
                    1,
                    &opened,
                    &[0; 32],
                    &provenance,
                );
                walk_directory(&child, &child_relative, depth + 1, state)?;
                if state.policy == TreePolicy::PublicStage {
                    sync_directory(&child)?;
                }
                let after = stat_fd(&child)?;
                if !stable_stat(&opened, &after) {
                    return fail(ErrorCode::Conflict, "directory changed during digest");
                }
            }
            TYPE_REGULAR => {
                require_regular(&by_name)?;
                if by_name.size > MAX_FILE_BYTES {
                    return fail(ErrorCode::Limit, "file cap exceeded");
                }
                let child = if state.policy == TreePolicy::PublicStage {
                    open_sync_file_at(directory, &name)?
                } else {
                    open_file_at(directory, &name)?
                };
                let opened = stat_fd(&child)?;
                if !stable_stat(&by_name, &opened) {
                    return fail(ErrorCode::Conflict, "file identity changed before open");
                }
                require_tree_object(&opened, state.root_dev, state.owner_uid)?;
                require_regular(&opened)?;
                require_plain_security(&child)?;
                let provenance = provenance_digest(&child)?;
                validate_stage_entry(state, relative, &name, false)?;
                let require_utf8 = state.policy == TreePolicy::PublicStage;
                let content_digest = digest_regular(
                    &child,
                    &opened,
                    state,
                    require_utf8,
                )?;
                if state.policy == TreePolicy::PublicStage {
                    sync_regular(&child)?;
                    let after_sync = stat_fd(&child)?;
                    if !stable_stat(&opened, &after_sync) {
                        return fail(
                            ErrorCode::Conflict,
                            "stage file changed during durability sync",
                        );
                    }
                }
                if child_relative == MARKER_NAME {
                    state.stage.marker_digest = Some(content_digest);
                }
                hash_entry(
                    &mut state.hasher,
                    &child_relative,
                    2,
                    &opened,
                    &content_digest,
                    &provenance,
                );
            }
            _ => return fail(ErrorCode::UnsafeObject, "symlink or special object rejected"),
        }
    }
    Ok(())
}

fn require_tree_object(stat: &RawStat, dev: u64, uid: u32) -> Result<()> {
    if stat.dev != dev {
        return fail(ErrorCode::UnsafeObject, "mount boundary rejected");
    }
    if stat.uid != uid {
        return fail(ErrorCode::UnsafeObject, "foreign owner rejected");
    }
    if stat.mode & GROUP_OR_WORLD_WRITE != 0 {
        return fail(ErrorCode::UnsafeObject, "group/world writable object rejected");
    }
    Ok(())
}

fn join_relative(parent: &[u8], name: &[u8]) -> Result<Vec<u8>> {
    let additional = name.len() + usize::from(!parent.is_empty());
    let length = parent.len().checked_add(additional)
        .ok_or(Failure { code: ErrorCode::Limit, message: "relative path overflow" })?;
    if length > MAX_RELATIVE_BYTES {
        return fail(ErrorCode::Limit, "relative path cap exceeded");
    }
    let mut output = Vec::with_capacity(length);
    output.extend_from_slice(parent);
    if !parent.is_empty() {
        output.push(b'/');
    }
    output.extend_from_slice(name);
    Ok(output)
}

fn digest_regular(
    file: &File,
    before: &RawStat,
    state: &mut WalkState,
    require_utf8: bool,
) -> Result<[u8; 32]> {
    let next_total = state.bytes.checked_add(before.size)
        .ok_or(Failure { code: ErrorCode::Limit, message: "tree byte counter overflow" })?;
    if next_total > MAX_TREE_BYTES {
        return fail(ErrorCode::Limit, "tree byte cap exceeded");
    }
    state.bytes = next_total;

    let mut reader = file.try_clone().map_err(|_| Failure {
        code: ErrorCode::Io,
        message: "file descriptor clone failed",
    })?;
    reader.seek(SeekFrom::Start(0)).map_err(|_| Failure {
        code: ErrorCode::Io,
        message: "file seek failed",
    })?;
    let mut hasher = Sha256::new();
    let mut consumed = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    let mut utf8_bytes = if require_utf8 {
        Some(Vec::with_capacity(before.size as usize))
    } else {
        None
    };
    loop {
        let count = reader.read(&mut buffer).map_err(|_| Failure {
            code: ErrorCode::Io,
            message: "file read failed",
        })?;
        if count == 0 {
            break;
        }
        consumed = consumed.checked_add(count as u64)
            .ok_or(Failure { code: ErrorCode::Limit, message: "file byte counter overflow" })?;
        if consumed > before.size || consumed > MAX_FILE_BYTES {
            return fail(ErrorCode::Conflict, "file grew during digest");
        }
        hasher.update(&buffer[..count]);
        if let Some(bytes) = utf8_bytes.as_mut() {
            bytes.extend_from_slice(&buffer[..count]);
        }
    }
    if consumed != before.size {
        return fail(ErrorCode::Conflict, "file size changed during digest");
    }
    let after = stat_fd(file)?;
    if !stable_stat(before, &after) {
        return fail(ErrorCode::Conflict, "file changed during digest");
    }
    if let Some(bytes) = utf8_bytes {
        if std::str::from_utf8(&bytes).is_err() {
            return fail(ErrorCode::UnsafeObject, "public metadata is not UTF-8");
        }
    }
    Ok(hasher.finalize())
}

fn hash_entry(
    hasher: &mut Sha256,
    relative: &[u8],
    object_type: u8,
    stat: &RawStat,
    content_digest: &[u8; 32],
    provenance_digest: &[u8; 32],
) {
    hasher.update(&(relative.len() as u32).to_be_bytes());
    hasher.update(relative);
    hasher.update(&[object_type]);
    hasher.update(&stat.mode.to_be_bytes());
    hasher.update(&stat.uid.to_be_bytes());
    hasher.update(&stat.gid.to_be_bytes());
    hasher.update(&stat.dev.to_be_bytes());
    hasher.update(&stat.ino.to_be_bytes());
    hasher.update(&stat.nlink.to_be_bytes());
    hasher.update(&stat.size.to_be_bytes());
    hasher.update(&stat.generation.to_be_bytes());
    hasher.update(content_digest);
    hasher.update(provenance_digest);
}

fn validate_stage_entry(
    state: &mut WalkState,
    parent: &[u8],
    name: &[u8],
    is_directory: bool,
) -> Result<()> {
    if state.policy != TreePolicy::PublicStage {
        return Ok(());
    }
    if parent.is_empty() {
        const REQUIRED_OR_OPTIONAL_FILES: &[&[u8]] = &[
            b"project.json",
            b"timeline.json",
            b"transcript.json",
            b"edit-brief.json",
            b"history.json",
            b"operations.jsonl",
            b"visual-composition.json",
            b"rough-cut-confirmation.json",
            b"fine-cut-card-chain.json",
            b"visual-composition-candidate.json",
            b"storage-authority.json",
            b"storage-mutations.jsonl",
        ];
        let allowed_directory = name == b"versions" || name == b"tasks";
        let allowed_file = REQUIRED_OR_OPTIONAL_FILES.iter().any(|candidate| *candidate == name);
        if (is_directory && !allowed_directory) || (!is_directory && !allowed_file) {
            return fail(ErrorCode::UnsafeObject, "unknown public-stage entry rejected");
        }
        state.stage.root_names.insert(name.to_vec());
        if name == b"rough-cut-confirmation.json"
            || name == b"fine-cut-card-chain.json"
            || name == b"visual-composition-candidate.json"
        {
            state.stage.fine_cut_members += 1;
        }
        return Ok(());
    }
    if parent == b"versions" {
        if is_directory {
            return fail(ErrorCode::UnsafeObject, "nested versions directory rejected");
        }
        let revision = parse_version_name(name)?;
        if !state.stage.versions.insert(revision) {
            return fail(ErrorCode::UnsafeObject, "duplicate version rejected");
        }
        return Ok(());
    }
    if parent == b"tasks" {
        return fail(ErrorCode::UnsafeObject, "public tasks directory must be empty");
    }
    fail(ErrorCode::UnsafeObject, "nested public-stage entry rejected")
}

fn parse_version_name(name: &[u8]) -> Result<u64> {
    if name.len() < 6 || !name.ends_with(b".json") {
        return fail(ErrorCode::UnsafeObject, "invalid version filename");
    }
    let digits = &name[..name.len() - 5];
    if digits.is_empty()
        || (digits.len() > 1 && digits[0] == b'0')
        || !digits.iter().all(u8::is_ascii_digit)
    {
        return fail(ErrorCode::UnsafeObject, "invalid version filename");
    }
    let mut value = 0u64;
    for digit in digits {
        value = value.checked_mul(10)
            .and_then(|current| current.checked_add((digit - b'0') as u64))
            .ok_or(Failure { code: ErrorCode::Limit, message: "version number overflow" })?;
    }
    Ok(value)
}

fn validate_stage_shape(stage: &StageShape) -> Result<()> {
    const REQUIRED: &[&[u8]] = &[
        b"project.json",
        b"timeline.json",
        b"history.json",
        b"operations.jsonl",
        b"versions",
        b"storage-authority.json",
        b"storage-mutations.jsonl",
    ];
    if REQUIRED.iter().any(|name| !stage.root_names.contains(*name)) {
        return fail(ErrorCode::UnsafeObject, "required public-stage entry missing");
    }
    if stage.fine_cut_members != 0 && stage.fine_cut_members != 3 {
        return fail(ErrorCode::UnsafeObject, "fine-cut trio must be all-or-none");
    }
    if stage.tasks_entries != 0 {
        return fail(ErrorCode::UnsafeObject, "public tasks directory must be empty");
    }
    if stage.versions.is_empty() || !stage.versions.contains(&0) {
        return fail(ErrorCode::UnsafeObject, "version sequence must begin at zero");
    }
    let maximum = *stage.versions.iter().next_back().expect("non-empty versions");
    if maximum.checked_add(1) != Some(stage.versions.len() as u64) {
        return fail(ErrorCode::UnsafeObject, "version sequence is not continuous");
    }
    if stage.marker_digest.is_none() {
        return fail(ErrorCode::UnsafeObject, "authority marker missing");
    }
    Ok(())
}

#[derive(Clone, Debug)]
struct BoundTree {
    identity: RawStat,
    digest: [u8; 32],
}

impl From<&TreeDigest> for BoundTree {
    fn from(value: &TreeDigest) -> Self {
        Self {
            identity: value.identity,
            digest: value.digest,
        }
    }
}

#[derive(Clone, Debug)]
struct Binding {
    tx: [u8; 16],
    project_uuid: [u8; 16],
    nonce: [u8; 32],
    generation: u64,
    marker_digest: [u8; 32],
    root_path_digest: [u8; 32],
    project_parent: RawStat,
    project_root: RawStat,
    project_leaf: Vec<u8>,
    active_name: Vec<u8>,
    stage_name: Vec<u8>,
    active: BoundTree,
    stage: BoundTree,
}

impl Binding {
    fn encode(&self) -> Vec<u8> {
        let mut output = Vec::with_capacity(512);
        output.extend_from_slice(b"CCSW-BINDING-V2\0");
        output.extend_from_slice(&PROTOCOL_SCHEMA.to_be_bytes());
        output.extend_from_slice(&DIGEST_SCHEMA.to_be_bytes());
        output.extend_from_slice(&WAL_SCHEMA.to_be_bytes());
        output.extend_from_slice(&BUILD_ID);
        output.extend_from_slice(&self.tx);
        output.extend_from_slice(&self.project_uuid);
        output.extend_from_slice(&self.nonce);
        output.extend_from_slice(&self.generation.to_be_bytes());
        output.extend_from_slice(&self.marker_digest);
        output.extend_from_slice(&self.root_path_digest);
        encode_stat(&mut output, &self.project_parent);
        encode_stat(&mut output, &self.project_root);
        encode_bytes_u16(&mut output, &self.project_leaf);
        encode_bytes_u16(&mut output, &self.active_name);
        encode_bytes_u16(&mut output, &self.stage_name);
        encode_stat(&mut output, &self.active.identity);
        output.extend_from_slice(&self.active.digest);
        encode_stat(&mut output, &self.stage.identity);
        output.extend_from_slice(&self.stage.digest);
        output
    }

    fn decode(bytes: &[u8]) -> Result<Self> {
        let mut cursor = ByteCursor::new(bytes);
        if cursor.take(b"CCSW-BINDING-V2\0".len())? != b"CCSW-BINDING-V2\0" {
            return fail(ErrorCode::Wal, "WAL binding domain mismatch");
        }
        if cursor.u16()? != PROTOCOL_SCHEMA
            || cursor.u16()? != DIGEST_SCHEMA
            || cursor.u16()? != WAL_SCHEMA
        {
            return fail(ErrorCode::Wal, "WAL schema mismatch");
        }
        let build = cursor.array::<32>()?;
        if !constant_time_eq(&build, &BUILD_ID) {
            return fail(ErrorCode::Wal, "WAL build mismatch");
        }
        let tx = cursor.array::<16>()?;
        let project_uuid = cursor.array::<16>()?;
        let nonce = cursor.array::<32>()?;
        let generation = cursor.u64()?;
        let marker_digest = cursor.array::<32>()?;
        let root_path_digest = cursor.array::<32>()?;
        let project_parent = decode_stat(&mut cursor)?;
        let project_root = decode_stat(&mut cursor)?;
        let project_leaf = cursor.bytes_u16(255)?;
        let active_name = cursor.bytes_u16(255)?;
        let stage_name = cursor.bytes_u16(255)?;
        validate_component(&project_leaf)?;
        validate_component(&active_name)?;
        validate_component(&stage_name)?;
        let active = BoundTree {
            identity: decode_stat(&mut cursor)?,
            digest: cursor.array::<32>()?,
        };
        let stage = BoundTree {
            identity: decode_stat(&mut cursor)?,
            digest: cursor.array::<32>()?,
        };
        cursor.finish()?;
        if active_name != ACTIVE_NAME || stage_name != stage_name_for(&tx) {
            return fail(ErrorCode::Wal, "WAL name binding mismatch");
        }
        if tx.iter().all(|byte| *byte == 0)
            || project_uuid.iter().all(|byte| *byte == 0)
            || nonce.iter().all(|byte| *byte == 0)
        {
            return fail(ErrorCode::Wal, "WAL binding contains zero identifier");
        }
        Ok(Self {
            tx,
            project_uuid,
            nonce,
            generation,
            marker_digest,
            root_path_digest,
            project_parent,
            project_root,
            project_leaf,
            active_name,
            stage_name,
            active,
            stage,
        })
    }

    fn binding_hash(&self) -> [u8; 32] {
        hash(&self.encode())
    }
}

fn encode_bytes_u16(output: &mut Vec<u8>, bytes: &[u8]) {
    output.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    output.extend_from_slice(bytes);
}

fn encode_stat(output: &mut Vec<u8>, stat: &RawStat) {
    output.extend_from_slice(&stat.dev.to_be_bytes());
    output.extend_from_slice(&stat.ino.to_be_bytes());
    output.extend_from_slice(&stat.nlink.to_be_bytes());
    output.extend_from_slice(&stat.size.to_be_bytes());
    output.extend_from_slice(&stat.mode.to_be_bytes());
    output.extend_from_slice(&stat.uid.to_be_bytes());
    output.extend_from_slice(&stat.gid.to_be_bytes());
    output.extend_from_slice(&stat.generation.to_be_bytes());
    output.extend_from_slice(&stat.mtime_sec.to_be_bytes());
    output.extend_from_slice(&stat.mtime_nsec.to_be_bytes());
    output.extend_from_slice(&stat.ctime_sec.to_be_bytes());
    output.extend_from_slice(&stat.ctime_nsec.to_be_bytes());
}

fn decode_stat(cursor: &mut ByteCursor<'_>) -> Result<RawStat> {
    Ok(RawStat {
        dev: cursor.u64()?,
        ino: cursor.u64()?,
        nlink: cursor.u64()?,
        size: cursor.u64()?,
        mode: cursor.u32()?,
        uid: cursor.u32()?,
        gid: cursor.u32()?,
        generation: cursor.u32()?,
        mtime_sec: cursor.i64()?,
        mtime_nsec: cursor.i64()?,
        ctime_sec: cursor.i64()?,
        ctime_nsec: cursor.i64()?,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
enum Phase {
    Prepared = 1,
    Swapped = 2,
    Committed = 3,
}

struct Wal {
    file: File,
    name: Vec<u8>,
    identity: RawStat,
    binding: Binding,
    binding_hash: [u8; 32],
    phase: Option<Phase>,
    chain_head: [u8; 32],
}

impl Wal {
    fn create(directory: &File, name: &[u8], binding: Binding, root: &RawStat) -> Result<Self> {
        let file = create_wal_at(directory, name)?;
        validate_wal_file(&file, root, true)?;
        let identity = stat_fd(&file)?;
        verify_named_identity(directory, name, &identity)?;
        let binding_hash = binding.binding_hash();
        let mut wal = Self {
            file,
            name: name.to_vec(),
            identity,
            binding,
            binding_hash,
            phase: None,
            chain_head: [0; 32],
        };
        wal.append(Phase::Prepared, directory)?;
        Ok(wal)
    }

    fn open(directory: &File, name: &[u8], root: &RawStat) -> Result<Self> {
        let by_name = stat_at(directory, name)?;
        let mut file = open_wal_at(directory, name)?;
        validate_wal_file(&file, root, false)?;
        let before = stat_fd(&file)?;
        if !stable_stat(&by_name, &before) {
            return fail(ErrorCode::Conflict, "WAL identity changed before open");
        }
        if before.size == 0 || before.size > MAX_WAL_BYTES {
            return fail(ErrorCode::Wal, "WAL size rejected");
        }
        file.seek(SeekFrom::Start(0)).map_err(|_| Failure {
            code: ErrorCode::Io,
            message: "WAL seek failed",
        })?;
        let mut bytes = Vec::with_capacity(before.size as usize);
        file.read_to_end(&mut bytes).map_err(|_| Failure {
            code: ErrorCode::Io,
            message: "WAL read failed",
        })?;
        let after = stat_fd(&file)?;
        if !stable_stat(&before, &after) {
            return fail(ErrorCode::Conflict, "WAL changed during read");
        }
        let parsed = parse_wal(&bytes)?;
        file.seek(SeekFrom::End(0)).map_err(|_| Failure {
            code: ErrorCode::Io,
            message: "WAL seek failed",
        })?;
        Ok(Self {
            file,
            name: name.to_vec(),
            identity: after,
            binding_hash: parsed.binding.binding_hash(),
            binding: parsed.binding,
            phase: Some(parsed.phase),
            chain_head: parsed.chain_head,
        })
    }

    fn append(&mut self, phase: Phase, directory: &File) -> Result<()> {
        self.verify_named(directory)?;
        let valid_transition = matches!(
            (self.phase, phase),
            (None, Phase::Prepared)
                | (Some(Phase::Prepared), Phase::Swapped)
                | (Some(Phase::Swapped), Phase::Committed)
        );
        if !valid_transition {
            return fail(ErrorCode::Wal, "invalid WAL phase transition");
        }
        let payload = match phase {
            Phase::Prepared => {
                let binding = self.binding.encode();
                let mut value = Vec::with_capacity(5 + binding.len());
                value.push(phase as u8);
                value.extend_from_slice(&(binding.len() as u32).to_be_bytes());
                value.extend_from_slice(&binding);
                value
            }
            Phase::Swapped | Phase::Committed => {
                let mut value = Vec::with_capacity(33);
                value.push(phase as u8);
                value.extend_from_slice(&self.binding_hash);
                value
            }
        };
        let crc = crc32(&payload);
        let length = u32::try_from(payload.len()).map_err(|_| Failure {
            code: ErrorCode::Wal,
            message: "WAL record too large",
        })?;
        let record_hash = wal_record_hash(&self.chain_head, length, crc, &payload);
        let mut record = Vec::with_capacity(4 + 4 + 32 + payload.len() + 32);
        record.extend_from_slice(&length.to_be_bytes());
        record.extend_from_slice(&crc.to_be_bytes());
        record.extend_from_slice(&self.chain_head);
        record.extend_from_slice(&payload);
        record.extend_from_slice(&record_hash);
        let durable_identity = (|| -> Result<RawStat> {
            self.file.write_all(&record).map_err(|_| Failure {
                code: ErrorCode::Io,
                message: "WAL append failed",
            })?;
            sync_regular(&self.file)?;
            sync_directory(directory)?;
            let identity = stat_fd(&self.file)?;
            let current = stat_at(directory, &self.name)?;
            if !same_wal_identity(&current, &identity) {
                return fail(ErrorCode::Conflict, "WAL name no longer binds the held file");
            }
            Ok(identity)
        })()
        .map_err(|_| Failure {
            code: ErrorCode::RecoveryRequired,
            message: "WAL append began; retained state requires explicit recovery",
        })?;
        self.identity = durable_identity;
        self.phase = Some(phase);
        self.chain_head = record_hash;
        Ok(())
    }

    fn verify_named(&self, directory: &File) -> Result<()> {
        let current = stat_at(directory, &self.name)?;
        if same_wal_identity(&current, &self.identity) {
            Ok(())
        } else {
            fail(ErrorCode::Conflict, "WAL name no longer binds the held file")
        }
    }
}

struct ParsedWal {
    binding: Binding,
    phase: Phase,
    chain_head: [u8; 32],
}

fn parse_wal(bytes: &[u8]) -> Result<ParsedWal> {
    parse_wal_inner(bytes).map_err(|error| Failure {
        code: ErrorCode::Wal,
        message: error.message,
    })
}

fn parse_wal_inner(bytes: &[u8]) -> Result<ParsedWal> {
    let mut cursor = ByteCursor::new(bytes);
    let mut expected_previous = [0u8; 32];
    let mut binding: Option<Binding> = None;
    let mut phase: Option<Phase> = None;
    let mut records = 0usize;
    while cursor.remaining() != 0 {
        records += 1;
        if records > 3 {
            return fail(ErrorCode::Wal, "too many WAL records");
        }
        let length = cursor.u32()? as usize;
        if length == 0 || length > MAX_FRAME {
            return fail(ErrorCode::Wal, "WAL record length rejected");
        }
        let crc = cursor.u32()?;
        let previous = cursor.array::<32>()?;
        if !constant_time_eq(&previous, &expected_previous) {
            return fail(ErrorCode::Wal, "WAL hash chain predecessor mismatch");
        }
        let payload = cursor.take(length)?;
        let stored_hash = cursor.array::<32>()?;
        if crc32(payload) != crc {
            return fail(ErrorCode::Wal, "WAL checksum mismatch");
        }
        let calculated = wal_record_hash(&previous, length as u32, crc, payload);
        if !constant_time_eq(&stored_hash, &calculated) {
            return fail(ErrorCode::Wal, "WAL hash chain mismatch");
        }
        expected_previous = stored_hash;

        let mut payload_cursor = ByteCursor::new(payload);
        let record_phase = match payload_cursor.u8()? {
            1 => Phase::Prepared,
            2 => Phase::Swapped,
            3 => Phase::Committed,
            _ => return fail(ErrorCode::Wal, "unknown WAL phase"),
        };
        match record_phase {
            Phase::Prepared => {
                if phase.is_some() {
                    return fail(ErrorCode::Wal, "duplicate PREPARED record");
                }
                let binding_len = payload_cursor.u32()? as usize;
                let decoded = Binding::decode(payload_cursor.take(binding_len)?)?;
                payload_cursor.finish()?;
                binding = Some(decoded);
            }
            Phase::Swapped | Phase::Committed => {
                let current = binding.as_ref().ok_or(Failure {
                    code: ErrorCode::Wal,
                    message: "WAL phase precedes PREPARED",
                })?;
                let binding_hash = payload_cursor.array::<32>()?;
                payload_cursor.finish()?;
                if !constant_time_eq(&binding_hash, &current.binding_hash()) {
                    return fail(ErrorCode::Wal, "WAL binding hash mismatch");
                }
            }
        }
        let transition = matches!(
            (phase, record_phase),
            (None, Phase::Prepared)
                | (Some(Phase::Prepared), Phase::Swapped)
                | (Some(Phase::Swapped), Phase::Committed)
        );
        if !transition {
            return fail(ErrorCode::Wal, "invalid WAL phase order");
        }
        phase = Some(record_phase);
    }
    Ok(ParsedWal {
        binding: binding.ok_or(Failure { code: ErrorCode::Wal, message: "WAL lacks PREPARED" })?,
        phase: phase.ok_or(Failure { code: ErrorCode::Wal, message: "empty WAL" })?,
        chain_head: expected_previous,
    })
}

fn wal_record_hash(previous: &[u8; 32], length: u32, crc: u32, payload: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"CCSW-WAL-RECORD-V1\0");
    hasher.update(previous);
    hasher.update(&length.to_be_bytes());
    hasher.update(&crc.to_be_bytes());
    hasher.update(payload);
    hasher.finalize()
}

fn validate_wal_file(file: &File, root: &RawStat, must_be_empty: bool) -> Result<()> {
    let stat = stat_fd(file)?;
    require_regular(&stat)?;
    require_tree_object(&stat, root.dev, root.uid)?;
    require_plain_security(file)?;
    if must_be_empty && stat.size != 0 {
        return fail(ErrorCode::Conflict, "new WAL was not empty");
    }
    if stat.size > MAX_WAL_BYTES {
        return fail(ErrorCode::Limit, "WAL cap exceeded");
    }
    Ok(())
}

struct ByteCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> ByteCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.offset)
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8]> {
        let end = self.offset.checked_add(length).ok_or(Failure {
            code: ErrorCode::Protocol,
            message: "frame offset overflow",
        })?;
        if end > self.bytes.len() {
            return fail(ErrorCode::Protocol, "truncated frame");
        }
        let output = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(output)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N]> {
        self.take(N)?.try_into().map_err(|_| Failure {
            code: ErrorCode::Protocol,
            message: "invalid fixed-width field",
        })
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_be_bytes(self.array()?))
    }

    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(self.array()?))
    }

    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_be_bytes(self.array()?))
    }

    fn i64(&mut self) -> Result<i64> {
        Ok(i64::from_be_bytes(self.array()?))
    }

    fn bytes_u16(&mut self, maximum: usize) -> Result<Vec<u8>> {
        let length = self.u16()? as usize;
        if length > maximum {
            return fail(ErrorCode::Protocol, "length-prefixed field too large");
        }
        Ok(self.take(length)?.to_vec())
    }

    fn finish(&self) -> Result<()> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            fail(ErrorCode::Protocol, "trailing frame data")
        }
    }
}

struct LockGuard {
    file: File,
    locked: bool,
}

impl LockGuard {
    fn acquire(file: File) -> Result<Self> {
        // SAFETY: file is an open, validated regular file and remains owned here.
        let rc = unsafe { ss_lock_exclusive(file.as_raw_fd()) };
        if rc == 1 {
            return fail(ErrorCode::Conflict, "writer lock is busy");
        }
        ffi_ok(rc, "writer lock acquisition failed")?;
        Ok(Self { file, locked: true })
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        if self.locked {
            // SAFETY: file remains open until after this Drop implementation.
            let _ = unsafe { ss_unlock(self.file.as_raw_fd()) };
            self.locked = false;
        }
    }
}

struct StableContext {
    root_path: Vec<u8>,
    root_path_digest: [u8; 32],
    parent: File,
    parent_stat: RawStat,
    root_leaf: Vec<u8>,
    root: File,
    root_stat: RawStat,
    control: File,
    wal_directory: File,
    lock: LockGuard,
}

impl StableContext {
    fn acquire(path: &[u8]) -> Result<Self> {
        let (parent_path, root_leaf) = split_project_root(path)?;
        let parent = open_absolute_directory(&parent_path)?;
        let parent_stat = stat_fd(&parent)?;
        require_directory(&parent_stat)?;
        if parent_stat.mode & GROUP_OR_WORLD_WRITE != 0 {
            return fail(ErrorCode::UnsafeObject, "project parent is group/world writable");
        }
        require_plain_security(&parent)?;
        let root = open_project_root(path)?;
        let root_stat = stat_fd(&root)?;
        if parent_stat.dev != root_stat.dev {
            return fail(ErrorCode::UnsafeObject, "project root mount boundary rejected");
        }
        verify_named_identity(&parent, &root_leaf, &root_stat)?;
        let capabilities = volume_capabilities(&root)?;
        if capabilities & (CAP_SWAP | CAP_FLOCK) != (CAP_SWAP | CAP_FLOCK) {
            return fail(ErrorCode::Capability, "volume lacks required swap/flock capability");
        }

        let control = open_dir_at(&root, CONTROL_NAME)?;
        let control_stat = validate_stable_directory(&control, &root_stat)?;
        let wal_directory = open_dir_at(&control, WAL_DIRECTORY_NAME)?;
        let wal_stat = validate_stable_directory(&wal_directory, &root_stat)?;
        let lock_file = open_lock_at(&control, LOCK_NAME)?;
        let lock_stat = validate_stable_lock(&lock_file, &root_stat)?;
        let lock = LockGuard::acquire(lock_file)?;

        /*
         * The stable lock is now held. The pre-lock metadata checks are not an
         * authorization boundary: a preceding cooperative writer could have
         * changed ACLs or xattrs before releasing the lock. Re-check the full
         * plain-security contract, then re-bind every stable name to the held
         * descriptor before resolving either active or stage.
         */
        require_plain_security(&parent)?;
        require_plain_security(&root)?;
        require_plain_security(&control)?;
        require_plain_security(&wal_directory)?;
        require_plain_security(&lock.file)?;
        if !same_bound_root(&parent_stat, &stat_fd(&parent)?)
            || !same_bound_root(&root_stat, &stat_fd(&root)?)
            || !same_identity(&control_stat, &stat_fd(&control)?)
            || !same_identity(&wal_stat, &stat_fd(&wal_directory)?)
            || !same_identity(&lock_stat, &stat_fd(&lock.file)?)
        {
            return fail(
                ErrorCode::Conflict,
                "stable metadata changed while acquiring writer lock",
            );
        }
        verify_named_identity(&root, CONTROL_NAME, &control_stat)?;
        verify_named_identity(&control, WAL_DIRECTORY_NAME, &wal_stat)?;
        verify_named_identity(&control, LOCK_NAME, &lock_stat)?;
        let context = Self {
            root_path: path.to_vec(),
            root_path_digest: project_root_path_digest(path),
            parent,
            parent_stat,
            root_leaf,
            root,
            root_stat,
            control,
            wal_directory,
            lock,
        };
        context.verify_project_root_binding()?;
        Ok(context)
    }

    fn verify_project_root_binding(&self) -> Result<()> {
        let current_parent = stat_fd(&self.parent)?;
        if !same_bound_root(&self.parent_stat, &current_parent) {
            return fail(ErrorCode::Conflict, "project parent identity changed");
        }
        verify_named_identity(&self.parent, &self.root_leaf, &self.root_stat)?;
        let reopened = open_project_root(&self.root_path)?;
        let reopened_stat = stat_fd(&reopened)?;
        if !same_identity(&self.root_stat, &reopened_stat) {
            return fail(ErrorCode::Conflict, "project root path no longer binds the held root");
        }
        Ok(())
    }
}

fn validate_stable_directory(file: &File, root: &RawStat) -> Result<RawStat> {
    let stat = stat_fd(file)?;
    require_directory(&stat)?;
    require_tree_object(&stat, root.dev, root.uid)?;
    require_plain_security(file)?;
    Ok(stat)
}

fn validate_stable_lock(file: &File, root: &RawStat) -> Result<RawStat> {
    let stat = stat_fd(file)?;
    require_regular(&stat)?;
    require_tree_object(&stat, root.dev, root.uid)?;
    require_plain_security(file)?;
    Ok(stat)
}

fn verify_named_identity(parent: &File, name: &[u8], expected: &RawStat) -> Result<()> {
    let current = stat_at(parent, name)?;
    if same_identity(&current, expected) {
        Ok(())
    } else {
        fail(ErrorCode::Conflict, "held descriptor no longer matches stable name")
    }
}

fn stage_name_for(tx: &[u8; 16]) -> Vec<u8> {
    let mut output = b".creatorcut-swap-".to_vec();
    append_hex(&mut output, tx);
    output
}

fn wal_name_for(tx: &[u8; 16]) -> Vec<u8> {
    let mut output = Vec::with_capacity(36);
    append_hex(&mut output, tx);
    output.extend_from_slice(b".wal");
    output
}

fn append_hex(output: &mut Vec<u8>, bytes: &[u8]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize]);
        output.push(HEX[(byte & 0x0f) as usize]);
    }
}

struct HeldTree {
    file: File,
    digest: TreeDigest,
}

fn open_and_digest_tree(
    context: &StableContext,
    name: &[u8],
    policy: TreePolicy,
) -> Result<HeldTree> {
    let by_name = stat_at(&context.root, name)?;
    let file = open_dir_at(&context.root, name)?;
    let opened = stat_fd(&file)?;
    if !stable_stat(&by_name, &opened) {
        return fail(ErrorCode::Conflict, "tree identity changed before open");
    }
    let digest = digest_tree(
        &file,
        policy,
        context.root_stat.dev,
        context.root_stat.uid,
    )?;
    if !same_identity(&opened, &digest.identity) {
        return fail(ErrorCode::Conflict, "tree changed before digest completed");
    }
    Ok(HeldTree { file, digest })
}

fn verify_held_tree(
    context: &StableContext,
    name: &[u8],
    held: &HeldTree,
    policy: TreePolicy,
) -> Result<()> {
    verify_named_identity(&context.root, name, &held.digest.identity)?;
    let repeated = digest_tree(
        &held.file,
        policy,
        context.root_stat.dev,
        context.root_stat.uid,
    )?;
    if held.digest.matches(&repeated) {
        Ok(())
    } else {
        fail(ErrorCode::Conflict, "tree changed after PREPARED")
    }
}

fn tree_matches_bound(tree: &TreeDigest, bound: &BoundTree) -> bool {
    same_identity(&tree.identity, &bound.identity)
        && constant_time_eq(&tree.digest, &bound.digest)
}

fn verify_post_mapping(context: &StableContext, binding: &Binding) -> Result<()> {
    let active = open_and_digest_tree(context, &binding.active_name, TreePolicy::PublicStage)?;
    let quarantine = open_and_digest_tree(context, &binding.stage_name, TreePolicy::ActiveOpaque)?;
    if !tree_matches_bound(&active.digest, &binding.stage)
        || !tree_matches_bound(&quarantine.digest, &binding.active)
        || active.digest.marker_digest != Some(binding.marker_digest)
    {
        return fail(ErrorCode::Conflict, "post-swap mapping mismatch; all state retained");
    }
    Ok(())
}

fn perform_forward_swap(
    context: &StableContext,
    binding: &Binding,
    wal: &mut Wal,
    active: &HeldTree,
    stage: &HeldTree,
    barrier_mask: u32,
) -> Result<()> {
    if wal.phase != Some(Phase::Prepared) {
        return fail(ErrorCode::Wal, "forward swap requires PREPARED WAL");
    }
    /*
     * A durable PREPARED already occupies the transaction namespace. Every
     * failure from this point requires explicit forward recovery, even when
     * the atomic swap has not happened yet; a fresh SWAP_FORWARD retry cannot
     * safely recreate or replace the WAL.
     */
    let completion = (|| -> Result<()> {
        synthetic_barrier(barrier_mask, BARRIER_AFTER_PREPARED, &binding.tx)?;
        context.verify_project_root_binding()?;

        /* No blocking hook may separate these final bindings from the swap syscall. */
        wal.verify_named(&context.wal_directory)?;
        verify_held_tree(context, &binding.active_name, active, TreePolicy::ActiveOpaque)?;
        verify_held_tree(context, &binding.stage_name, stage, TreePolicy::PublicStage)?;
        if !tree_matches_bound(&active.digest, &binding.active)
            || !tree_matches_bound(&stage.digest, &binding.stage)
        {
            return fail(ErrorCode::Conflict, "pre-swap mapping mismatch; all state retained");
        }

        // SAFETY: both names are bound immediately above beneath the held root FD.
        let rc = unsafe {
            ss_swap_at(
                context.root.as_raw_fd(),
                binding.active_name.as_ptr(),
                binding.active_name.len(),
                binding.stage_name.as_ptr(),
                binding.stage_name.len(),
            )
        };
        ffi_ok(rc, "atomic tree swap failed")?;
        synthetic_barrier(barrier_mask, BARRIER_AFTER_SWAP_SYSCALL, &binding.tx)?;
        context.verify_project_root_binding()?;

        sync_directory(&context.root)?;
        synthetic_barrier(barrier_mask, BARRIER_AFTER_ROOT_SYNC, &binding.tx)?;
        context.verify_project_root_binding()?;
        verify_post_mapping(context, binding)?;

        wal.append(Phase::Swapped, &context.wal_directory)?;
        synthetic_barrier(barrier_mask, BARRIER_AFTER_SWAPPED, &binding.tx)?;
        context.verify_project_root_binding()?;
        wal.append(Phase::Committed, &context.wal_directory)?;
        synthetic_barrier(barrier_mask, BARRIER_AFTER_COMMITTED, &binding.tx)?;
        context.verify_project_root_binding()?;
        Ok(())
    })();
    completion.map_err(|_| Failure {
        code: ErrorCode::RecoveryRequired,
        message: "durable PREPARED exists; explicit forward recovery required",
    })
}

fn swap_forward(request: SwapRequest) -> Result<Vec<u8>> {
    validate_identifiers(&request.tx, &request.project_uuid, &request.nonce)?;
    validate_barrier_mask(request.barrier_mask)?;
    let context = StableContext::acquire(&request.root)?;
    let stage_name = stage_name_for(&request.tx);
    validate_component(&stage_name)?;
    let wal_name = wal_name_for(&request.tx);
    validate_component(&wal_name)?;
    require_single_stage_namespace(&context, &stage_name)?;
    require_wal_directory_state(&context.wal_directory, None)?;

    /* The stable flock is held before either active name is resolved. */
    let active = open_and_digest_tree(&context, ACTIVE_NAME, TreePolicy::ActiveOpaque)?;
    let stage = open_and_digest_tree(&context, &stage_name, TreePolicy::PublicStage)?;
    if stage.digest.marker_digest != Some(request.marker_digest) {
        return fail(ErrorCode::Conflict, "stage marker digest mismatch");
    }
    /* The stage contents and its project-root directory entry precede PREPARED. */
    sync_directory(&context.root)?;
    let binding = Binding {
        tx: request.tx,
        project_uuid: request.project_uuid,
        nonce: request.nonce,
        generation: request.generation,
        marker_digest: request.marker_digest,
        root_path_digest: context.root_path_digest,
        project_parent: context.parent_stat,
        project_root: context.root_stat,
        project_leaf: context.root_leaf.clone(),
        active_name: ACTIVE_NAME.to_vec(),
        stage_name,
        active: BoundTree::from(&active.digest),
        stage: BoundTree::from(&stage.digest),
    };

    /* First persistent side effect: a unique WAL with a durable PREPARED. */
    context.verify_project_root_binding()?;
    let mut wal = Wal::create(&context.wal_directory, &wal_name, binding.clone(), &context.root_stat)?;
    perform_forward_swap(
        &context,
        &binding,
        &mut wal,
        &active,
        &stage,
        request.barrier_mask,
    )?;

    let mut response = Vec::with_capacity(16 + 8 + 64);
    response.extend_from_slice(&binding.tx);
    response.extend_from_slice(&binding.generation.to_be_bytes());
    response.extend_from_slice(&binding.active.digest);
    response.extend_from_slice(&binding.stage.digest);
    /* wal drops before context; no writable transaction FD survives lock release. */
    drop(wal);
    drop(active);
    drop(stage);
    drop(context);
    Ok(response)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mapping {
    Pre,
    Post,
}

fn classify_mapping(context: &StableContext, binding: &Binding) -> Result<Mapping> {
    let active = stat_at(&context.root, &binding.active_name)?;
    let stage = stat_at(&context.root, &binding.stage_name)?;
    let pre = same_identity(&active, &binding.active.identity)
        && same_identity(&stage, &binding.stage.identity);
    let post = same_identity(&active, &binding.stage.identity)
        && same_identity(&stage, &binding.active.identity);
    match (pre, post) {
        (true, false) => Ok(Mapping::Pre),
        (false, true) => Ok(Mapping::Post),
        _ => fail(ErrorCode::Conflict, "recovery mapping mismatch; all state retained"),
    }
}

fn recover_forward(request: RecoverRequest) -> Result<Vec<u8>> {
    if request.tx.iter().all(|byte| *byte == 0) {
        return fail(ErrorCode::InvalidRequest, "zero transaction id rejected");
    }
    validate_barrier_mask(request.barrier_mask)?;
    let context = StableContext::acquire(&request.root)?;
    let wal_name = wal_name_for(&request.tx);
    let stage_name = stage_name_for(&request.tx);
    require_single_stage_namespace(&context, &stage_name)?;
    require_wal_directory_state(&context.wal_directory, Some(&wal_name))?;
    let mut wal = Wal::open(&context.wal_directory, &wal_name, &context.root_stat)?;
    let binding = wal.binding.clone();
    if binding.tx != request.tx
        || !same_bound_root(&binding.project_parent, &context.parent_stat)
        || !same_bound_root(&binding.project_root, &context.root_stat)
        || binding.project_leaf != context.root_leaf
        || !constant_time_eq(&binding.root_path_digest, &context.root_path_digest)
    {
        return fail(ErrorCode::Conflict, "recovery binding mismatch; all state retained");
    }
    context.verify_project_root_binding()?;

    let mapping = classify_mapping(&context, &binding)?;
    match (wal.phase, mapping) {
        (Some(Phase::Prepared), Mapping::Pre) => {
            let active = open_and_digest_tree(
                &context,
                &binding.active_name,
                TreePolicy::ActiveOpaque,
            )?;
            let stage = open_and_digest_tree(
                &context,
                &binding.stage_name,
                TreePolicy::PublicStage,
            )?;
            if !tree_matches_bound(&active.digest, &binding.active)
                || !tree_matches_bound(&stage.digest, &binding.stage)
                || stage.digest.marker_digest != Some(binding.marker_digest)
            {
                return fail(ErrorCode::Conflict, "recovery pre-image mismatch; all state retained");
            }
            perform_forward_swap(
                &context,
                &binding,
                &mut wal,
                &active,
                &stage,
                request.barrier_mask,
            )?;
        }
        (Some(Phase::Prepared), Mapping::Post) => {
            verify_post_mapping(&context, &binding)?;
            sync_directory(&context.root)?;
            synthetic_barrier(request.barrier_mask, BARRIER_AFTER_ROOT_SYNC, &binding.tx)?;
            context.verify_project_root_binding()?;
            wal.append(Phase::Swapped, &context.wal_directory)?;
            synthetic_barrier(request.barrier_mask, BARRIER_AFTER_SWAPPED, &binding.tx)?;
            context.verify_project_root_binding()?;
            wal.append(Phase::Committed, &context.wal_directory)?;
            synthetic_barrier(request.barrier_mask, BARRIER_AFTER_COMMITTED, &binding.tx)?;
            context.verify_project_root_binding()?;
        }
        (Some(Phase::Swapped), Mapping::Post) => {
            verify_post_mapping(&context, &binding)?;
            wal.append(Phase::Committed, &context.wal_directory)?;
            synthetic_barrier(request.barrier_mask, BARRIER_AFTER_COMMITTED, &binding.tx)?;
            context.verify_project_root_binding()?;
        }
        (Some(Phase::Committed), Mapping::Post) => {
            verify_post_mapping(&context, &binding)?;
        }
        _ => return fail(ErrorCode::Conflict, "WAL/mapping mismatch; all state retained"),
    }

    let mut response = Vec::with_capacity(24);
    response.extend_from_slice(&binding.tx);
    response.extend_from_slice(&binding.generation.to_be_bytes());
    drop(wal);
    drop(context);
    Ok(response)
}

fn require_single_stage_namespace(context: &StableContext, expected: &[u8]) -> Result<()> {
    let mut found_expected = false;
    let mut reader = DirectoryReader::open(&context.root)?;
    while let Some(name) = reader.next()? {
        if name == b"." || name == b".." {
            continue;
        }
        validate_component(&name)?;
        if name.starts_with(b".creatorcut-swap-") {
            if name != expected || found_expected {
                return fail(ErrorCode::Conflict, "ambiguous stage namespace; all state retained");
            }
            found_expected = true;
        }
    }
    if !found_expected {
        return fail(ErrorCode::Conflict, "bound stage is missing");
    }
    Ok(())
}

fn require_wal_directory_state(directory: &File, expected: Option<&[u8]>) -> Result<()> {
    let names = sorted_names(directory)?;
    match expected {
        None if names.is_empty() => Ok(()),
        Some(name) if names.len() == 1 && names[0] == name => Ok(()),
        _ => fail(ErrorCode::Conflict, "ambiguous WAL namespace; all state retained"),
    }
}

fn validate_identifiers(tx: &[u8; 16], project: &[u8; 16], nonce: &[u8; 32]) -> Result<()> {
    if tx.iter().all(|byte| *byte == 0)
        || project.iter().all(|byte| *byte == 0)
        || nonce.iter().all(|byte| *byte == 0)
    {
        fail(ErrorCode::InvalidRequest, "zero identifier rejected")
    } else {
        Ok(())
    }
}

fn validate_barrier_mask(mask: u32) -> Result<()> {
    if mask & !BARRIER_ALL != 0 {
        return fail(ErrorCode::InvalidRequest, "unknown synthetic barrier bit");
    }
    #[cfg(not(secure_swap_synthetic))]
    if mask != 0 {
        return fail(ErrorCode::Unsupported, "synthetic barriers disabled in this build");
    }
    Ok(())
}

#[cfg(secure_swap_synthetic)]
fn synthetic_barrier(mask: u32, point: u32, tx: &[u8; 16]) -> Result<()> {
    if mask & point == 0 {
        return Ok(());
    }
    // The descriptor number is a build-time test ABI. No path or environment
    // variable can enable or redirect this hook.
    let channel = unsafe { File::from_raw_fd(SYNTHETIC_BARRIER_FD) };
    let mut channel = ManuallyDrop::new(channel);
    let mut event = [0u8; 21];
    event[0] = 0x42;
    event[1..5].copy_from_slice(&point.to_be_bytes());
    event[5..].copy_from_slice(tx);
    channel.write_all(&event).map_err(|_| Failure {
        code: ErrorCode::Io,
        message: "synthetic barrier write failed",
    })?;
    let mut acknowledgement = [0u8; 5];
    channel.read_exact(&mut acknowledgement).map_err(|_| Failure {
        code: ErrorCode::Io,
        message: "synthetic barrier acknowledgement failed",
    })?;
    if acknowledgement[0] != 0x41 || acknowledgement[1..] != point.to_be_bytes() {
        return fail(ErrorCode::Protocol, "synthetic barrier acknowledgement mismatch");
    }
    Ok(())
}

#[cfg(not(secure_swap_synthetic))]
fn synthetic_barrier(_mask: u32, _point: u32, _tx: &[u8; 16]) -> Result<()> {
    Ok(())
}

struct SwapRequest {
    tx: [u8; 16],
    project_uuid: [u8; 16],
    nonce: [u8; 32],
    marker_digest: [u8; 32],
    generation: u64,
    barrier_mask: u32,
    root: Vec<u8>,
}

struct RecoverRequest {
    tx: [u8; 16],
    barrier_mask: u32,
    root: Vec<u8>,
}

fn parse_header(frame: &[u8]) -> Result<(u8, ByteCursor<'_>)> {
    let mut cursor = ByteCursor::new(frame);
    if cursor.take(MAGIC.len())? != MAGIC {
        return fail(ErrorCode::Protocol, "protocol magic mismatch");
    }
    if cursor.u16()? != PROTOCOL_SCHEMA {
        return fail(ErrorCode::Protocol, "protocol schema mismatch");
    }
    let opcode = cursor.u8()?;
    if cursor.u8()? != 0 {
        return fail(ErrorCode::Protocol, "protocol flags must be zero");
    }
    Ok((opcode, cursor))
}

fn parse_swap(mut cursor: ByteCursor<'_>, session: &[u8; 32]) -> Result<SwapRequest> {
    verify_session(&mut cursor, session)?;
    let request = SwapRequest {
        tx: cursor.array::<16>()?,
        project_uuid: cursor.array::<16>()?,
        nonce: cursor.array::<32>()?,
        marker_digest: cursor.array::<32>()?,
        generation: cursor.u64()?,
        barrier_mask: cursor.u32()?,
        root: cursor.bytes_u16(MAX_ROOT_PATH)?,
    };
    cursor.finish()?;
    Ok(request)
}

fn parse_recover(mut cursor: ByteCursor<'_>, session: &[u8; 32]) -> Result<RecoverRequest> {
    verify_session(&mut cursor, session)?;
    let request = RecoverRequest {
        tx: cursor.array::<16>()?,
        barrier_mask: cursor.u32()?,
        root: cursor.bytes_u16(MAX_ROOT_PATH)?,
    };
    cursor.finish()?;
    Ok(request)
}

fn verify_session(cursor: &mut ByteCursor<'_>, expected: &[u8; 32]) -> Result<()> {
    let received = cursor.array::<32>()?;
    if constant_time_eq(&received, expected) {
        Ok(())
    } else {
        fail(ErrorCode::Protocol, "PROBE session mismatch")
    }
}

fn probe_session(challenge: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"CCSW-PROBE-SESSION-V1\0");
    hasher.update(challenge);
    hasher.update(&BUILD_ID);
    hasher.update(&PROTOCOL_SCHEMA.to_be_bytes());
    hasher.finalize()
}

fn capabilities_response(path: &[u8]) -> Result<Vec<u8>> {
    let root = open_project_root(path)?;
    let bits = volume_capabilities(&root)?;
    let mut output = Vec::with_capacity(40);
    output.extend_from_slice(&bits.to_be_bytes());
    output.extend_from_slice(&PROTOCOL_SCHEMA.to_be_bytes());
    output.extend_from_slice(&DIGEST_SCHEMA.to_be_bytes());
    output.extend_from_slice(&BUILD_ID);
    Ok(output)
}

fn read_frame<R: Read>(input: &mut R) -> Result<Vec<u8>> {
    let mut length_bytes = [0u8; 4];
    input.read_exact(&mut length_bytes).map_err(|_| Failure {
        code: ErrorCode::Protocol,
        message: "truncated frame length",
    })?;
    let length = u32::from_be_bytes(length_bytes) as usize;
    if !(8..=MAX_FRAME).contains(&length) {
        return fail(ErrorCode::Protocol, "frame length rejected");
    }
    let mut frame = vec![0u8; length];
    input.read_exact(&mut frame).map_err(|_| Failure {
        code: ErrorCode::Protocol,
        message: "truncated frame body",
    })?;
    Ok(frame)
}

fn write_response<W: Write>(
    output: &mut W,
    opcode: u8,
    result: &Result<Vec<u8>>,
) -> Result<()> {
    let mut body = Vec::new();
    body.extend_from_slice(MAGIC);
    body.extend_from_slice(&PROTOCOL_SCHEMA.to_be_bytes());
    body.push(opcode);
    body.push(0);
    match result {
        Ok(payload) => {
            body.extend_from_slice(&0u16.to_be_bytes());
            body.extend_from_slice(&0u16.to_be_bytes());
            body.extend_from_slice(payload);
        }
        Err(error) => {
            let message = error.message.as_bytes();
            body.extend_from_slice(&(error.code as u16).to_be_bytes());
            body.extend_from_slice(&(message.len() as u16).to_be_bytes());
            body.extend_from_slice(message);
        }
    }
    if body.len() > MAX_FRAME {
        return fail(ErrorCode::Internal, "response frame overflow");
    }
    output.write_all(&(body.len() as u32).to_be_bytes()).map_err(|_| Failure {
        code: ErrorCode::Io,
        message: "response write failed",
    })?;
    output.write_all(&body).map_err(|_| Failure {
        code: ErrorCode::Io,
        message: "response write failed",
    })?;
    output.flush().map_err(|_| Failure {
        code: ErrorCode::Io,
        message: "response flush failed",
    })?;
    Ok(())
}

fn serve<R: Read, W: Write>(input: &mut R, output: &mut W) -> bool {
    let probe_frame = match read_frame(input) {
        Ok(frame) => frame,
        Err(error) => {
            let result = Err(error);
            let _ = write_response(output, 0, &result);
            return false;
        }
    };
    let probe = (|| -> Result<([u8; 32], [u8; 32], Vec<u8>)> {
        let (opcode, mut cursor) = parse_header(&probe_frame)?;
        if opcode != OP_PROBE {
            return fail(ErrorCode::Protocol, "PROBE must be the first opcode");
        }
        let challenge = cursor.array::<32>()?;
        cursor.finish()?;
        if challenge.iter().all(|byte| *byte == 0) {
            return fail(ErrorCode::Protocol, "zero PROBE challenge rejected");
        }
        let session = probe_session(&challenge);
        let mut payload = Vec::with_capacity(100);
        payload.extend_from_slice(&challenge);
        payload.extend_from_slice(&session);
        payload.extend_from_slice(&BUILD_ID);
        payload.extend_from_slice(&DIGEST_SCHEMA.to_be_bytes());
        payload.extend_from_slice(&WAL_SCHEMA.to_be_bytes());
        Ok((challenge, session, payload))
    })();
    let session = match probe {
        Ok((_challenge, session, payload)) => {
            if write_response(output, OP_PROBE, &Ok(payload)).is_err() {
                return false;
            }
            session
        }
        Err(error) => {
            let result = Err(error);
            let _ = write_response(output, OP_PROBE, &result);
            return false;
        }
    };

    /* No root path or mutating request is accepted before the PROBE response. */
    let operation_frame = match read_frame(input) {
        Ok(frame) => frame,
        Err(error) => {
            let result = Err(error);
            let _ = write_response(output, 0, &result);
            return false;
        }
    };
    let (opcode, cursor) = match parse_header(&operation_frame) {
        Ok(parsed) => parsed,
        Err(error) => {
            let result = Err(error);
            let _ = write_response(output, 0, &result);
            return false;
        }
    };
    let result = match opcode {
        OP_CAPABILITIES => (|| {
            let mut cursor = cursor;
            verify_session(&mut cursor, &session)?;
            let root = cursor.bytes_u16(MAX_ROOT_PATH)?;
            cursor.finish()?;
            capabilities_response(&root)
        })(),
        OP_SWAP_FORWARD => {
            #[cfg(secure_swap_synthetic)]
            {
                parse_swap(cursor, &session).and_then(swap_forward)
            }
            #[cfg(not(secure_swap_synthetic))]
            {
                let _ = cursor;
                fail(
                    ErrorCode::Unsupported,
                    "mutating prototype opcodes require a synthetic build",
                )
            }
        }
        OP_RECOVER_FORWARD => {
            #[cfg(secure_swap_synthetic)]
            {
                parse_recover(cursor, &session).and_then(recover_forward)
            }
            #[cfg(not(secure_swap_synthetic))]
            {
                let _ = cursor;
                fail(
                    ErrorCode::Unsupported,
                    "mutating prototype opcodes require a synthetic build",
                )
            }
        }
        OP_PROBE => fail(ErrorCode::Protocol, "PROBE may occur only once"),
        _ => fail(ErrorCode::Protocol, "unknown opcode"),
    };
    let succeeded = result.is_ok();
    let response_written = write_response(output, opcode, &result).is_ok();
    succeeded && response_written
}

fn main() {
    std::panic::set_hook(Box::new(|_| {
        eprintln!("secure-swap-prototype: internal panic");
    }));
    /* The helper has no argument surface. In particular, roots never use argv. */
    if std::env::args_os().count() != 1 {
        let error: Result<Vec<u8>> = fail(ErrorCode::InvalidRequest, "arguments are not accepted");
        let _ = write_response(&mut io::stdout().lock(), 0, &error);
        std::process::exit(2);
    }
    let succeeded = serve(&mut io::stdin().lock(), &mut io::stdout().lock());
    if !succeeded {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::provenance_value_digest;

    #[test]
    fn provenance_digest_binds_presence_length_and_value() {
        let absent = provenance_value_digest(0, &[]);
        let present_empty = provenance_value_digest(1, &[]);
        let first = provenance_value_digest(1, b"host-provenance-a");
        let second = provenance_value_digest(1, b"host-provenance-b");

        assert_ne!(absent, present_empty);
        assert_ne!(present_empty, first);
        assert_ne!(first, second);
        assert_eq!(first, provenance_value_digest(1, b"host-provenance-a"));
    }
}
