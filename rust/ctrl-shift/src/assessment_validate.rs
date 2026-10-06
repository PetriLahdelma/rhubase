use crate::{
    assessment::{RepositoryGuard, Resolution},
    error::{AppError, Result},
};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

const UNSUPPORTED_KINDS: &[&str] = &[
    "syntax-diagnostic",
    "wrapper-usage",
    "factory-or-alias",
    "local-reexport-resolution",
    "unsupported-version-scope",
    "spread-props",
    "undeclared-package-subpath",
    "style-import",
    "dynamic-module-binding",
    "non-jsx-reference",
    "excluded-source-library",
];

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(format!("invalid assessment result: {}", message.into()))
}
fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("{label} must be an object")))
}
fn array<'a>(value: &'a Value, label: &str) -> Result<&'a Vec<Value>> {
    value
        .as_array()
        .ok_or_else(|| invalid(format!("{label} must be an array")))
}
fn field<'a>(map: &'a Map<String, Value>, key: &str, label: &str) -> Result<&'a Value> {
    map.get(key)
        .ok_or_else(|| invalid(format!("{label}.{key} required")))
}
fn text<'a>(value: &'a Value, label: &str) -> Result<&'a str> {
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("{label} must be a nonempty string")))
}
fn number(value: &Value, label: &str) -> Result<usize> {
    value
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| invalid(format!("{label} must be a nonnegative integer")))
}
fn exact(map: &Map<String, Value>, keys: &[&str], label: &str) -> Result<()> {
    if map.len() != keys.len() || keys.iter().any(|key| !map.contains_key(*key)) {
        return Err(invalid(format!("{label} has unexpected or missing fields")));
    }
    Ok(())
}
fn allowed(
    map: &Map<String, Value>,
    required: &[&str],
    allowed: &[&str],
    label: &str,
) -> Result<()> {
    if required.iter().any(|key| !map.contains_key(*key))
        || map.keys().any(|key| !allowed.contains(&key.as_str()))
    {
        return Err(invalid(format!("{label} has unexpected or missing fields")));
    }
    Ok(())
}
fn relative(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value.contains('\\')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}
fn scalar(value: &Value) -> bool {
    value.is_null() || value.is_boolean() || value.is_number() || value.is_string()
}
fn string_set(value: &Value, label: &str) -> Result<HashSet<String>> {
    let mut result = HashSet::new();
    for (index, item) in array(value, label)?.iter().enumerate() {
        let value = text(item, &format!("{label}[{index}]"))?;
        if !result.insert(value.to_owned()) {
            return Err(invalid(format!("{label} contains duplicates")));
        }
    }
    Ok(result)
}
fn identity<'a>(value: &'a Value, label: &str) -> Result<(&'a str, &'a str)> {
    let map = object(value, label)?;
    exact(map, &["name", "version", "digest", "entrypoints"], label)?;
    Ok((
        text(field(map, "name", label)?, &format!("{label}.name"))?,
        text(field(map, "version", label)?, &format!("{label}.version"))?,
    ))
}
fn json_key(value: &Value) -> Result<String> {
    serde_json::to_string(value).map_err(Into::into)
}

#[derive(Clone)]
struct CachedFile {
    text: String,
    sha256: String,
}
struct EvidenceCache<'a> {
    guard: &'a RepositoryGuard,
    files: HashMap<String, CachedFile>,
}
impl<'a> EvidenceCache<'a> {
    fn new(guard: &'a RepositoryGuard) -> Self {
        Self {
            guard,
            files: HashMap::new(),
        }
    }
    fn read(&mut self, file: &str) -> Result<&CachedFile> {
        if !self.files.contains_key(file) {
            let (text, sha256) = self.guard.evidence_text(file)?;
            self.files
                .insert(file.to_owned(), CachedFile { text, sha256 });
        }
        self.files
            .get(file)
            .ok_or_else(|| invalid("evidence cache insertion failed"))
    }
}

#[derive(Clone, Copy)]
struct Location {
    line: usize,
    column: usize,
    start: usize,
    end: usize,
}

fn utf16_offset(text: &str, byte: usize) -> usize {
    text[..byte].encode_utf16().count()
}
fn line_at(text: &str, byte: usize) -> usize {
    text.as_bytes()[..byte]
        .iter()
        .filter(|value| **value == b'\n')
        .count()
        + 1
}
fn column_at(text: &str, byte: usize) -> usize {
    let line_start = text[..byte].rfind('\n').map_or(0, |index| index + 1);
    text[line_start..byte].encode_utf16().count() + 1
}

fn validate_evidence(
    value: &Value,
    cache: &mut EvidenceCache<'_>,
    expected: Option<Location>,
    label: &str,
) -> Result<()> {
    let map = object(value, label)?;
    exact(
        map,
        &["scope", "file", "sha256", "startLine", "endLine", "quote"],
        label,
    )?;
    if field(map, "scope", label)?.as_str() != Some("consumer") {
        return Err(invalid(format!("{label}.scope must be consumer")));
    }
    let file = text(field(map, "file", label)?, &format!("{label}.file"))?;
    if !relative(file) {
        return Err(invalid(format!("{label}.file is unsafe")));
    }
    let sha = text(field(map, "sha256", label)?, &format!("{label}.sha256"))?;
    let start_line = number(
        field(map, "startLine", label)?,
        &format!("{label}.startLine"),
    )?;
    let end_line = number(field(map, "endLine", label)?, &format!("{label}.endLine"))?;
    let quote = text(field(map, "quote", label)?, &format!("{label}.quote"))?;
    if start_line == 0 || end_line < start_line {
        return Err(invalid(format!("{label} line range is invalid")));
    }
    let cached = cache.read(file)?;
    if cached.sha256 != sha {
        return Err(invalid(format!("{label} hash mismatch")));
    }
    let mut valid = false;
    for (start, matched) in cached.text.match_indices(quote) {
        let end = start + matched.len();
        if line_at(&cached.text, start) != start_line || line_at(&cached.text, end) != end_line {
            continue;
        }
        if let Some(location) = expected
            && (location.line != start_line
                || location.column != column_at(&cached.text, start)
                || location.start != utf16_offset(&cached.text, start)
                || location.end != utf16_offset(&cached.text, end))
        {
            continue;
        }
        valid = true;
        break;
    }
    if !valid {
        return Err(invalid(format!("{label} excerpt/location mismatch")));
    }
    Ok(())
}

