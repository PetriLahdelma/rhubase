use crate::{
    error::{AppError, Result},
    paths::{canonical_file, sha256_bytes, sha256_file},
};
use std::{
    env,
    fs::{self, DirBuilder, File, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
const TRUSTED_SHA: &str = "3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675";
pub struct CompilerGuard {
    pub path: PathBuf,
    pub original: PathBuf,
    original_sha: String,
    temp: Option<PathBuf>,
}
impl CompilerGuard {
    pub fn resolve(
        explicit: Option<&Path>,
        repo: &Path,
        workspaces: &[PathBuf],
        checkout: &Path,
        protected_roots: &[PathBuf],
    ) -> Result<Self> {
        let environment = env::var_os("SHIFT_TYPESCRIPT_PATH")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        let mut candidates = vec![
            checkout.join("node_modules/typescript/lib/typescript.js"),
            repo.join("node_modules/typescript/lib/typescript.js"),
        ];
        candidates.extend(
            workspaces
                .iter()
                .map(|root| root.join("node_modules/typescript/lib/typescript.js")),
        );
        let operator_selected = explicit.is_some() || environment.is_some();
        let selected=explicit.map(PathBuf::from).or(environment).or_else(||candidates.into_iter().find(|path|path.is_file())).ok_or_else(||AppError::usage("TypeScript compiler is required. Pass `--compiler`, set `SHIFT_TYPESCRIPT_PATH`, or install the pinned compiler in Shift or the repository."))?;
        let original = canonical_file(&selected, "TypeScript compiler")?;
        let original_sha = sha256_file(&original)?;
        let protected = protected_roots
            .iter()
            .any(|root| original.starts_with(root));
        if original_sha != TRUSTED_SHA && (!operator_selected || protected) {
            return Err(AppError::new(
                "TypeScript compiler does not match the trusted 5.9.3 identity",
            ));
        }
        let temp = (0..100_u32)
            .find_map(|counter| {
                let path = env::temp_dir().join(format!(
                    "ctrl-shift-compiler-{}-{counter}",
                    std::process::id()
                ));
                let mut builder = DirBuilder::new();
                builder.mode(0o700);
                match builder.create(&path) {
                    Ok(()) => Some(Ok(path)),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                    Err(error) => Some(Err(error)),
                }
            })
            .ok_or_else(|| AppError::new("cannot allocate private compiler directory"))??;
        let prepare = || -> Result<PathBuf> {
            let path = temp.join("typescript.js");
            let bytes = fs::read(&original)?;
            if sha256_bytes(&bytes) != original_sha {
                return Err(AppError::new(
                    "TypeScript compiler changed while preparing its private copy",
                ));
            }
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            File::open(&temp)?.sync_all()?;
            if sha256_file(&original)? != original_sha || sha256_file(&path)? != original_sha {
                return Err(AppError::new(
                    "TypeScript compiler changed while preparing its private copy",
                ));
            }
            Ok(path)
        };
        let path = match prepare() {
            Ok(path) => path,
            Err(error) => {
                let _ = fs::remove_dir_all(&temp);
                return Err(error);
            }
        };
        Ok(Self {
            path,
            original,
            original_sha,
            temp: Some(temp),
        })
    }
    pub fn unchanged(&self) -> Result<bool> {
        Ok(sha256_file(&self.original)? == self.original_sha
            && sha256_file(&self.path)? == self.original_sha)
    }
    pub fn sha256(&self) -> &str {
        &self.original_sha
    }
}
impl Drop for CompilerGuard {
    fn drop(&mut self) {
        if let Some(temp) = &self.temp {
            let _ = fs::remove_dir_all(temp);
        }
    }
}
