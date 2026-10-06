use crate::error::{AppError, Result};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{OpenOptionsExt, PermissionsExt},
    },
    path::{Component, Path, PathBuf},
};

const IGNORED_DIRS: &[&str] = &[".git", "node_modules", ".shift", ".omx", "coverage"];
const SENSITIVE_DIRS: &[&str] = &[".ssh", ".aws", ".claude", ".codex", ".gnupg"];
const SENSITIVE_FILES: &[&str] = &[".npmrc", ".netrc", "id_rsa", "id_ed25519", "credentials"];

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub struct DirectoryTarget {
    parent: PathBuf,
    pub final_path: PathBuf,
    staging: PathBuf,
    committed: bool,
}
impl DirectoryTarget {
    pub fn new(output: &Path, roots: &[&Path]) -> Result<Self> {
        let name = output
            .file_name()
            .ok_or_else(|| AppError::new("output directory name required"))?;
        let parent_input = output
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let parent = fs::canonicalize(parent_input)
            .map_err(|error| AppError::new(format!("output parent must exist: {error}")))?;
        let final_path = parent.join(name);
        if final_path.exists() {
            return Err(AppError::new("output already exists"));
        }
        for root in roots {
            if final_path == *root || final_path.starts_with(root) {
                return Err(AppError::new("output must be outside protected inputs"));
            }
        }
        let staging = (0..100_u32)
            .find_map(|counter| {
                let path = parent.join(format!(
                    ".ctrl-shift-assess-{}-{counter}.tmp",
                    std::process::id()
                ));
                match fs::create_dir(&path) {
                    Ok(()) => Some(Ok(path)),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                    Err(error) => Some(Err(error)),
                }
            })
            .ok_or_else(|| AppError::new("cannot allocate staging directory"))??;
        fs::set_permissions(&staging, fs::Permissions::from_mode(0o700))?;
        Ok(Self {
            parent,
            final_path,
            staging,
            committed: false,
        })
    }
    pub fn write(&self, relative: &str, bytes: &[u8]) -> Result<()> {
        let rel = Path::new(relative);
        if rel.is_absolute()
            || rel
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(AppError::new("unsafe report path"));
        }
        let file = self.staging.join(rel);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)?;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(file)?;
        output.write_all(bytes)?;
        output.sync_all()?;
        Ok(())
    }
    pub fn commit(mut self) -> Result<PathBuf> {
        File::open(&self.staging)?.sync_all()?;
        #[cfg(target_os = "macos")]
        {
            use std::ffi::CString;
            let from = CString::new(self.staging.as_os_str().as_bytes())
                .map_err(|_| AppError::new("staging path contains NUL"))?;
            let to = CString::new(self.final_path.as_os_str().as_bytes())
                .map_err(|_| AppError::new("output path contains NUL"))?;
            // SAFETY: both C strings are valid and renamex_np performs an exclusive atomic directory rename.
            if unsafe { nix::libc::renamex_np(from.as_ptr(), to.as_ptr(), nix::libc::RENAME_EXCL) }
                != 0
            {
                return Err(AppError::new(format!(
                    "cannot commit assessment directory: {}",
                    std::io::Error::last_os_error()
                )));
            }
            if let Err(error) = File::open(&self.parent).and_then(|directory| directory.sync_all())
            {
                let _ = fs::remove_dir_all(&self.final_path);
                let _ = File::open(&self.parent).and_then(|directory| directory.sync_all());
                return Err(error.into());
            }
            self.committed = true;
            Ok(self.final_path.clone())
        }
        #[cfg(not(target_os = "macos"))]
        Err(AppError::new(
            "assessment publication is currently supported only on macOS",
        ))
    }
}
impl Drop for DirectoryTarget {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_dir_all(&self.staging);
        }
    }
}
pub fn sha256_bytes(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hex(&hash.finalize()))
}

fn sensitive_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    (lower == ".env" || lower.starts_with(".env."))
        || SENSITIVE_FILES.contains(&lower.as_str())
        || [".pem", ".key", ".p12", ".pfx"]
            .iter()
            .any(|suffix| lower.ends_with(suffix))
}

#[derive(Serialize)]
struct NodeRecord {
    file: String,
    sha256: String,
    bytes: u64,
}

