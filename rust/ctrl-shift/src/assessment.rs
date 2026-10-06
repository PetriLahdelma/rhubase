use crate::{
    assessment_report::render_markdown,
    error::{AppError, Result},
    paths::{DirectoryTarget, TreeGuard, sha256_bytes},
    validate::{ValidationContext, validate_contract},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    os::unix::fs::PermissionsExt,
    path::{Component, Path, PathBuf},
};
fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(format!("invalid assessment result: {}", message.into()))
}
fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("{label} must be an object")))
}
fn text<'a>(map: &'a Map<String, Value>, key: &str, label: &str) -> Result<&'a str> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("{label}.{key} required")))
}
fn array<'a>(map: &'a Map<String, Value>, key: &str, label: &str) -> Result<&'a Vec<Value>> {
    map.get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(format!("{label}.{key} must be an array")))
}
fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
fn relative(value: &str) -> bool {
    let path = Path::new(value);
    !path.is_absolute()
        && !value.contains('\\')
        && !value.contains(',')
        && !value.chars().any(char::is_control)
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResolvedPackage {
    pub id: String,
    pub kind: String,
    pub specifier: String,
    pub import_name: String,
    pub root: String,
    pub resolution: String,
    pub identity: Identity,
    pub manifest_sha256: String,
}
#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub name: String,
    pub version: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RepoFile {
    file: String,
    sha256: String,
    bytes: u64,
    kind: String,
}

pub struct RepositoryGuard {
    pub root: PathBuf,
    pub digest: String,
    files: HashMap<String, (String, u32)>,
}
impl RepositoryGuard {
    pub fn from_resolution(repository: &Value, expected_root: &Path) -> Result<Self> {
        let map = object(repository, "repository")?;
        let root = fs::canonicalize(text(map, "root", "repository")?)?;
        if root != expected_root {
            return Err(invalid("repository root mismatch"));
        }
        let digest = text(map, "digest", "repository")?.to_owned();
        if !hex64(&digest) {
            return Err(invalid("repository digest must be SHA-256"));
        }
        let records: Vec<RepoFile> = serde_json::from_value(
            map.get("files")
                .cloned()
                .ok_or_else(|| invalid("repository.files required"))?,
        )?;
        if records.is_empty() || records.len() > 10_000 {
            return Err(invalid("repository files empty or over budget"));
        }
        if sha256_bytes(&serde_json::to_vec(&records)?) != digest {
            return Err(invalid("repository inventory digest mismatch"));
        }
        let mut files = HashMap::new();
        let mut total = 0_u64;
        for record in records {
            total += record.bytes;
            if !relative(&record.file)
                || total > 100_000_000
                || !hex64(&record.sha256)
                || record.bytes > 5_000_000
                || record.kind.is_empty()
            {
                return Err(invalid("invalid repository file record"));
            }
            let mut path = root.clone();
            for part in Path::new(&record.file).components() {
                let Component::Normal(name) = part else {
                    return Err(invalid("unsafe repository path"));
                };
                path.push(name);
                if fs::symlink_metadata(&path)?.file_type().is_symlink() {
                    return Err(invalid("repository path contains symlink"));
                }
            }
            let metadata = fs::symlink_metadata(&path)?;
            let mode = metadata.permissions().mode();
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() != record.bytes
                || crate::paths::sha256_file(&path)? != record.sha256
                || files
                    .insert(record.file.clone(), (record.sha256.clone(), mode))
                    .is_some()
            {
                return Err(invalid(format!(
                    "repository file mismatch: {}",
                    record.file
                )));
            }
        }
        Ok(Self {
            root,
            digest,
            files,
        })
    }
    pub fn unchanged(&self) -> Result<bool> {
        for (file, (hash, mode)) in &self.files {
            let mut path = self.root.clone();
            for part in Path::new(file).components() {
                let Component::Normal(name) = part else {
                    return Ok(false);
                };
                path.push(name);
                if fs::symlink_metadata(&path)?.file_type().is_symlink() {
                    return Ok(false);
                }
            }
            let meta = fs::symlink_metadata(&path)?;
            if meta.permissions().mode() != *mode || crate::paths::sha256_file(&path)? != *hash {
                return Ok(false);
            }
        }
        Ok(true)
    }
    pub fn evidence_text(&self, file: &str) -> Result<(String, String)> {
        let Some((expected, _)) = self.files.get(file) else {
            return Err(invalid("evidence file not admitted"));
        };
        let path = self.root.join(file);
        let bytes = fs::read(path)?;
        let hash = sha256_bytes(&bytes);
        if &hash != expected {
            return Err(invalid("evidence hash changed"));
        }
        Ok((
            String::from_utf8(bytes).map_err(|_| invalid("evidence not UTF-8"))?,
            hash,
        ))
    }
}

pub struct Resolution {
    pub digest: String,
    pub repository: Value,
    pub sources: Vec<ResolvedPackage>,
    pub target: ResolvedPackage,
}
pub fn validate_resolution(value: &Value, repo: &Path) -> Result<(Resolution, RepositoryGuard)> {
    let map = object(value, "resolution")?;
    if map.len() != 6
        || map.get("schemaVersion") != Some(&Value::from(1))
        || map.get("kind") != Some(&Value::from("assessment-resolution"))
    {
        return Err(invalid("resolution header"));
    }
    let digest = text(map, "digest", "resolution")?.to_owned();
    if !hex64(&digest) {
        return Err(invalid("resolution digest"));
    }
    let repository = map
        .get("repository")
        .cloned()
        .ok_or_else(|| invalid("repository required"))?;
    let guard = RepositoryGuard::from_resolution(&repository, repo)?;
    let sources: Vec<ResolvedPackage> = serde_json::from_value(
        map.get("sources")
            .cloned()
            .ok_or_else(|| invalid("sources required"))?,
    )?;
    let target: ResolvedPackage = serde_json::from_value(
        map.get("target")
            .cloned()
            .ok_or_else(|| invalid("target required"))?,
    )?;
    if sources.is_empty() {
        return Err(invalid("sources empty"));
    }
    let mut ids = HashSet::new();
    let mut roots = HashSet::new();
    for package in sources.iter().chain([&target]) {
        if package.id.is_empty()
            || package.import_name.is_empty()
            || package.specifier.is_empty()
            || !ids.insert(&package.id)
            || !roots.insert(&package.root)
            || !hex64(&package.manifest_sha256)
            || !Path::new(&package.root).is_absolute()
        {
            return Err(invalid("invalid resolved package"));
        }
        let root = fs::canonicalize(&package.root)?;
        if root.components().any(|part|matches!(part,Component::Normal(name)if [".git",".ssh",".aws",".claude",".codex",".gnupg",".shift",".omx"].contains(&name.to_string_lossy().to_ascii_lowercase().as_str()))){return Err(invalid("package root crosses a sensitive/tool directory"))}
        match package.resolution.as_str() {
            "installed" | "workspace" => {
                if !root.starts_with(repo) {
                    return Err(invalid("installed/workspace package escapes repository"));
                }
            }
            "local" => {
                let requested = Path::new(&package.specifier);
                let expected = fs::canonicalize(if requested.is_absolute() {
                    requested.to_path_buf()
                } else {
                    repo.join(requested)
                })?;
                if expected != root {
                    return Err(invalid("local package selector/root mismatch"));
                }
            }
            _ => return Err(invalid("unsupported package resolution")),
        }
        let manifest = root.join("package.json");
        if crate::paths::sha256_file(&manifest)? != package.manifest_sha256 {
            return Err(invalid("package manifest mismatch"));
        }
        let parsed: Value = serde_json::from_slice(&fs::read(manifest)?)?;
        if parsed.get("name").and_then(Value::as_str) != Some(&package.identity.name)
            || parsed.get("version").and_then(Value::as_str) != Some(&package.identity.version)
        {
            return Err(invalid("package identity mismatch"));
        }
    }
    let mut source_imports = HashSet::new();
    if sources
        .iter()
        .any(|package| !source_imports.insert(&package.import_name))
    {
        return Err(invalid("source import names must be unique"));
    }
    if sources.iter().any(|package| package.kind != "source") || target.kind != "target" {
        return Err(invalid("package role mismatch"));
    }
    Ok((
        Resolution {
            digest,
            repository,
            sources,
            target,
        },
        guard,
    ))
}

pub struct ValidatedAssessment {
    pub assessment: Value,
    pub contracts: Vec<(String, String, Value)>,
}
pub fn validate_result(
    value: &Value,
    resolution: &Resolution,
    repository_guard: &RepositoryGuard,
    source_guards: &HashMap<String, TreeGuard>,
    target_guard: &TreeGuard,
    compiler_sha: &str,
) -> Result<ValidatedAssessment> {
    let map = object(value, "result")?;
    if map.len() != 5
        || map.get("schemaVersion") != Some(&Value::from(1))
        || map.get("kind") != Some(&Value::from("assessment-result"))
        || text(map, "resolutionDigest", "result")? != resolution.digest
    {
        return Err(invalid("result header or resolution digest"));
    }
    let assessment = map
        .get("assessment")
        .cloned()
        .ok_or_else(|| invalid("assessment required"))?;
    let records = array(map, "contracts", "result")?;
    if records.len() != resolution.sources.len() {
        return Err(invalid("one contract per source required"));
    }
    let mut contracts = Vec::new();
    let mut seen = HashSet::new();
    for (record_index, record) in records.iter().enumerate() {
        let item = object(record, &format!("contracts[{record_index}]"))?;
        if item.len() != 3 {
            return Err(invalid("contract record fields"));
        }
        let source_id = text(item, "sourceId", "contract")?.to_owned();
        let file = text(item, "file", "contract")?.to_owned();
        if !seen.insert(source_id.clone())
            || file != format!("contracts/{source_id}.json")
            || !relative(&file)
        {
            return Err(invalid("contract record identity"));
        }
        let guard = source_guards
            .get(&source_id)
            .ok_or_else(|| invalid("unknown contract source"))?;
        let contract = item
            .get("contract")
            .cloned()
            .ok_or_else(|| invalid("contract required"))?;
        validate_contract(
            &contract,
            &ValidationContext {
                from: guard,
                to: target_guard,
                compiler_sha256: compiler_sha,
            },
        )?;
        contracts.push((source_id, file, contract))
    }
    crate::assessment_validate::validate_assessment(
        &assessment,
        resolution,
        repository_guard,
        &contracts,
    )?;
    Ok(ValidatedAssessment {
        assessment,
        contracts,
    })
}

#[derive(Serialize)]
struct ArtifactFile {
    file: String,
    sha256: String,
    bytes: usize,
}
pub fn publish_report<F: FnOnce() -> Result<()>>(
    target: DirectoryTarget,
    validated: &ValidatedAssessment,
    before_commit: F,
) -> Result<PathBuf> {
    let mut files = Vec::new();
    let mut write = |file: &str, mut bytes: Vec<u8>| -> Result<()> {
        if !bytes.ends_with(b"\n") {
            bytes.push(b'\n')
        }
        target.write(file, &bytes)?;
        files.push(ArtifactFile {
            file: file.into(),
            sha256: sha256_bytes(&bytes),
            bytes: bytes.len(),
        });
        Ok(())
    };
    write(
        "assessment.json",
        serde_json::to_vec_pretty(&validated.assessment)?,
    )?;
    write(
        "assessment.md",
        render_markdown(&validated.assessment)?.into_bytes(),
    )?;
    for (_, file, contract) in &validated.contracts {
        write(file, serde_json::to_vec_pretty(contract)?)?
    }
    files.sort_by(|a, b| a.file.cmp(&b.file));
    let digest = sha256_bytes(&serde_json::to_vec(&files)?);
    let manifest = serde_json::json!({"schemaVersion":1,"kind":"consumer-assessment-artifact-manifest","digest":digest,"files":files});
    target.write("manifest.json", &serde_json::to_vec_pretty(&manifest)?)?;
    before_commit()?;
    target.commit()
}