fn validate_evidence_array(
    value: &Value,
    cache: &mut EvidenceCache<'_>,
    expected: Option<Location>,
    allow_empty: bool,
    label: &str,
) -> Result<()> {
    let evidence = array(value, label)?;
    if evidence.is_empty() && !allow_empty {
        return Err(invalid(format!("{label} must not be empty")));
    }
    for (index, item) in evidence.iter().enumerate() {
        validate_evidence(item, cache, expected, &format!("{label}[{index}]"))?;
    }
    Ok(())
}

fn validate_repository(
    value: &Value,
    resolution: &Resolution,
    guard: &RepositoryGuard,
) -> Result<()> {
    let map = object(value, "assessment.repository")?;
    allowed(
        map,
        &[
            "digest",
            "packageManager",
            "workspaces",
            "manifests",
            "declaredScripts",
            "ciEvidence",
            "codeowners",
            "coverage",
        ],
        &[
            "name",
            "digest",
            "packageManager",
            "workspaces",
            "manifests",
            "declaredScripts",
            "ciEvidence",
            "codeowners",
            "coverage",
        ],
        "assessment.repository",
    )?;
    if field(map, "digest", "assessment.repository")?.as_str() != Some(&guard.digest)
        || field(map, "digest", "assessment.repository")?
            != resolution.repository.get("digest").unwrap_or(&Value::Null)
    {
        return Err(invalid("portable repository digest mismatch"));
    }
    let package_manager = object(
        field(map, "packageManager", "assessment.repository")?,
        "packageManager",
    )?;
    allowed(
        package_manager,
        &["lockfiles"],
        &["declared", "lockfiles"],
        "packageManager",
    )?;
    if let Some(declared) = package_manager.get("declared") {
        text(declared, "packageManager.declared")?;
    }
    for item in array(
        field(package_manager, "lockfiles", "packageManager")?,
        "packageManager.lockfiles",
    )? {
        let item = object(item, "lockfile")?;
        exact(item, &["file", "sha256"], "lockfile")?;
        if !relative(text(field(item, "file", "lockfile")?, "lockfile.file")?) {
            return Err(invalid("lockfile path"));
        }
        text(field(item, "sha256", "lockfile")?, "lockfile.sha256")?;
    }
    for workspace in array(
        field(map, "workspaces", "assessment.repository")?,
        "workspaces",
    )? {
        let workspace = object(workspace, "workspace")?;
        allowed(workspace, &["path"], &["path", "name"], "workspace")?;
        if !relative(text(
            field(workspace, "path", "workspace")?,
            "workspace.path",
        )?) {
            return Err(invalid("workspace path"));
        }
        if let Some(name) = workspace.get("name") {
            text(name, "workspace.name")?;
        }
    }
    for manifest in array(
        field(map, "manifests", "assessment.repository")?,
        "manifests",
    )? {
        let manifest = object(manifest, "manifest")?;
        allowed(
            manifest,
            &["file", "dependencies"],
            &["file", "name", "version", "dependencies"],
            "manifest",
        )?;
        if !relative(text(field(manifest, "file", "manifest")?, "manifest.file")?) {
            return Err(invalid("manifest path"));
        }
        for optional in ["name", "version"] {
            if let Some(value) = manifest.get(optional) {
                text(value, &format!("manifest.{optional}"))?;
            }
        }
        for dependency in array(
            field(manifest, "dependencies", "manifest")?,
            "manifest.dependencies",
        )? {
            let dependency = object(dependency, "dependency")?;
            exact(dependency, &["name", "section", "specType"], "dependency")?;
            for key in ["name", "section", "specType"] {
                text(
                    field(dependency, key, "dependency")?,
                    &format!("dependency.{key}"),
                )?;
            }
        }
    }
    for script in array(
        field(map, "declaredScripts", "assessment.repository")?,
        "declaredScripts",
    )? {
        let script = object(script, "declared script")?;
        exact(script, &["manifest", "name", "category"], "declared script")?;
        for key in ["manifest", "name", "category"] {
            let value = text(
                field(script, key, "declared script")?,
                &format!("declared script.{key}"),
            )?;
            if key == "manifest" && !relative(value) {
                return Err(invalid("declared script manifest path"));
            }
        }
    }
    for item in array(
        field(map, "ciEvidence", "assessment.repository")?,
        "ciEvidence",
    )? {
        let item = object(item, "CI evidence")?;
        exact(item, &["file", "sha256"], "CI evidence")?;
        if !relative(text(
            field(item, "file", "CI evidence")?,
            "CI evidence.file",
        )?) {
            return Err(invalid("CI path"));
        }
        text(field(item, "sha256", "CI evidence")?, "CI evidence.sha256")?;
    }
    for document in array(
        field(map, "codeowners", "assessment.repository")?,
        "codeowners",
    )? {
        let document = object(document, "CODEOWNERS")?;
        exact(
            document,
            &["file", "sha256", "active", "rules"],
            "CODEOWNERS",
        )?;
        if !relative(text(
            field(document, "file", "CODEOWNERS")?,
            "CODEOWNERS.file",
        )?) || field(document, "active", "CODEOWNERS")?.as_bool().is_none()
        {
            return Err(invalid("CODEOWNERS metadata"));
        }
        text(
            field(document, "sha256", "CODEOWNERS")?,
            "CODEOWNERS.sha256",
        )?;
        for rule in array(field(document, "rules", "CODEOWNERS")?, "CODEOWNERS.rules")? {
            let rule = object(rule, "CODEOWNERS rule")?;
            exact(rule, &["pattern", "owners", "line"], "CODEOWNERS rule")?;
            text(
                field(rule, "pattern", "CODEOWNERS rule")?,
                "CODEOWNERS rule.pattern",
            )?;
            string_set(
                field(rule, "owners", "CODEOWNERS rule")?,
                "CODEOWNERS rule.owners",
            )?;
            if number(
                field(rule, "line", "CODEOWNERS rule")?,
                "CODEOWNERS rule.line",
            )? == 0
            {
                return Err(invalid("CODEOWNERS line"));
            }
        }
    }
    let coverage = object(
        field(map, "coverage", "assessment.repository")?,
        "repository.coverage",
    )?;
    exact(
        coverage,
        &["scannedSourceFiles", "excluded", "unsupported"],
        "repository.coverage",
    )?;
    number(
        field(coverage, "scannedSourceFiles", "repository.coverage")?,
        "repository.coverage.scannedSourceFiles",
    )?;
    for key in ["excluded", "unsupported"] {
        array(
            field(coverage, key, "repository.coverage")?,
            &format!("repository.coverage.{key}"),
        )?;
    }
    Ok(())
}