fn collect(root: &Path) -> Result<(BTreeMap<String, String>, Vec<NodeRecord>)> {
    fn visit(
        root: &Path,
        current: &Path,
        out: &mut BTreeMap<String, String>,
        ordered: &mut Vec<NodeRecord>,
        total: &mut u64,
        depth: usize,
    ) -> Result<()> {
        if depth > 128 {
            return Err(AppError::new("snapshot directory depth exceeds 128"));
        }
        let mut entries = fs::read_dir(current)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by(|left, right| {
            let left = left
                .file_name()
                .to_string_lossy()
                .encode_utf16()
                .collect::<Vec<_>>();
            let right = right
                .file_name()
                .to_string_lossy()
                .encode_utf16()
                .collect::<Vec<_>>();
            left.cmp(&right)
        });
        for entry in entries {
            let name = entry.file_name();
            let name_text = name
                .to_str()
                .ok_or_else(|| AppError::new("snapshot filename is not UTF-8"))?;
            let path = entry.path();
            let meta = fs::symlink_metadata(&path)?;
            if meta.file_type().is_symlink() {
                return Err(AppError::new(format!(
                    "snapshot symlink unsupported: {}",
                    path.display()
                )));
            }
            if meta.is_dir() {
                let lower = name_text.to_ascii_lowercase();
                if IGNORED_DIRS.contains(&lower.as_str())
                    || SENSITIVE_DIRS.contains(&lower.as_str())
                {
                    continue;
                }
                visit(root, &path, out, ordered, total, depth + 1)?;
            } else if meta.is_file() {
                if sensitive_file(name_text) {
                    continue;
                }
                if meta.len() > 5_000_000 {
                    return Err(AppError::new(format!(
                        "snapshot file exceeds 5 MB: {}",
                        path.display()
                    )));
                }
                *total += meta.len();
                if *total > 100_000_000 || out.len() >= 10_000 {
                    return Err(AppError::new("snapshot exceeds 10,000-file/100 MB budget"));
                }
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| AppError::new("snapshot path escaped root"))?;
                let relative = relative
                    .to_str()
                    .ok_or_else(|| AppError::new("snapshot path is not UTF-8"))?;
                if relative.contains('\\')
                    || relative.contains(',')
                    || relative.chars().any(|c| c.is_control())
                {
                    return Err(AppError::new(
                        "snapshot path contains unsupported characters",
                    ));
                }
                let relative = relative.to_owned();
                let sha256 = sha256_file(&path)?;
                ordered.push(NodeRecord {
                    file: relative.clone(),
                    sha256: sha256.clone(),
                    bytes: meta.len(),
                });
                out.insert(relative, sha256);
            } else {
                return Err(AppError::new(format!(
                    "special snapshot file unsupported: {}",
                    path.display()
                )));
            }
        }
        Ok(())
    }
    let mut result = BTreeMap::new();
    let mut ordered = Vec::new();
    let mut total = 0;
    visit(root, root, &mut result, &mut ordered, &mut total, 0)?;
    Ok((result, ordered))
}

fn fingerprint(files: &BTreeMap<String, String>) -> String {
    let mut hash = Sha256::new();
    for (path, digest) in files {
        hash.update((path.len() as u64).to_be_bytes());
        hash.update(path.as_bytes());
        hash.update(digest.as_bytes());
    }
    hex(&hash.finalize())
}

#[derive(Debug)]
pub struct TreeGuard {
    pub root: PathBuf,
    pub package_name: String,
    pub package_version: String,
    pub fingerprint: String,
    pub node_digest: String,
    files: BTreeMap<String, String>,
}
impl TreeGuard {
    pub fn open(input: &Path) -> Result<Self> {
        let meta = fs::symlink_metadata(input)
            .map_err(|e| AppError::new(format!("invalid snapshot {}: {e}", input.display())))?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(AppError::new("snapshot root must be a real directory"));
        }
        let root = fs::canonicalize(input)?;
        let (files, ordered) = collect(&root)?;
        let package = fs::read(root.join("package.json"))?;
        let json: Value = serde_json::from_slice(&package)
            .map_err(|e| AppError::new(format!("invalid package.json: {e}")))?;
        let package_name = json
            .get("name")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| AppError::new("package.json name required"))?
            .to_owned();
        let package_version = json
            .get("version")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| AppError::new("package.json version required"))?
            .to_owned();
        Ok(Self {
            root,
            package_name,
            package_version,
            fingerprint: fingerprint(&files),
            node_digest: sha256_bytes(&serde_json::to_vec(&ordered)?),
            files,
        })
    }
    pub fn unchanged(&self) -> Result<bool> {
        Ok(collect(&self.root)?.0 == self.files)
    }
    pub fn evidence_text(&self, relative: &str) -> Result<(String, String)> {
        let rel = Path::new(relative);
        if rel.is_absolute()
            || relative.contains('\\')
            || relative.contains(',')
            || relative.chars().any(|c| c.is_control())
            || rel.components().any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(AppError::new("unsafe evidence path"));
        }
        let expected = self
            .files
            .get(relative)
            .ok_or_else(|| AppError::new("evidence file was not admitted"))?;
        let mut current = self.root.clone();
        for component in rel.components() {
            let Component::Normal(name) = component else {
                return Err(AppError::new("unsafe evidence path"));
            };
            current.push(name);
            let meta = fs::symlink_metadata(&current)?;
            if meta.file_type().is_symlink() {
                return Err(AppError::new("evidence path contains symlink"));
            }
        }
        let canonical = fs::canonicalize(&current)?;
        if !canonical.starts_with(&self.root) {
            return Err(AppError::new("evidence escaped snapshot"));
        }
        let bytes = fs::read(&canonical)?;
        let digest = sha256_bytes(&bytes);
        if &digest != expected {
            return Err(AppError::new(
                "evidence file changed from admitted snapshot",
            ));
        }
        let text = String::from_utf8(bytes).map_err(|_| AppError::new("evidence is not UTF-8"))?;
        Ok((text, digest))
    }
}