fn repository_projection(repository: &Value) -> Result<Value> {
    let source = object(repository, "resolution.repository")?;
    let mut projected = Map::new();
    for key in [
        "digest",
        "packageManager",
        "workspaces",
        "manifests",
        "declaredScripts",
        "ciEvidence",
        "codeowners",
        "coverage",
    ] {
        projected.insert(
            key.to_owned(),
            field(source, key, "resolution.repository")?.clone(),
        );
    }
    if let Some(root_manifest) =
        source
            .get("manifests")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item.get("file").and_then(Value::as_str) == Some("package.json"))
            })
        && let Some(name) = root_manifest.get("name")
    {
        projected.insert("name".into(), name.clone());
    }
    let codeowners = projected
        .get("codeowners")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let preference = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
    let active = codeowners
        .iter()
        .find(|item| item.get("active").and_then(Value::as_bool) == Some(true))
        .or_else(|| {
            preference.iter().find_map(|file| {
                codeowners
                    .iter()
                    .find(|item| item.get("file").and_then(Value::as_str) == Some(*file))
            })
        });
    let mut extra = Vec::new();
    if let Some(active) = active {
        let file = active
            .get("file")
            .and_then(Value::as_str)
            .unwrap_or_default();
        for rule in active
            .get("rules")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let pattern = rule
                .get("pattern")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let bounded = pattern.strip_prefix('/').unwrap_or(pattern);
            if bounded.is_empty()
                || bounded.starts_with('!')
                || bounded.contains(['?', '[', ']', '{', '}', '\\'])
                || bounded.contains("**")
                || (bounded.contains('*') && !bounded.ends_with('*'))
            {
                extra.push(serde_json::json!({
                    "kind":"codeowners-pattern",
                    "file":file,
                    "reason":format!("CODEOWNERS line {} is outside the bounded ownership-matching subset", rule.get("line").and_then(Value::as_u64).unwrap_or(0))
                }));
            }
        }
    }
    if !extra.is_empty() {
        let coverage = projected
            .get_mut("coverage")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| invalid("resolution repository coverage"))?;
        coverage
            .get_mut("unsupported")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| invalid("resolution repository unsupported coverage"))?
            .extend(extra);
    }
    Ok(Value::Object(projected))
}

struct ContractIndex {
    changes: HashMap<String, Value>,
    proposals: HashMap<String, Value>,
}

fn contract_indexes(
    contracts: &[(String, String, Value)],
) -> Result<HashMap<String, ContractIndex>> {
    let mut result = HashMap::new();
    for (source, _, contract) in contracts {
        let map = object(contract, "contract")?;
        let changes = array(field(map, "changes", "contract")?, "contract.changes")?
            .iter()
            .map(|item| {
                Ok((
                    text(field(object(item, "change")?, "id", "change")?, "change.id")?.to_owned(),
                    item.clone(),
                ))
            })
            .collect::<Result<HashMap<_, _>>>()?;
        let proposals = array(field(map, "proposals", "contract")?, "contract.proposals")?
            .iter()
            .map(|item| {
                Ok((
                    text(
                        field(object(item, "proposal")?, "id", "proposal")?,
                        "proposal.id",
                    )?
                    .to_owned(),
                    item.clone(),
                ))
            })
            .collect::<Result<HashMap<_, _>>>()?;
        if result
            .insert(source.clone(), ContractIndex { changes, proposals })
            .is_some()
        {
            return Err(invalid("duplicate source contract"));
        }
    }
    Ok(result)
}

fn validate_sources_target(
    map: &Map<String, Value>,
    resolution: &Resolution,
    contracts: &[(String, String, Value)],
) -> Result<()> {
    let contract_map: HashMap<&str, (&str, &Value)> = contracts
        .iter()
        .map(|(source, file, contract)| (source.as_str(), (file.as_str(), contract)))
        .collect();
    let sources = array(field(map, "sources", "assessment")?, "assessment.sources")?;
    if sources.len() != resolution.sources.len() {
        return Err(invalid("assessment source count"));
    }
    for source in &resolution.sources {
        let record = sources
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(&source.id))
            .ok_or_else(|| invalid("assessment source missing"))?;
        let record = object(record, "assessment source")?;
        exact(
            record,
            &["id", "importName", "resolution", "identity", "contractFile"],
            "assessment source",
        )?;
        let (file, contract) = contract_map
            .get(source.id.as_str())
            .ok_or_else(|| invalid("source contract missing"))?;
        if field(record, "importName", "assessment source")?.as_str() != Some(&source.import_name)
            || field(record, "resolution", "assessment source")?.as_str()
                != Some(&source.resolution)
            || field(record, "contractFile", "assessment source")?.as_str() != Some(*file)
            || *file != format!("contracts/{}.json", source.id)
            || field(record, "identity", "assessment source")?
                != contract.get("from").unwrap_or(&Value::Null)
        {
            return Err(invalid("assessment source/contract mismatch"));
        }
        let (name, version) = identity(
            field(record, "identity", "assessment source")?,
            "assessment source.identity",
        )?;
        if name != source.identity.name || version != source.identity.version {
            return Err(invalid("assessment source resolution identity mismatch"));
        }
    }
    let target = object(field(map, "target", "assessment")?, "assessment.target")?;
    exact(
        target,
        &["id", "resolution", "identity"],
        "assessment.target",
    )?;
    if field(target, "id", "assessment.target")?.as_str() != Some(&resolution.target.id)
        || field(target, "resolution", "assessment.target")?.as_str()
            != Some(&resolution.target.resolution)
    {
        return Err(invalid("assessment target mismatch"));
    }
    let (target_name, target_version) = identity(
        field(target, "identity", "assessment.target")?,
        "assessment.target.identity",
    )?;
    if target_name != resolution.target.identity.name
        || target_version != resolution.target.identity.version
    {
        return Err(invalid("assessment target identity mismatch"));
    }
    for (_, _, contract) in contracts {
        if contract.get("to") != target.get("identity") {
            return Err(invalid("pairwise contract target identities differ"));
        }
    }
    Ok(())
}

struct UsageRecord {
    source_id: String,
    export: String,
    evidence: Vec<Value>,
    location: Location,
}

fn validate_usage_inventory(
    value: &Value,
    resolution: &Resolution,
    cache: &mut EvidenceCache<'_>,
) -> Result<(HashMap<String, UsageRecord>, HashSet<String>)> {
    let map = object(value, "usageInventory")?;
    exact(
        map,
        &["filesScanned", "usages", "unsupported", "coverage"],
        "usageInventory",
    )?;
    let files_scanned = number(
        field(map, "filesScanned", "usageInventory")?,
        "usageInventory.filesScanned",
    )?;
    let source_ids: HashSet<&str> = resolution
        .sources
        .iter()
        .map(|source| source.id.as_str())
        .collect();
    let mut usages = HashMap::new();
    for (index, value) in array(
        field(map, "usages", "usageInventory")?,
        "usageInventory.usages",
    )?
    .iter()
    .enumerate()
    {
        let label = format!("usageInventory.usages[{index}]");
        let usage = object(value, &label)?;
        exact(
            usage,
            &[
                "id",
                "file",
                "line",
                "column",
                "start",
                "end",
                "consumerPackage",
                "sourceId",
                "module",
                "export",
                "props",
                "hasSpread",
                "evidence",
            ],
            &label,
        )?;
        let id = text(field(usage, "id", &label)?, &format!("{label}.id"))?;
        let file = text(field(usage, "file", &label)?, &format!("{label}.file"))?;
        if !relative(file) {
            return Err(invalid(format!("{label}.file is unsafe")));
        }
        let source_id = text(
            field(usage, "sourceId", &label)?,
            &format!("{label}.sourceId"),
        )?;
        if !source_ids.contains(source_id) {
            return Err(invalid(format!("{label}.sourceId is not selected")));
        }
        if !field(usage, "consumerPackage", &label)?.is_null() {
            text(
                field(usage, "consumerPackage", &label)?,
                &format!("{label}.consumerPackage"),
            )?;
        }
        let module = text(field(usage, "module", &label)?, &format!("{label}.module"))?;
        let source = resolution
            .sources
            .iter()
            .find(|item| item.id == source_id)
            .expect("source checked");
        if module != source.import_name && !module.starts_with(&(source.import_name.clone() + "/"))
        {
            return Err(invalid(format!(
                "{label}.module is outside selected package"
            )));
        }
        let export = text(field(usage, "export", &label)?, &format!("{label}.export"))?;
        let location = Location {
            line: number(field(usage, "line", &label)?, &format!("{label}.line"))?,
            column: number(field(usage, "column", &label)?, &format!("{label}.column"))?,
            start: number(field(usage, "start", &label)?, &format!("{label}.start"))?,
            end: number(field(usage, "end", &label)?, &format!("{label}.end"))?,
        };
        if location.line == 0 || location.column == 0 || location.end <= location.start {
            return Err(invalid(format!("{label} location is invalid")));
        }
        let mut prop_names = HashSet::new();
        let mut spread = false;
        for prop in array(field(usage, "props", &label)?, &format!("{label}.props"))? {
            let prop = object(prop, "usage prop")?;
            exact(prop, &["name", "kind", "value"], "usage prop")?;
            let name = text(field(prop, "name", "usage prop")?, "usage prop.name")?;
            let kind = text(field(prop, "kind", "usage prop")?, "usage prop.kind")?;
            if !["literal", "expression", "spread"].contains(&kind)
                || (kind != "spread" && !prop_names.insert(name))
                || !scalar(field(prop, "value", "usage prop")?)
            {
                return Err(invalid("usage prop shape"));
            }
            spread |= kind == "spread";
        }
        if field(usage, "hasSpread", &label)?.as_bool() != Some(spread) {
            return Err(invalid(format!("{label}.hasSpread mismatch")));
        }
        let evidence = array(
            field(usage, "evidence", &label)?,
            &format!("{label}.evidence"),
        )?
        .clone();
        if evidence.is_empty()
            || evidence
                .iter()
                .any(|item| item.get("file").and_then(Value::as_str) != Some(file))
        {
            return Err(invalid(format!("{label}.evidence file mismatch")));
        }
        for (evidence_index, item) in evidence.iter().enumerate() {
            validate_evidence(
                item,
                cache,
                Some(location),
                &format!("{label}.evidence[{evidence_index}]"),
            )?;
        }
        if usages
            .insert(
                id.to_owned(),
                UsageRecord {
                    source_id: source_id.to_owned(),
                    export: export.to_owned(),
                    evidence,
                    location,
                },
            )
            .is_some()
        {
            return Err(invalid("duplicate usage id"));
        }
    }
    let mut unsupported_ids = HashSet::new();
    for (index, value) in array(
        field(map, "unsupported", "usageInventory")?,
        "usageInventory.unsupported",
    )?
    .iter()
    .enumerate()
    {
        let label = format!("usageInventory.unsupported[{index}]");
        let item = object(value, &label)?;
        allowed(
            item,
            &["id", "kind", "reason", "evidence"],
            &[
                "id", "kind", "file", "line", "column", "start", "end", "reason", "evidence",
            ],
            &label,
        )?;
        let id = text(field(item, "id", &label)?, &format!("{label}.id"))?;
        let kind = text(field(item, "kind", &label)?, &format!("{label}.kind"))?;
        if !UNSUPPORTED_KINDS.contains(&kind)
            || usages.contains_key(id)
            || !unsupported_ids.insert(id.to_owned())
        {
            return Err(invalid(format!("{label} identity/kind")));
        }
        text(field(item, "reason", &label)?, &format!("{label}.reason"))?;
        let has_location = ["file", "line", "column", "start", "end"]
            .iter()
            .all(|key| item.contains_key(*key));
        if ["file", "line", "column", "start", "end"]
            .iter()
            .any(|key| item.contains_key(*key))
            != has_location
        {
            return Err(invalid(format!("{label} has partial location")));
        }
        let expected = if has_location {
            let file = text(field(item, "file", &label)?, &format!("{label}.file"))?;
            if !relative(file) {
                return Err(invalid(format!("{label}.file")));
            }
            Some(Location {
                line: number(field(item, "line", &label)?, &format!("{label}.line"))?,
                column: number(field(item, "column", &label)?, &format!("{label}.column"))?,
                start: number(field(item, "start", &label)?, &format!("{label}.start"))?,
                end: number(field(item, "end", &label)?, &format!("{label}.end"))?,
            })
        } else {
            None
        };
        validate_evidence_array(
            field(item, "evidence", &label)?,
            cache,
            expected,
            !has_location,
            &format!("{label}.evidence"),
        )?;
    }
    let coverage = object(
        field(map, "coverage", "usageInventory")?,
        "usageInventory.coverage",
    )?;
    exact(
        coverage,
        &[
            "status",
            "sourceFiles",
            "jsxSites",
            "recognizedUsages",
            "unsupportedCount",
            "observedUnsupportedCount",
            "limitations",
        ],
        "usageInventory.coverage",
    )?;
    if field(coverage, "status", "usageInventory.coverage")?.as_str() != Some("partial")
        || number(
            field(coverage, "recognizedUsages", "usageInventory.coverage")?,
            "recognizedUsages",
        )? != usages.len()
        || number(
            field(coverage, "unsupportedCount", "usageInventory.coverage")?,
            "unsupportedCount",
        )? != unsupported_ids.len()
        || number(
            field(
                coverage,
                "observedUnsupportedCount",
                "usageInventory.coverage",
            )?,
            "observedUnsupportedCount",
        )? != unsupported_ids.len()
    {
        return Err(invalid("usage coverage counts/status"));
    }
    let source_files = object(
        field(coverage, "sourceFiles", "usageInventory.coverage")?,
        "sourceFiles",
    )?;
    exact(
        source_files,
        &["eligible", "scanned", "excludedSourceLibraries"],
        "sourceFiles",
    )?;
    let scanned = number(
        field(source_files, "scanned", "sourceFiles")?,
        "sourceFiles.scanned",
    )?;
    let eligible = number(
        field(source_files, "eligible", "sourceFiles")?,
        "sourceFiles.eligible",
    )?;
    number(
        field(source_files, "excludedSourceLibraries", "sourceFiles")?,
        "sourceFiles.excludedSourceLibraries",
    )?;
    if scanned != files_scanned
        || scanned > eligible
        || number(
            field(coverage, "jsxSites", "usageInventory.coverage")?,
            "jsxSites",
        )? < usages.len()
    {
        return Err(invalid("usage source/JSX coverage counts"));
    }
    let limitations = array(
        field(coverage, "limitations", "usageInventory.coverage")?,
        "usage limitations",
    )?;
    if limitations.is_empty()
        || limitations
            .iter()
            .any(|item| item.as_str().is_none_or(str::is_empty))
    {
        return Err(invalid("usage limitations"));
    }
    Ok((usages, unsupported_ids))
}