pub fn canonical_file(input: &Path, label: &str) -> Result<PathBuf> {
    let canonical =
        fs::canonicalize(input).map_err(|e| AppError::new(format!("invalid {label}: {e}")))?;
    if !fs::metadata(&canonical)?.is_file() {
        return Err(AppError::new(format!("{label} must resolve to a file")));
    }
    Ok(canonical)
}

pub fn resolve_node(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        return canonical_file(path, "Node executable");
    }
    let path =
        env::var_os("PATH").ok_or_else(|| AppError::new("PATH unavailable for Node resolution"))?;
    for dir in env::split_paths(&path) {
        let candidate = dir.join("node");
        if candidate.is_file() {
            return canonical_file(&candidate, "Node executable");
        }
    }
    Err(AppError::new("Node executable not found on PATH"))
}

pub struct OutputTarget {
    pub parent: PathBuf,
    pub final_path: PathBuf,
}
impl OutputTarget {
    pub fn new(output: &Path, roots: &[&Path]) -> Result<Self> {
        let name = output
            .file_name()
            .ok_or_else(|| AppError::new("output filename required"))?;
        let parent_input = output
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let parent = fs::canonicalize(parent_input)
            .map_err(|e| AppError::new(format!("output parent must exist: {e}")))?;
        let final_path = parent.join(name);
        if final_path.exists() {
            return Err(AppError::new("output already exists"));
        }
        for root in roots {
            if final_path == *root || final_path.starts_with(root) {
                return Err(AppError::new("output must be outside input snapshots"));
            }
        }
        Ok(Self { parent, final_path })
    }
    pub fn publish(&self, bytes: &[u8]) -> Result<()> {
        let mut owned = None;
        for counter in 0..100_u32 {
            let temp = self
                .parent
                .join(format!(".ctrl-shift-{}-{counter}.tmp", std::process::id()));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temp)
            {
                Ok(file) => {
                    owned = Some((temp, file));
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        let (temp, mut file) = owned
            .ok_or_else(|| AppError::new("cannot allocate exclusive output temporary file"))?;
        let mut committed = false;
        let result = (|| -> Result<()> {
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::hard_link(&temp, &self.final_path)
                .map_err(|e| AppError::new(format!("cannot commit output exclusively: {e}")))?;
            committed = true;
            fs::remove_file(&temp)?;
            File::open(&self.parent)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            if committed {
                let _ = fs::remove_file(&self.final_path);
            }
            let _ = fs::remove_file(&temp);
            let _ = File::open(&self.parent).and_then(|directory| directory.sync_all());
        }
        result
    }
}

pub fn minimal_path(node: &Path) -> String {
    node.parent()
        .unwrap_or_else(|| Path::new("/usr/bin"))
        .to_string_lossy()
        .into_owned()
}

pub struct FileGuard {
    files: BTreeMap<PathBuf, String>,
}
impl FileGuard {
    pub fn new(paths: impl IntoIterator<Item = PathBuf>) -> Result<Self> {
        let mut files = BTreeMap::new();
        for path in paths {
            files.insert(path.clone(), sha256_file(&path)?);
        }
        Ok(Self { files })
    }
    pub fn unchanged(&self) -> Result<bool> {
        for (path, expected) in &self.files {
            if sha256_file(path)? != *expected {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ctrl-shift-paths-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn publish_never_removes_unowned_temp() {
        let root = temp();
        let final_path = root.join("result.json");
        let sentinel = root.join(format!(".ctrl-shift-{}-0.tmp", std::process::id()));
        fs::write(&sentinel, b"owner").unwrap();
        let target = OutputTarget {
            parent: root.clone(),
            final_path: final_path.clone(),
        };
        target.publish(b"{}\n").unwrap();
        assert_eq!(fs::read(&sentinel).unwrap(), b"owner");
        assert_eq!(fs::read(final_path).unwrap(), b"{}\n");
        fs::remove_dir_all(root).unwrap();
    }
}