fn ref_matches_group(
    reference: &Value,
    group_export: &str,
    condition: &Map<String, Value>,
) -> Result<bool> {
    let reference = object(reference, "contract reference")?;
    if field(reference, "export", "contract reference")?.as_str() != Some(group_export) {
        return Ok(false);
    }
    let Some(prop) = reference.get("prop") else {
        return Ok(true);
    };
    let prop = text(prop, "contract reference.prop")?;
    if !array(
        field(condition, "presentProps", "condition")?,
        "condition.presentProps",
    )?
    .iter()
    .any(|item| item.as_str() == Some(prop))
    {
        return Ok(false);
    }
    let Some(value) = reference.get("value") else {
        return Ok(true);
    };
    Ok(array(
        field(condition, "literalProps", "condition")?,
        "condition.literalProps",
    )?
    .iter()
    .any(|item| {
        item.get("name").and_then(Value::as_str) == Some(prop) && item.get("value") == Some(value)
    }))
}

fn proposal_targets(proposal: &Value) -> Result<Vec<Value>> {
    let map = object(proposal, "proposal")?;
    if field(map, "basis", "proposal")?.as_str() != Some("documentation-explicit") {
        return Err(invalid("group proposal must be documentation-explicit"));
    }
    if let Some(target) = map.get("target") {
        Ok(vec![target.clone()])
    } else {
        Ok(array(field(map, "targets", "proposal")?, "proposal.targets")?.clone())
    }
}

fn validate_groups_decisions(
    groups_value: &Value,
    decisions_value: &Value,
    usages: &HashMap<String, UsageRecord>,
    indexes: &HashMap<String, ContractIndex>,
    cache: &mut EvidenceCache<'_>,
) -> Result<()> {
    let mut groups = HashMap::new();
    let mut grouped_usages = HashSet::new();
    for (index, value) in array(groups_value, "mappingGroups")?.iter().enumerate() {
        let label = format!("mappingGroups[{index}]");
        let group = object(value, &label)?;
        exact(
            group,
            &[
                "id",
                "sourceId",
                "export",
                "condition",
                "usageIds",
                "count",
                "route",
                "reviewRequired",
                "target",
                "candidateTargets",
                "contractChangeIds",
                "proposalIds",
                "candidateOwners",
                "evidence",
                "representative",
            ],
            &label,
        )?;
        let id = text(field(group, "id", &label)?, &format!("{label}.id"))?;
        let source_id = text(
            field(group, "sourceId", &label)?,
            &format!("{label}.sourceId"),
        )?;
        let export = text(field(group, "export", &label)?, &format!("{label}.export"))?;
        let index = indexes
            .get(source_id)
            .ok_or_else(|| invalid(format!("{label}.sourceId")))?;
        let condition = object(
            field(group, "condition", &label)?,
            &format!("{label}.condition"),
        )?;
        exact(
            condition,
            &["literalProps", "presentProps", "hasSpread", "dynamicProps"],
            &format!("{label}.condition"),
        )?;
        if field(condition, "hasSpread", "condition")?
            .as_bool()
            .is_none()
        {
            return Err(invalid(format!("{label}.condition.hasSpread")));
        }
        let present = string_set(
            field(condition, "presentProps", "condition")?,
            "condition.presentProps",
        )?;
        let dynamic = string_set(
            field(condition, "dynamicProps", "condition")?,
            "condition.dynamicProps",
        )?;
        if !dynamic.is_subset(&present) {
            return Err(invalid(format!("{label} dynamic props must be present")));
        }
        let mut literal_names = HashSet::new();
        for literal in array(
            field(condition, "literalProps", "condition")?,
            "condition.literalProps",
        )? {
            let literal = object(literal, "literal prop")?;
            exact(literal, &["name", "value"], "literal prop")?;
            let name = text(field(literal, "name", "literal prop")?, "literal prop.name")?;
            if !present.contains(name)
                || !literal_names.insert(name)
                || !scalar(field(literal, "value", "literal prop")?)
            {
                return Err(invalid(format!("{label} literal prop")));
            }
        }
        if field(group, "reviewRequired", &label)?.as_bool() != Some(true) {
            return Err(invalid(format!("{label}.reviewRequired must be true")));
        }
        let usage_id_values = array(
            field(group, "usageIds", &label)?,
            &format!("{label}.usageIds"),
        )?;
        let usage_ids = string_set(
            field(group, "usageIds", &label)?,
            &format!("{label}.usageIds"),
        )?;
        if usage_ids.is_empty()
            || number(field(group, "count", &label)?, &format!("{label}.count"))? != usage_ids.len()
        {
            return Err(invalid(format!("{label} usage count")));
        }
        let mut expected_evidence = Vec::new();
        for usage_id in usage_id_values
            .iter()
            .map(|item| item.as_str().expect("usage IDs validated as strings"))
        {
            let usage = usages
                .get(usage_id)
                .ok_or_else(|| invalid(format!("{label} unknown usage")))?;
            if usage.source_id != source_id
                || usage.export != export
                || !grouped_usages.insert(usage_id.to_owned())
            {
                return Err(invalid(format!("{label} usage source/export/uniqueness")));
            }
            expected_evidence.extend(usage.evidence.clone());
        }
        let evidence = array(
            field(group, "evidence", &label)?,
            &format!("{label}.evidence"),
        )?;
        if evidence.iter().map(json_key).collect::<Result<Vec<_>>>()?
            != expected_evidence
                .iter()
                .map(json_key)
                .collect::<Result<Vec<_>>>()?
        {
            return Err(invalid(format!(
                "{label}.evidence must equal grouped usage evidence"
            )));
        }
        for (evidence_index, item) in evidence.iter().enumerate() {
            validate_evidence(
                item,
                cache,
                None,
                &format!("{label}.evidence[{evidence_index}]"),
            )?;
        }
        let change_ids = string_set(
            field(group, "contractChangeIds", &label)?,
            &format!("{label}.contractChangeIds"),
        )?;
        for change_id in &change_ids {
            let change = index
                .changes
                .get(change_id)
                .ok_or_else(|| invalid(format!("{label} unknown change")))?;
            let change = object(change, "change")?;
            let reference = serde_json::json!({"export":field(change,"export","change")?,"prop":change.get("prop")});
            let mut reference = reference;
            if change.get("prop").is_none() {
                reference.as_object_mut().expect("object").remove("prop");
            }
            if !ref_matches_group(&reference, export, condition)? {
                return Err(invalid(format!("{label} change predicate mismatch")));
            }
        }
        let expected_change_ids = index
            .changes
            .iter()
            .filter_map(|(id, change)| {
                let change = change.as_object()?;
                let export_value = change.get("export")?;
                let mut reference = serde_json::json!({"export":export_value});
                if let Some(prop) = change.get("prop") {
                    reference["prop"] = prop.clone();
                }
                ref_matches_group(&reference, export, condition)
                    .ok()
                    .filter(|matches| *matches)
                    .map(|_| id.clone())
            })
            .collect::<HashSet<_>>();
        if change_ids != expected_change_ids {
            return Err(invalid(format!("{label}.contractChangeIds is incomplete")));
        }
        let proposal_ids = string_set(
            field(group, "proposalIds", &label)?,
            &format!("{label}.proposalIds"),
        )?;
        let mut expected_targets = Vec::new();
        let mut targets_by_predicate: HashMap<String, HashSet<String>> = HashMap::new();
        for proposal_id in &proposal_ids {
            let proposal = index
                .proposals
                .get(proposal_id)
                .ok_or_else(|| invalid(format!("{label} unknown proposal")))?;
            let proposal_map = object(proposal, "proposal")?;
            let proposal_source = field(proposal_map, "source", "proposal")?;
            if !ref_matches_group(proposal_source, export, condition)? {
                return Err(invalid(format!("{label} proposal predicate mismatch")));
            }
            let targets = proposal_targets(proposal)?;
            let predicate_targets = targets_by_predicate
                .entry(json_key(proposal_source)?)
                .or_default();
            for target in &targets {
                predicate_targets.insert(json_key(target)?);
            }
            expected_targets.extend(targets);
        }
        let expected_proposal_ids = index
            .proposals
            .iter()
            .filter_map(|(id, proposal)| {
                let source = proposal.get("source")?;
                ref_matches_group(source, export, condition)
                    .ok()
                    .filter(|matches| *matches)
                    .map(|_| id.clone())
            })
            .collect::<HashSet<_>>();
        if proposal_ids != expected_proposal_ids {
            return Err(invalid(format!("{label}.proposalIds is incomplete")));
        }
        let mut expected_keys = expected_targets
            .iter()
            .filter(|item| item.get("export").is_some())
            .map(json_key)
            .collect::<Result<Vec<_>>>()?;
        expected_keys.sort();
        expected_keys.dedup();
        let candidates = array(
            field(group, "candidateTargets", &label)?,
            &format!("{label}.candidateTargets"),
        )?;
        let mut actual_keys = candidates
            .iter()
            .map(json_key)
            .collect::<Result<Vec<_>>>()?;
        actual_keys.sort();
        actual_keys.dedup();
        if actual_keys != expected_keys || actual_keys.len() != candidates.len() {
            return Err(invalid(format!("{label}.candidateTargets mismatch")));
        }
        let component_targets: HashSet<String> = candidates
            .iter()
            .filter_map(|item| {
                item.get("export")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect();
        let target = field(group, "target", &label)?;
        let has_spread = field(condition, "hasSpread", "condition")?
            .as_bool()
            .ok_or_else(|| invalid(format!("{label}.condition.hasSpread")))?;
        let conflicting_targets = targets_by_predicate
            .values()
            .any(|targets| targets.len() > 1);
        let expected_route = if !has_spread
            && dynamic.is_empty()
            && component_targets.len() == 1
            && !conflicting_targets
        {
            "mapping-to-review"
        } else {
            "decision-required"
        };
        if expected_route == "mapping-to-review" {
            let target_map = object(target, &format!("{label}.target"))?;
            exact(target_map, &["export"], &format!("{label}.target"))?;
            if component_targets.len() != 1
                || !component_targets.contains(text(
                    field(target_map, "export", "target")?,
                    "target.export",
                )?)
            {
                return Err(invalid(format!("{label}.target mismatch")));
            }
        } else if !target.is_null() {
            return Err(invalid(format!(
                "{label}.target must be null for decision-required"
            )));
        }
        let route = text(field(group, "route", &label)?, &format!("{label}.route"))?;
        if route != expected_route {
            return Err(invalid(format!("{label}.route")));
        }
        string_set(
            field(group, "candidateOwners", &label)?,
            &format!("{label}.candidateOwners"),
        )?;
        let representative = object(
            field(group, "representative", &label)?,
            &format!("{label}.representative"),
        )?;
        exact(
            representative,
            &["file", "line", "column"],
            &format!("{label}.representative"),
        )?;
        let representative_matches =
            usage_ids
                .iter()
                .filter_map(|id| usages.get(id))
                .any(|usage| {
                    representative.get("file").and_then(Value::as_str)
                        == usage.evidence[0].get("file").and_then(Value::as_str)
                        && representative.get("line").and_then(Value::as_u64)
                            == Some(usage.location.line as u64)
                        && representative.get("column").and_then(Value::as_u64)
                            == Some(usage.location.column as u64)
                });
        if !representative_matches
            || groups
                .insert(
                    id.to_owned(),
                    (
                        usage_ids,
                        string_set(field(group, "candidateOwners", &label)?, "candidateOwners")?,
                        expected_route.to_owned(),
                    ),
                )
                .is_some()
        {
            return Err(invalid(format!("{label} representative/identity")));
        }
    }
    if grouped_usages != usages.keys().cloned().collect() {
        return Err(invalid("every usage must appear in exactly one group"));
    }
    let mut decisions = HashSet::new();
    for (index, value) in array(decisions_value, "decisionsRequired")?
        .iter()
        .enumerate()
    {
        let label = format!("decisionsRequired[{index}]");
        let decision = object(value, &label)?;
        exact(
            decision,
            &[
                "id",
                "groupId",
                "kind",
                "reason",
                "usageIds",
                "candidateOwners",
                "ownerStatus",
                "status",
                "preconditions",
                "requiredChecks",
            ],
            &label,
        )?;
        text(field(decision, "id", &label)?, &format!("{label}.id"))?;
        let group_id = text(
            field(decision, "groupId", &label)?,
            &format!("{label}.groupId"),
        )?;
        let (group_usage, group_owners, group_route) = groups
            .get(group_id)
            .ok_or_else(|| invalid(format!("{label}.groupId")))?;
        if !decisions.insert(group_id.to_owned())
            || field(decision, "status", &label)?.as_str() != Some("needs-review")
            || !["review-documented-mapping", "choose-migration-target"].contains(&text(
                field(decision, "kind", &label)?,
                &format!("{label}.kind"),
            )?)
            || string_set(
                field(decision, "usageIds", &label)?,
                &format!("{label}.usageIds"),
            )? != *group_usage
            || string_set(
                field(decision, "candidateOwners", &label)?,
                &format!("{label}.candidateOwners"),
            )? != *group_owners
            || (group_route == "mapping-to-review"
                && field(decision, "kind", &label)?.as_str() != Some("review-documented-mapping"))
            || (group_route == "decision-required"
                && field(decision, "kind", &label)?.as_str() != Some("choose-migration-target"))
        {
            return Err(invalid(format!("{label} group/status mismatch")));
        }
        text(
            field(decision, "reason", &label)?,
            &format!("{label}.reason"),
        )?;
        let owner_status = text(
            field(decision, "ownerStatus", &label)?,
            &format!("{label}.ownerStatus"),
        )?;
        if (group_owners.is_empty() && owner_status != "unassigned")
            || (!group_owners.is_empty() && owner_status != "candidate")
        {
            return Err(invalid(format!("{label}.ownerStatus")));
        }
        let preconditions = array(
            field(decision, "preconditions", &label)?,
            &format!("{label}.preconditions"),
        )?;
        if preconditions.is_empty()
            || preconditions
                .iter()
                .any(|item| item.as_str().is_none_or(str::is_empty))
        {
            return Err(invalid(format!("{label}.preconditions")));
        }
        if !array(
            field(decision, "requiredChecks", &label)?,
            &format!("{label}.requiredChecks"),
        )?
        .is_empty()
        {
            return Err(invalid(format!("{label}.requiredChecks must remain unset")));
        }
    }
    if decisions != groups.keys().cloned().collect() {
        return Err(invalid("one decision per group required"));
    }
    Ok(())
}

fn validate_verification(value: &Value, repository: &Map<String, Value>) -> Result<()> {
    let declared: HashSet<(String, String)> = array(
        field(repository, "declaredScripts", "repository")?,
        "declaredScripts",
    )?
    .iter()
    .filter_map(|item| {
        Some((
            item.get("manifest")?.as_str()?.to_owned(),
            item.get("name")?.as_str()?.to_owned(),
        ))
    })
    .collect();
    let ci: HashSet<String> = array(field(repository, "ciEvidence", "repository")?, "ciEvidence")?
        .iter()
        .filter_map(|item| item.get("file")?.as_str().map(str::to_owned))
        .collect();
    let mut seen = HashSet::new();
    for (index, candidate) in array(value, "verificationCandidates")?.iter().enumerate() {
        let label = format!("verificationCandidates[{index}]");
        let candidate = object(candidate, &label)?;
        let category = text(
            field(candidate, "category", &label)?,
            &format!("{label}.category"),
        )?;
        let status = text(
            field(candidate, "status", &label)?,
            &format!("{label}.status"),
        )?;
        if ![
            "test",
            "build",
            "quality",
            "typecheck",
            "storybook",
            "ci",
            "other",
        ]
        .contains(&category)
            || !["declared-not-run", "missing"].contains(&status)
        {
            return Err(invalid(format!("{label} category/status")));
        }
        if status == "missing" {
            exact(candidate, &["category", "status"], &label)?;
        } else if category == "ci" {
            exact(candidate, &["category", "ciFile", "status"], &label)?;
            if !ci.contains(text(
                field(candidate, "ciFile", &label)?,
                &format!("{label}.ciFile"),
            )?) {
                return Err(invalid(format!("{label} undeclared CI file")));
            }
        } else {
            exact(
                candidate,
                &["category", "manifest", "script", "status"],
                &label,
            )?;
            let key = (
                text(
                    field(candidate, "manifest", &label)?,
                    &format!("{label}.manifest"),
                )?
                .to_owned(),
                text(
                    field(candidate, "script", &label)?,
                    &format!("{label}.script"),
                )?
                .to_owned(),
            );
            if !declared.contains(&key) {
                return Err(invalid(format!("{label} undeclared script")));
            }
        }
        if !seen.insert(json_key(&Value::Object(candidate.clone()))?) {
            return Err(invalid("duplicate verification candidate"));
        }
    }
    let mut expected = Vec::new();
    for item in array(
        field(repository, "declaredScripts", "repository")?,
        "declaredScripts",
    )? {
        expected.push(serde_json::json!({
            "category":item.get("category").cloned().unwrap_or(Value::Null),
            "manifest":item.get("manifest").cloned().unwrap_or(Value::Null),
            "script":item.get("name").cloned().unwrap_or(Value::Null),
            "status":"declared-not-run"
        }));
    }
    for item in array(field(repository, "ciEvidence", "repository")?, "ciEvidence")? {
        expected.push(serde_json::json!({
            "category":"ci",
            "ciFile":item.get("file").cloned().unwrap_or(Value::Null),
            "status":"declared-not-run"
        }));
    }
    for category in ["test", "build", "quality", "typecheck", "storybook", "ci"] {
        if !expected
            .iter()
            .any(|item| item.get("category").and_then(Value::as_str) == Some(category))
        {
            expected.push(serde_json::json!({"category":category,"status":"missing"}));
        }
    }
    expected.sort_by(|left, right| {
        let key = |item: &Value| {
            (
                item.get("category")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                item.get("manifest")
                    .or_else(|| item.get("ciFile"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                item.get("script")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
            )
        };
        key(left).cmp(&key(right))
    });
    if value != &Value::Array(expected) {
        return Err(invalid(
            "verificationCandidates is incomplete or out of order",
        ));
    }
    Ok(())
}

pub fn validate_assessment(
    value: &Value,
    resolution: &Resolution,
    repository_guard: &RepositoryGuard,
    contracts: &[(String, String, Value)],
) -> Result<()> {
    if !repository_guard.unchanged()? {
        return Err(invalid("repository changed before assessment validation"));
    }
    let map = object(value, "assessment")?;
    exact(
        map,
        &[
            "schemaVersion",
            "kind",
            "status",
            "executable",
            "repository",
            "target",
            "sources",
            "usageInventory",
            "mappingGroups",
            "decisionsRequired",
            "verificationCandidates",
            "limitations",
        ],
        "assessment",
    )?;
    if field(map, "schemaVersion", "assessment")?.as_u64() != Some(1)
        || field(map, "kind", "assessment")?.as_str() != Some("consumer-migration-assessment")
        || field(map, "status", "assessment")?.as_str() != Some("draft-review")
        || field(map, "executable", "assessment")?.as_bool() != Some(false)
    {
        return Err(invalid("assessment header"));
    }
    let serialized = serde_json::to_string(value)?;
    if serialized.contains(&repository_guard.root.to_string_lossy().to_string())
        || resolution
            .sources
            .iter()
            .chain([&resolution.target])
            .any(|package| serialized.contains(&package.root))
    {
        return Err(invalid(
            "portable assessment contains an absolute input root",
        ));
    }
    let repository_value = field(map, "repository", "assessment")?;
    if repository_value != &repository_projection(&resolution.repository)? {
        return Err(invalid("portable repository projection mismatch"));
    }
    validate_repository(repository_value, resolution, repository_guard)?;
    validate_sources_target(map, resolution, contracts)?;
    let indexes = contract_indexes(contracts)?;
    let mut cache = EvidenceCache::new(repository_guard);
    let (usages, _) = validate_usage_inventory(
        field(map, "usageInventory", "assessment")?,
        resolution,
        &mut cache,
    )?;
    validate_groups_decisions(
        field(map, "mappingGroups", "assessment")?,
        field(map, "decisionsRequired", "assessment")?,
        &usages,
        &indexes,
        &mut cache,
    )?;
    let repository = object(
        field(map, "repository", "assessment")?,
        "assessment.repository",
    )?;
    validate_verification(
        field(map, "verificationCandidates", "assessment")?,
        repository,
    )?;
    let limitations = array(field(map, "limitations", "assessment")?, "limitations")?;
    if limitations.is_empty()
        || limitations
            .iter()
            .any(|item| item.as_str().is_none_or(str::is_empty))
    {
        return Err(invalid("assessment limitations"));
    }
    if !repository_guard.unchanged()? {
        return Err(invalid("repository changed during assessment validation"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // End-to-end assessment validation and adversarial worker fixtures exercise this public validator.
    // Local units cover shape checks that do not require constructing private Resolution fields.
    use super::*;
    use serde_json::json;

    #[test]
    fn scalar_and_relative_guards_are_strict() {
        assert!(scalar(&json!(2)));
        assert!(scalar(&json!("2")));
        assert!(!scalar(&json!({"value":2})));
        assert!(relative("packages/app/src/App.tsx"));
        assert!(!relative("../secret"));
        assert!(!relative("/absolute"));
    }

    #[test]
    fn exact_shape_rejects_false_approval_fields() {
        let value = json!({"status":"needs-review","approved":true});
        let map = value.as_object().expect("object");
        assert!(exact(map, &["status"], "decision").is_err());
    }

    #[test]
    fn condition_value_matching_distinguishes_number_and_string() {
        let condition = json!({"literalProps":[{"name":"count","value":2}],"presentProps":["count"],"hasSpread":false,"dynamicProps":[]});
        let map = condition.as_object().expect("condition");
        assert!(
            ref_matches_group(
                &json!({"export":"Button","prop":"count","value":2}),
                "Button",
                map
            )
            .expect("match")
        );
        assert!(
            !ref_matches_group(
                &json!({"export":"Button","prop":"count","value":"2"}),
                "Button",
                map
            )
            .expect("mismatch")
        );
    }
}
