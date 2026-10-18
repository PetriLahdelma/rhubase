use crate::{
    error::{AppError, Result},
    paths::{self, DirectoryTarget, TreeGuard},
    protocol,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    path::Path,
};

const ID_MAX: usize = 64;
fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(format!("invalid composition project: {}", message.into()))
}
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= ID_MAX
        && value.as_bytes()[0].is_ascii_alphabetic()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
fn package_part(value: &str) -> bool {
    !value.is_empty()
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}
fn package_name(value: &str) -> bool {
    if value.is_empty() || value.len() > 200 {
        return false;
    }
    if let Some(scoped) = value.strip_prefix('@') {
        let Some((scope, name)) = scoped.split_once('/') else {
            return false;
        };
        !name.contains('/') && package_part(scope) && package_part(name)
    } else {
        !value.contains('/') && package_part(value)
    }
}
fn workspace_names(value: &str) -> Vec<String> {
    let (prefix, base) = if let Some(scoped) = value.strip_prefix('@') {
        let (scope, name) = scoped.split_once('/').expect("validated scoped package");
        (format!("@{scope}/"), name)
    } else {
        (String::new(), value)
    };
    ["components", "tokens", "themes"]
        .map(|role| format!("{prefix}{base}-{role}"))
        .to_vec()
}
fn text(value: &str, label: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 1024
        || value
            .chars()
            .any(|c| c == '\0' || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
    {
        Err(invalid(format!(
            "{label} is empty, too long, or contains unsafe control text"
        )))
    } else {
        Ok(())
    }
}
fn unique<'a>(values: impl IntoIterator<Item = &'a str>, label: &str) -> Result<()> {
    let mut seen = HashSet::new();
    for value in values {
        if !seen.insert(value) {
            return Err(invalid(format!("duplicate {label} `{value}`")));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub schema_version: u32,
    pub kind: String,
    pub title: String,
    pub sources: Vec<ProjectSource>,
    pub scenarios: Vec<Scenario>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSource {
    pub id: String,
    pub digest: Option<String>,
    pub declared_modes: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scenario {
    pub id: String,
    pub title: String,
    pub included_sources: Vec<String>,
    pub target: Target,
    pub selections: Vec<Selection>,
    pub dependencies: Vec<Dependency>,
    pub architecture: Architecture,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub name: String,
    pub mode: String,
    pub base_source: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub id: String,
    pub source: String,
    pub kind: String,
    pub name: String,
    pub target_name: String,
    pub disposition: String,
    pub rationale: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dependency {
    pub from: String,
    pub to: String,
    pub rationale: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Architecture {
    pub layout: String,
    pub topology: String,
    pub delivery: String,
    pub delivery_source: Option<String>,
}

pub fn read_project(path: &Path) -> Result<Project> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| invalid(format!("project file unavailable: {error}")))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 1024 * 1024 {
        return Err(invalid("project must be a real file no larger than 1 MiB"));
    }
    let bytes = fs::read(path)?;
    let value = protocol::decode_strict_json(&bytes, "composition project JSON")?;
    validate_project_shape(&value)?;
    let project: Project =
        serde_json::from_value(value).map_err(|error| invalid(error.to_string()))?;
    validate_project(&project)?;
    Ok(project)
}
fn required_object<'a>(
    value: &'a Value,
    fields: &[&str],
    label: &str,
) -> Result<&'a serde_json::Map<String, Value>> {
    let map = value
        .as_object()
        .ok_or_else(|| invalid(format!("{label} must be an object")))?;
    if map.len() != fields.len() || !fields.iter().all(|field| map.contains_key(*field)) {
        return Err(invalid(format!("{label} has unexpected or missing fields")));
    }
    Ok(map)
}
fn required_array<'a>(value: &'a Value, label: &str) -> Result<&'a Vec<Value>> {
    value
        .as_array()
        .ok_or_else(|| invalid(format!("{label} must be an array")))
}
fn validate_project_shape(value: &Value) -> Result<()> {
    let project = required_object(
        value,
        &["schemaVersion", "kind", "title", "sources", "scenarios"],
        "project",
    )?;
    for source in required_array(&project["sources"], "project.sources")? {
        required_object(source, &["id", "digest", "declaredModes"], "project source")?;
    }
    for scenario in required_array(&project["scenarios"], "project.scenarios")? {
        let scenario = required_object(
            scenario,
            &[
                "id",
                "title",
                "includedSources",
                "target",
                "selections",
                "dependencies",
                "architecture",
            ],
            "scenario",
        )?;
        required_object(
            &scenario["target"],
            &["name", "mode", "baseSource"],
            "scenario target",
        )?;
        for selection in required_array(&scenario["selections"], "scenario.selections")? {
            required_object(
                selection,
                &[
                    "id",
                    "source",
                    "kind",
                    "name",
                    "targetName",
                    "disposition",
                    "rationale",
                ],
                "selection",
            )?;
        }
        for dependency in required_array(&scenario["dependencies"], "scenario.dependencies")? {
            required_object(dependency, &["from", "to", "rationale"], "dependency")?;
        }
        required_object(
            &scenario["architecture"],
            &["layout", "topology", "delivery", "deliverySource"],
            "architecture",
        )?;
    }
    Ok(())
}
pub fn validate_project(project: &Project) -> Result<()> {
    if project.schema_version != 1 || project.kind != "rhubase-composition-project" {
        return Err(invalid(
            "header must be schemaVersion 1 and kind rhubase-composition-project",
        ));
    }
    text(&project.title, "title")?;
    if !(2..=8).contains(&project.sources.len()) || !(1..=16).contains(&project.scenarios.len()) {
        return Err(invalid("project requires 2–8 sources and 1–16 scenarios"));
    }
    unique(
        project.sources.iter().map(|source| source.id.as_str()),
        "source ID",
    )?;
    let catalog: HashSet<_> = project
        .sources
        .iter()
        .map(|source| source.id.as_str())
        .collect();
    for source in &project.sources {
        if !id(&source.id) {
            return Err(invalid("source ID format"));
        }
        if source.declared_modes.len() > 16 {
            return Err(invalid("a source declares more than 16 modes"));
        }
        unique(
            source.declared_modes.iter().map(String::as_str),
            "declared mode",
        )?;
        for mode in &source.declared_modes {
            text(mode, "declared mode")?;
        }
        if let Some(digest) = &source.digest
            && (digest.len() != 64
                || !digest
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
        {
            return Err(invalid("source digest must be lowercase SHA-256 or null"));
        }
    }
    unique(
        project
            .scenarios
            .iter()
            .map(|scenario| scenario.id.as_str()),
        "scenario ID",
    )?;
    for scenario in &project.scenarios {
        if !id(&scenario.id) {
            return Err(invalid("scenario ID format"));
        }
        text(&scenario.title, "scenario title")?;
        if scenario.included_sources.len() < 2
            || scenario.included_sources.len() > project.sources.len()
        {
            return Err(invalid(
                "scenario must include at least two catalog sources",
            ));
        }
        unique(
            scenario.included_sources.iter().map(String::as_str),
            "included source",
        )?;
        if scenario
            .included_sources
            .iter()
            .any(|source| !catalog.contains(source.as_str()))
        {
            return Err(invalid("scenario includes unknown source"));
        }
        if !package_name(&scenario.target.name) {
            return Err(invalid(
                "target name must be a lowercase npm-style package identity",
            ));
        }
        match scenario.target.mode.as_str() {
            "new" if scenario.target.base_source.is_none() => {}
            "evolve"
                if scenario
                    .target
                    .base_source
                    .as_ref()
                    .is_some_and(|source| scenario.included_sources.contains(source)) => {}
            "new" | "evolve" => {
                return Err(invalid("target baseSource does not match target mode"));
            }
            _ => return Err(invalid("target mode must be new or evolve")),
        }
        if scenario.selections.len() > 256 || scenario.dependencies.len() > 512 {
            return Err(invalid("scenario selection or dependency bound exceeded"));
        }
        unique(
            scenario
                .selections
                .iter()
                .map(|selection| selection.id.as_str()),
            "selection ID",
        )?;
        for selection in &scenario.selections {
            if !id(&selection.id) || !scenario.included_sources.contains(&selection.source) {
                return Err(invalid("selection identity or source"));
            }
            if !matches!(selection.kind.as_str(), "component" | "token" | "mode") {
                return Err(invalid("selection kind"));
            }
            if !matches!(
                selection.disposition.as_str(),
                "retain" | "adapt" | "exclude" | "defer"
            ) {
                return Err(invalid(
                    "unsupported disposition; combine, replace, and generation are not available in this profile",
                ));
            }
            text(&selection.name, "selection name")?;
            text(&selection.target_name, "selection targetName")?;
            text(&selection.rationale, "selection rationale")?;
        }
        let selections: HashSet<_> = scenario
            .selections
            .iter()
            .map(|selection| selection.id.as_str())
            .collect();
        for edge in &scenario.dependencies {
            if !selections.contains(edge.from.as_str()) {
                return Err(invalid("dependency from must name a selection"));
            }
            if !id(&edge.to) {
                return Err(invalid(
                    "dependency to must be a valid selection identifier",
                ));
            }
            text(&edge.rationale, "dependency rationale")?;
        }
        if !matches!(
            scenario.architecture.layout.as_str(),
            "colocated" | "by-kind"
        ) || !matches!(
            scenario.architecture.topology.as_str(),
            "single-package" | "workspace"
        ) || !matches!(
            scenario.architecture.delivery.as_str(),
            "minimal" | "preserve"
        ) {
            return Err(invalid("unsupported architecture option"));
        }
        match scenario.architecture.delivery.as_str() {
            "minimal" if scenario.architecture.delivery_source.is_none() => {}
            "preserve"
                if scenario
                    .architecture
                    .delivery_source
                    .as_ref()
                    .is_some_and(|source| scenario.included_sources.contains(source)) => {}
            _ => return Err(invalid("deliverySource does not match delivery mode")),
        }
    }
    Ok(())
}

pub struct SourceFacts<'a> {
    pub project: &'a ProjectSource,
    pub guard: &'a TreeGuard,
    pub snapshot: &'a Value,
}
fn object<'a>(value: &'a Value, label: &str) -> Result<&'a serde_json::Map<String, Value>> {
    value.as_object().ok_or_else(|| {
        AppError::new(format!(
            "invalid composition extraction: {label} must be an object"
        ))
    })
}
fn array<'a>(value: &'a Value, label: &str) -> Result<&'a Vec<Value>> {
    value.as_array().ok_or_else(|| {
        AppError::new(format!(
            "invalid composition extraction: {label} must be an array"
        ))
    })
}
fn exact(map: &serde_json::Map<String, Value>, allowed: &[&str], label: &str) -> Result<()> {
    if map.len() != allowed.len() || !allowed.iter().all(|field| map.contains_key(*field)) {
        Err(AppError::new(format!(
            "invalid composition extraction: {label} fields"
        )))
    } else {
        Ok(())
    }
}
fn evidence_record(value: &Value, guard: &TreeGuard) -> Result<()> {
    let map = object(value, "evidence")?;
    exact(
        map,
        &["file", "sha256", "startLine", "endLine", "quote"],
        "evidence",
    )?;
    let file = map["file"]
        .as_str()
        .ok_or_else(|| AppError::new("invalid composition evidence file"))?;
    let digest = map["sha256"]
        .as_str()
        .ok_or_else(|| AppError::new("invalid composition evidence digest"))?;
    let start = map["startLine"]
        .as_u64()
        .ok_or_else(|| AppError::new("invalid composition evidence range"))?;
    let end = map["endLine"]
        .as_u64()
        .ok_or_else(|| AppError::new("invalid composition evidence range"))?;
    let quote = map["quote"]
        .as_str()
        .ok_or_else(|| AppError::new("invalid composition evidence quote"))?;
    let (body, actual) = guard.evidence_text(file)?;
    let line_number = |offset: usize| {
        body[..offset.min(body.len())]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count() as u64
            + 1
    };
    let exact_quote = !quote.is_empty()
        && body.match_indices(quote).any(|(offset, matched)| {
            line_number(offset) == start && line_number(offset + matched.len()) == end
        });
    if actual != digest || start == 0 || end < start || !exact_quote {
        return Err(AppError::new(
            "invalid composition extraction: forged source evidence",
        ));
    }
    Ok(())
}
fn evidence(value: &Value, guard: &TreeGuard) -> Result<()> {
    let map = object(value, "source fact")?;
    let items = array(
        map.get("evidence")
            .ok_or_else(|| AppError::new("invalid composition extraction: evidence required"))?,
        "evidence",
    )?;
    if items.is_empty() {
        return Err(AppError::new(
            "invalid composition extraction: empty evidence",
        ));
    }
    for item in items {
        evidence_record(item, guard)?;
    }
    Ok(())
}
pub fn validate_extraction<'a>(
    value: &'a Value,
    project: &'a Project,
    guards: &'a BTreeMap<String, TreeGuard>,
) -> Result<Vec<SourceFacts<'a>>> {
    let root = object(value, "result")?;
    exact(root, &["schemaVersion", "kind", "sources"], "result")?;
    if root["schemaVersion"] != 1 || root["kind"] != "rhubase-composition-extraction" {
        return Err(AppError::new("invalid composition extraction header"));
    }
    let sources = array(&root["sources"], "sources")?;
    if sources.len() != project.sources.len() {
        return Err(AppError::new(
            "composition extraction source count mismatch",
        ));
    }
    let mut found = HashMap::new();
    for source in sources {
        let map = object(source, "source")?;
        exact(map, &["id", "snapshot"], "source")?;
        let id = map["id"]
            .as_str()
            .ok_or_else(|| AppError::new("invalid composition source ID"))?;
        if found.insert(id, &map["snapshot"]).is_some() {
            return Err(AppError::new("duplicate composition source extraction"));
        }
    }
    let mut result = Vec::new();
    for source in &project.sources {
        let guard = guards
            .get(&source.id)
            .ok_or_else(|| AppError::new("composition source guard missing"))?;
        let snapshot = *found
            .get(source.id.as_str())
            .ok_or_else(|| AppError::new("composition source extraction missing"))?;
        let map = object(snapshot, "snapshot")?;
        exact(
            map,
            &["identity", "exports", "tokens", "coverage"],
            "snapshot",
        )?;
        let identity = object(&map["identity"], "identity")?;
        exact(identity, &["name", "version", "digest"], "identity")?;
        if identity.get("name").and_then(Value::as_str) != Some(&guard.package_name)
            || identity.get("version").and_then(Value::as_str) != Some(&guard.package_version)
            || identity.get("digest").and_then(Value::as_str) != Some(&guard.node_digest)
        {
            return Err(AppError::new(
                "composition source identity or digest mismatch",
            ));
        }
        let exports = array(&map["exports"], "snapshot.exports")?;
        let tokens = array(&map["tokens"], "snapshot.tokens")?;
        let coverage = object(&map["coverage"], "snapshot.coverage")?;
        exact(
            coverage,
            &[
                "componentsUnsupported",
                "tokensUnsupported",
                "excludedFiles",
            ],
            "snapshot.coverage",
        )?;
        if exports.len() > 10_000 || tokens.len() > 10_000 {
            return Err(AppError::new(
                "invalid composition extraction: source fact bounds exceeded",
            ));
        }
        for item in exports {
            evidence(item, guard)?;
            let item = object(item, "export")?;
            exact(
                item,
                &["name", "entrypoint", "kind", "incomplete", "evidence"],
                "export",
            )?;
            let name = item["name"].as_str().unwrap_or_default();
            if name.is_empty()
                || name.len() > 1024
                || !item["entrypoint"].is_string()
                || !item["incomplete"].is_boolean()
                || !matches!(
                    item["kind"].as_str(),
                    Some("component" | "type" | "function" | "class" | "value")
                )
            {
                return Err(AppError::new(
                    "invalid composition extraction: export fact shape",
                ));
            }
        }
        for item in tokens {
            evidence(item, guard)?;
            let item = object(item, "token")?;
            exact(item, &["name", "value", "evidence"], "token")?;
            let name = item["name"].as_str().unwrap_or_default();
            if name.is_empty() || name.len() > 1024 {
                return Err(AppError::new(
                    "invalid composition extraction: token fact shape",
                ));
            }
        }
        for key in ["componentsUnsupported", "tokensUnsupported"] {
            if coverage[key].as_u64().is_none_or(|count| count > 10_000) {
                return Err(AppError::new(
                    "invalid composition extraction: coverage count",
                ));
            }
        }
        let excluded = array(&coverage["excludedFiles"], "coverage.excludedFiles")?;
        if excluded.len() > 10_000 {
            return Err(AppError::new(
                "invalid composition extraction: excluded file bound",
            ));
        }
        for item in excluded {
            let item = object(item, "excluded file")?;
            exact(item, &["file", "reason"], "excluded file")?;
            if !item["file"].is_string() || !item["reason"].is_string() {
                return Err(AppError::new(
                    "invalid composition extraction: excluded file shape",
                ));
            }
        }
        if let Some(pin) = &source.digest
            && pin != &guard.node_digest
        {
            return Err(AppError::new(format!(
                "stale composition source pin: {}",
                source.id
            )));
        }
        result.push(SourceFacts {
            project: source,
            guard,
            snapshot,
        });
    }
    Ok(result)
}

fn active(selection: &Selection) -> bool {
    matches!(selection.disposition.as_str(), "retain" | "adapt")
}
fn cycle(nodes: &[String], edges: &[(String, String)]) -> bool {
    fn visit(
        node: &str,
        edges: &[(String, String)],
        seen: &mut HashSet<String>,
        stack: &mut HashSet<String>,
    ) -> bool {
        if stack.contains(node) {
            return true;
        }
        if !seen.insert(node.to_owned()) {
            return false;
        }
        stack.insert(node.to_owned());
        for (_, to) in edges.iter().filter(|(from, _)| from == node) {
            if visit(to, edges, seen, stack) {
                return true;
            }
        }
        stack.remove(node);
        false
    }
    let mut seen = HashSet::new();
    let mut stack = HashSet::new();
    nodes
        .iter()
        .any(|node| visit(node, edges, &mut seen, &mut stack))
}
fn snapshot_items<'a>(facts: &'a SourceFacts<'_>, key: &str) -> &'a Vec<Value> {
    facts
        .snapshot
        .get(key)
        .and_then(Value::as_array)
        .expect("validated snapshot array")
}
fn find_item<'a>(facts: &'a SourceFacts<'_>, kind: &str, name: &str) -> Option<&'a Value> {
    match kind {
        "component" => snapshot_items(facts, "exports").iter().find(|item| {
            item.get("name").and_then(Value::as_str) == Some(name)
                && item.get("kind").and_then(Value::as_str) == Some("component")
        }),
        "token" => snapshot_items(facts, "tokens")
            .iter()
            .find(|item| item.get("name").and_then(Value::as_str) == Some(name)),
        "mode" => None,
        _ => None,
    }
}
fn item_count(facts: &SourceFacts<'_>, kind: &str, name: &str) -> usize {
    match kind {
        "component" => snapshot_items(facts, "exports")
            .iter()
            .filter(|item| {
                item.get("name").and_then(Value::as_str) == Some(name)
                    && item.get("kind").and_then(Value::as_str) == Some("component")
            })
            .count(),
        "token" => snapshot_items(facts, "tokens")
            .iter()
            .filter(|item| item.get("name").and_then(Value::as_str) == Some(name))
            .count(),
        _ => 0,
    }
}
fn static_evidence_refs(items: impl IntoIterator<Item = Value>, source_id: &str) -> Vec<Value> {
    items
        .into_iter()
        .flat_map(|item| {
            item.get("evidence")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .take(16)
        .map(|item| {
            json!({
                "kind":"static-source",
                "sourceId":source_id,
                "file":item["file"],
                "sha256":item["sha256"],
                "startLine":item["startLine"],
                "endLine":item["endLine"]
            })
        })
        .collect()
}
fn capability_catalog(facts: &SourceFacts<'_>, project_revision: &str) -> Vec<Value> {
    let mut grouped: BTreeMap<(String, String), Vec<Value>> = BTreeMap::new();
    for item in snapshot_items(facts, "exports")
        .iter()
        .filter(|item| item.get("kind").and_then(Value::as_str) == Some("component"))
    {
        if let Some(name) = item.get("name").and_then(Value::as_str) {
            grouped
                .entry(("component".into(), name.into()))
                .or_default()
                .push(item.clone());
        }
    }
    for item in snapshot_items(facts, "tokens") {
        if let Some(name) = item.get("name").and_then(Value::as_str) {
            grouped
                .entry(("token".into(), name.into()))
                .or_default()
                .push(item.clone());
        }
    }
    let mut result = grouped
        .into_iter()
        .map(|((kind, name), items)| {
            let unsupported = items.len() != 1
                || items.iter().any(|item| {
                    item.get("incomplete")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                });
            let evidence_refs = static_evidence_refs(items, &facts.project.id);
            json!({"kind":kind,"name":name,"status":if unsupported {"unsupported"} else {"observed"},"evidenceRefs":evidence_refs})
        })
        .collect::<Vec<_>>();
    result.extend(facts.project.declared_modes.iter().map(|name| {
        json!({"kind":"mode","name":name,"status":"human-declared","evidenceRefs":[{"kind":"human-declaration","sourceId":facts.project.id,"projectRevision":project_revision}]})
    }));
    result.sort_by(|left, right| {
        left["kind"]
            .as_str()
            .cmp(&right["kind"].as_str())
            .then_with(|| left["name"].as_str().cmp(&right["name"].as_str()))
    });
    result
}
fn sorted_difference<T>(left: &[T], right: &[T]) -> Result<Vec<Value>>
where
    T: Serialize,
{
    let left = left
        .iter()
        .map(serde_json::to_value)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let right = right
        .iter()
        .map(serde_json::to_value)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut difference = left
        .into_iter()
        .filter(|item| !right.contains(item))
        .collect::<Vec<_>>();
    difference.sort_by_key(|item| serde_json::to_string(item).unwrap_or_default());
    Ok(difference)
}
fn scenario_comparisons(project: &Project, scenarios: &[Value]) -> Result<Vec<Value>> {
    let Some(baseline) = project.scenarios.first() else {
        return Ok(Vec::new());
    };
    let blocker_count = |index: usize| scenarios[index]["blockers"].as_array().map_or(0, Vec::len);
    let baseline_sources = baseline
        .included_sources
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let baseline_selections = baseline
        .selections
        .iter()
        .map(|selection| (selection.id.as_str(), selection))
        .collect::<BTreeMap<_, _>>();
    let mut result = Vec::new();
    for (index, scenario) in project.scenarios.iter().enumerate().skip(1) {
        let sources = scenario
            .included_sources
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        let added_sources = sources
            .difference(&baseline_sources)
            .cloned()
            .collect::<Vec<_>>();
        let removed_sources = baseline_sources
            .difference(&sources)
            .cloned()
            .collect::<Vec<_>>();
        let selections = scenario
            .selections
            .iter()
            .map(|selection| (selection.id.as_str(), selection))
            .collect::<BTreeMap<_, _>>();
        let ids = baseline_selections
            .keys()
            .chain(selections.keys())
            .copied()
            .collect::<BTreeSet<_>>();
        let mut selection_changes = Vec::new();
        for id in ids {
            let before = baseline_selections.get(id).copied();
            let after = selections.get(id).copied();
            let before_value = before.map(serde_json::to_value).transpose()?;
            let after_value = after.map(serde_json::to_value).transpose()?;
            if before_value == after_value {
                continue;
            }
            let change = match (before, after) {
                (None, Some(_)) => "added",
                (Some(_), None) => "removed",
                _ => "changed",
            };
            selection_changes
                .push(json!({"id":id,"change":change,"before":before_value,"after":after_value}));
        }
        let architecture_fields = [
            (
                "layout",
                &baseline.architecture.layout,
                &scenario.architecture.layout,
            ),
            (
                "topology",
                &baseline.architecture.topology,
                &scenario.architecture.topology,
            ),
            (
                "delivery",
                &baseline.architecture.delivery,
                &scenario.architecture.delivery,
            ),
        ];
        let mut architecture_changes = architecture_fields
            .into_iter()
            .filter_map(|(field, before, after)| (before != after).then_some(field))
            .collect::<Vec<_>>();
        if baseline.architecture.delivery_source != scenario.architecture.delivery_source {
            architecture_changes.push("deliverySource");
        }
        result.push(json!({
            "baselineScenario":baseline.id,
            "scenario":scenario.id,
            "sourceChanges":{"added":added_sources,"removed":removed_sources},
            "targetChanged":serde_json::to_value(&baseline.target)? != serde_json::to_value(&scenario.target)?,
            "architectureChanges":architecture_changes,
            "selectionChanges":selection_changes,
            "dependencyChanges":{
                "added":sorted_difference(&scenario.dependencies,&baseline.dependencies)?,
                "removed":sorted_difference(&baseline.dependencies,&scenario.dependencies)?
            },
            "blockerCounts":{"before":blocker_count(0),"after":blocker_count(index)}
        }));
    }
    Ok(result)
}
fn limitation_list() -> Value {
    json!([
        "Declared modes are human inputs; component theme compatibility and mode values are unverified.",
        "Token alias coverage is limited to exact same-source {token.path} string aliases; other token semantics are unknown.",
        "Architecture previews and verification checks are proposals with status not-run.",
        "No consumer was supplied; consumer impact and retirement coverage are unmeasured.",
        "This experimental profile makes no DTCG conformance, runtime, visual, accessibility, build, generation, or migration claim."
    ])
}
pub fn build_blueprint(
    project: &Project,
    facts: &[SourceFacts<'_>],
) -> Result<(Project, Value, String)> {
    let mut pinned = project.clone();
    for source in &mut pinned.sources {
        source.digest = Some(
            facts
                .iter()
                .find(|facts| facts.project.id == source.id)
                .unwrap()
                .guard
                .node_digest
                .clone(),
        );
    }
    let project_revision = paths::sha256_bytes(&serde_json::to_vec(&pinned)?);
    let mut source_output = Vec::new();
    for facts in facts {
        let components = snapshot_items(facts, "exports")
            .iter()
            .filter(|item| {
                item.get("kind").and_then(Value::as_str) == Some("component")
                    && !item
                        .get("incomplete")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
            })
            .count();
        let tokens = snapshot_items(facts, "tokens").len();
        let selected_components = project
            .scenarios
            .iter()
            .flat_map(|s| &s.selections)
            .filter(|s| {
                s.source == facts.project.id
                    && s.kind == "component"
                    && active(s)
                    && item_count(facts, "component", &s.name) == 1
                    && find_item(facts, "component", &s.name).is_some_and(|item| {
                        !item
                            .get("incomplete")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                    })
            })
            .map(|s| s.name.clone())
            .collect::<BTreeSet<_>>()
            .len();
        let selected_tokens = project
            .scenarios
            .iter()
            .flat_map(|s| &s.selections)
            .filter(|s| {
                s.source == facts.project.id
                    && s.kind == "token"
                    && active(s)
                    && item_count(facts, "token", &s.name) == 1
            })
            .map(|s| s.name.clone())
            .collect::<BTreeSet<_>>()
            .len();
        let selected_modes = project
            .scenarios
            .iter()
            .flat_map(|s| &s.selections)
            .filter(|s| s.source == facts.project.id && s.kind == "mode" && active(s))
            .filter(|s| facts.project.declared_modes.contains(&s.name))
            .map(|s| s.name.clone())
            .collect::<BTreeSet<_>>();
        source_output.push(json!({"id":facts.project.id,"digest":facts.guard.node_digest,"identity":{"name":facts.guard.package_name,"version":facts.guard.package_version},"declaredModes":facts.project.declared_modes,"capabilities":capability_catalog(facts,&project_revision),"coverage":{"components":{"eligible":components,"selected":selected_components,"unsupported":facts.snapshot.pointer("/coverage/componentsUnsupported").and_then(Value::as_u64).unwrap_or(0)},"tokens":{"eligible":tokens,"selected":selected_tokens,"unsupported":facts.snapshot.pointer("/coverage/tokensUnsupported").and_then(Value::as_u64).unwrap_or(0)},"modes":{"declared":facts.project.declared_modes,"selected":selected_modes,"verified":false}}}));
    }
    let fact_map: HashMap<_, _> = facts
        .iter()
        .map(|facts| (facts.project.id.as_str(), facts))
        .collect();
    let mut scenarios = Vec::new();
    for scenario in &project.scenarios {
        let mut findings = Vec::new();
        let mut blockers = Vec::new();
        let mut unresolved = BTreeSet::new();
        let mut retained = [0usize; 3];
        let mut selection_output = Vec::new();
        for selection in &scenario.selections {
            let source = fact_map[selection.source.as_str()];
            let exists = if selection.kind == "mode" {
                source.project.declared_modes.contains(&selection.name)
            } else {
                item_count(source, &selection.kind, &selection.name) == 1
                    && find_item(source, &selection.kind, &selection.name).is_some_and(|item| {
                        !item
                            .get("incomplete")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                    })
            };
            if !exists {
                blockers.push(json!({"kind":"unsupported-selection","message":format!("{} `{}` is not established by the admitted source facts",selection.kind,selection.name),"selectionIds":[selection.id]}));
            }
            if active(selection) && exists {
                retained[match selection.kind.as_str() {
                    "component" => 0,
                    "token" => 1,
                    _ => 2,
                }] += 1;
            }
            if selection.disposition == "adapt" {
                unresolved.insert(format!(
                    "Adapt `{}` manually and verify the result.",
                    selection.id
                ));
            }
            if selection.kind == "mode" {
                findings.push(json!({"kind":"declared-mode","severity":"limitation","message":"Mode is a human declaration; component theme compatibility is unverified.","selectionIds":[selection.id]}));
            }
            let evidence_refs = if selection.kind == "mode" {
                vec![
                    json!({"kind":"human-declaration","sourceId":selection.source,"projectRevision":project_revision.clone()}),
                ]
            } else {
                find_item(source, &selection.kind, &selection.name)
                    .and_then(|item| item.get("evidence"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .take(16)
                    .map(|item| json!({"kind":"static-source","sourceId":selection.source,"file":item["file"],"sha256":item["sha256"],"startLine":item["startLine"],"endLine":item["endLine"]}))
                    .collect::<Vec<_>>()
            };
            let mut portable = serde_json::to_value(selection)?;
            portable
                .as_object_mut()
                .expect("selection serializes as object")
                .insert("evidenceRefs".into(), Value::Array(evidence_refs));
            selection_output.push(portable);
        }
        let by_id: HashMap<_, _> = scenario
            .selections
            .iter()
            .map(|selection| (selection.id.as_str(), selection))
            .collect();
        let mut dep_edges = Vec::new();
        for edge in &scenario.dependencies {
            if let Some(target) = by_id.get(edge.to.as_str()) {
                dep_edges.push((edge.from.clone(), edge.to.clone()));
                if !active(target) {
                    blockers.push(json!({"kind":"dependency-target-unavailable","message":format!("Dependency target `{}` is excluded or deferred",edge.to),"selectionIds":[edge.from,edge.to]}));
                }
            } else {
                blockers.push(json!({"kind":"dependency-target-unavailable","message":format!("Dependency target `{}` is missing",edge.to),"selectionIds":[edge.from]}));
            }
        }
        if cycle(
            &scenario
                .selections
                .iter()
                .map(|selection| selection.id.clone())
                .collect::<Vec<_>>(),
            &dep_edges,
        ) {
            blockers.push(json!({"kind":"dependency-cycle","message":"Human-declared dependency cycle requires an ordering decision.","selectionIds":[]}));
        }
        let mut token_edges = Vec::new();
        for selection in scenario
            .selections
            .iter()
            .filter(|selection| selection.kind == "token" && active(selection))
        {
            let source = fact_map[selection.source.as_str()];
            if let Some(value) = find_item(source, "token", &selection.name)
                .and_then(|item| item.get("value"))
                .and_then(Value::as_str)
            {
                if value.starts_with('{')
                    && value.ends_with('}')
                    && value.len() > 2
                    && value[1..value.len() - 1]
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
                {
                    let target = &value[1..value.len() - 1];
                    if let Some(other) = scenario.selections.iter().find(|other| {
                        other.source == selection.source
                            && other.kind == "token"
                            && other.name == target
                            && active(other)
                    }) {
                        token_edges.push((selection.id.clone(), other.id.clone()));
                    } else {
                        blockers.push(json!({"kind":"token-alias-unresolved","message":format!("Token alias `{value}` does not resolve to a retained/adapted token from the same source."),"selectionIds":[selection.id]}));
                    }
                } else if value.contains('{') || value.contains('}') {
                    findings.push(json!({"kind":"token-reference-unknown","severity":"limitation","message":"Token reference syntax is outside exact {token.path} coverage.","selectionIds":[selection.id]}));
                }
            }
        }
        if cycle(
            &scenario
                .selections
                .iter()
                .filter(|selection| selection.kind == "token")
                .map(|selection| selection.id.clone())
                .collect::<Vec<_>>(),
            &token_edges,
        ) {
            blockers.push(json!({"kind":"token-alias-cycle","message":"Selected same-source token aliases form a cycle.","selectionIds":[]}));
        }
        let mut targets = HashMap::new();
        for selection in scenario
            .selections
            .iter()
            .filter(|selection| active(selection))
        {
            let key = format!("{}:{}", selection.kind, selection.target_name);
            if let Some(previous) = targets.insert(key, selection.id.clone()) {
                blockers.push(json!({"kind":"target-name-conflict","message":format!("Multiple active {} selections use target name `{}`.",selection.kind,selection.target_name),"selectionIds":[previous,selection.id]}));
            }
        }
        if !blockers.is_empty() {
            unresolved
                .insert("Resolve blockers before treating this scenario as a viable plan.".into());
        }
        let slots = match scenario.architecture.layout.as_str() {
            "colocated" => vec!["foundation/"],
            _ => vec!["components/", "tokens/", "themes/"],
        };
        let packages = match scenario.architecture.topology.as_str() {
            "single-package" => vec![scenario.target.name.clone()],
            _ => workspace_names(&scenario.target.name),
        };
        let obligations = [
            ("imports", "Review proposed import boundaries."),
            ("public-exports", "Review proposed public exports."),
            ("css-assets", "Identify CSS and asset handling."),
            ("test-story-discovery", "Preserve test and story discovery."),
            ("build-types", "Verify build and type outputs."),
        ]
        .map(
            |(kind, description)| json!({"kind":kind,"status":"not-run","description":description}),
        );
        scenarios.push(json!({"id":scenario.id,"title":scenario.title,"includedSources":scenario.included_sources,"target":scenario.target,"selections":selection_output,"dependencies":scenario.dependencies,"retainedCounts":{"components":retained[0],"tokens":retained[1],"modes":retained[2]},"findings":findings,"blockers":blockers,"unresolvedManualWork":unresolved,"architecture":{"selection":scenario.architecture,"preview":{"layout":{"kind":scenario.architecture.layout,"slots":slots},"topology":{"kind":scenario.architecture.topology,"packages":packages},"delivery":{"kind":scenario.architecture.delivery,"source":scenario.architecture.delivery_source,"verificationRequired":true},"obligations":obligations}},"checks":obligations,"compatibility":"unverified"}));
    }
    let comparisons = scenario_comparisons(project, &scenarios)?;
    let blueprint = json!({"schemaVersion":1,"kind":"rhubase-composition-blueprint","status":"draft-review","executable":false,"consumerImpact":"unmeasured","projectRevision":project_revision,"title":project.title,"sources":source_output,"scenarios":scenarios,"comparisons":comparisons,"limitations":limitation_list()});
    let report = render_review(&blueprint)?;
    Ok((pinned, blueprint, report))
}
fn md(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if "\\`*_[]<>#".contains(c) {
                format!("\\{c}")
            } else if c.is_control() {
                " ".into()
            } else {
                c.to_string()
            }
        })
        .collect()
}
fn selection_summary(value: &Value) -> String {
    if value.is_null() {
        return "none".into();
    }
    format!(
        "{}/{} {} to {}; {}; rationale: {}",
        md(value["source"].as_str().unwrap_or("unknown")),
        md(value["kind"].as_str().unwrap_or("unknown")),
        md(value["name"].as_str().unwrap_or("unknown")),
        md(value["targetName"].as_str().unwrap_or("unknown")),
        md(value["disposition"].as_str().unwrap_or("unknown")),
        md(value["rationale"].as_str().unwrap_or("unspecified"))
    )
}
fn render_review(blueprint: &Value) -> Result<String> {
    let mut out = format!(
        "# {}\n\nDraft review · non-executable · consumer impact unmeasured\n\n",
        md(blueprint["title"]
            .as_str()
            .unwrap_or("Composition blueprint"))
    );
    out.push_str("## Source catalog\n\n");
    for source in blueprint["sources"].as_array().unwrap() {
        let identity = &source["identity"];
        out.push_str(&format!(
            "- {} — {} {} · digest {}\n",
            md(source["id"].as_str().unwrap_or("unknown")),
            md(identity["name"].as_str().unwrap_or("unknown")),
            md(identity["version"].as_str().unwrap_or("unknown")),
            md(source["digest"].as_str().unwrap_or("unknown"))
        ));
        out.push_str("  - Capability catalog:\n");
        for capability in source["capabilities"].as_array().into_iter().flatten() {
            out.push_str(&format!(
                "    - {} {} — {}\n",
                md(capability["kind"].as_str().unwrap_or("unknown")),
                md(capability["name"].as_str().unwrap_or("unknown")),
                md(capability["status"].as_str().unwrap_or("unsupported"))
            ));
        }
    }
    out.push('\n');
    for scenario in blueprint["scenarios"].as_array().unwrap() {
        out.push_str(&format!(
            "## {}\n\n",
            md(scenario["title"].as_str().unwrap_or("Scenario"))
        ));
        let target = &scenario["target"];
        out.push_str(&format!(
            "- Proposed target: {} ({})\n",
            md(target["name"].as_str().unwrap_or("unknown")),
            md(target["mode"].as_str().unwrap_or("unknown"))
        ));
        out.push_str(&format!("- Compatibility: unverified\n- Retained components: {}\n- Retained tokens: {}\n- Retained declared modes: {}\n",scenario.pointer("/retainedCounts/components").and_then(Value::as_u64).unwrap_or(0),scenario.pointer("/retainedCounts/tokens").and_then(Value::as_u64).unwrap_or(0),scenario.pointer("/retainedCounts/modes").and_then(Value::as_u64).unwrap_or(0)));
        let blockers = scenario["blockers"].as_array().unwrap();
        out.push_str(&format!("- Blockers: {}\n\n", blockers.len()));
        out.push_str("### Manual contribution choices\n\n");
        for selection in scenario["selections"].as_array().unwrap() {
            out.push_str(&format!(
                "- {}: {} {} from {} to {}; {}. Rationale: {}\n",
                md(selection["id"].as_str().unwrap_or("unknown")),
                md(selection["kind"].as_str().unwrap_or("unknown")),
                md(selection["name"].as_str().unwrap_or("unknown")),
                md(selection["source"].as_str().unwrap_or("unknown")),
                md(selection["targetName"].as_str().unwrap_or("unknown")),
                md(selection["disposition"].as_str().unwrap_or("unknown")),
                md(selection["rationale"].as_str().unwrap_or("unspecified"))
            ));
        }
        out.push_str("\n### Declared dependencies\n\n");
        let dependencies = scenario["dependencies"].as_array().unwrap();
        if dependencies.is_empty() {
            out.push_str("- None declared.\n");
        }
        for dependency in dependencies {
            out.push_str(&format!(
                "- {} to {}: {}\n",
                md(dependency["from"].as_str().unwrap_or("unknown")),
                md(dependency["to"].as_str().unwrap_or("unknown")),
                md(dependency["rationale"].as_str().unwrap_or("unspecified"))
            ));
        }
        let architecture = &scenario["architecture"];
        out.push_str("\n### Architecture preview\n\n");
        out.push_str(&format!(
            "- Layout: {}\n- Package topology: {}\n- Delivery: {} (verification required)\n",
            md(architecture
                .pointer("/selection/layout")
                .and_then(Value::as_str)
                .unwrap_or("unknown")),
            md(architecture
                .pointer("/selection/topology")
                .and_then(Value::as_str)
                .unwrap_or("unknown")),
            md(architecture
                .pointer("/selection/delivery")
                .and_then(Value::as_str)
                .unwrap_or("unknown"))
        ));
        for slot in architecture
            .pointer("/preview/layout/slots")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            out.push_str(&format!(
                "- Proposed slot: {}\n",
                md(slot.as_str().unwrap_or("unknown"))
            ));
        }
        for package in architecture
            .pointer("/preview/topology/packages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            out.push_str(&format!(
                "- Proposed package: {}\n",
                md(package.as_str().unwrap_or("unknown"))
            ));
        }
        out.push_str("\n### Checks and obligations\n\n");
        for check in scenario["checks"].as_array().unwrap() {
            out.push_str(&format!(
                "- [{}] {} — {}\n",
                md(check["status"].as_str().unwrap_or("not-run")),
                md(check["kind"].as_str().unwrap_or("unknown")),
                md(check["description"].as_str().unwrap_or("unspecified"))
            ));
        }
        out.push_str("\n### Findings and blockers\n\n");
        for finding in scenario["findings"].as_array().unwrap() {
            out.push_str(&format!(
                "- **Finding:** {}\n",
                md(finding["message"].as_str().unwrap_or("Review required"))
            ));
        }
        for blocker in blockers {
            out.push_str(&format!(
                "- **Blocker:** {}\n",
                md(blocker["message"].as_str().unwrap_or("Unresolved blocker"))
            ));
        }
        out.push('\n');
    }
    out.push_str("## Scenario comparisons\n\n");
    let comparisons = blueprint["comparisons"].as_array().unwrap();
    if comparisons.is_empty() {
        out.push_str("- No alternative scenarios to compare.\n\n");
    }
    for comparison in comparisons {
        out.push_str(&format!(
            "### {} compared with {}\n\n",
            md(comparison["scenario"].as_str().unwrap_or("scenario")),
            md(comparison["baselineScenario"]
                .as_str()
                .unwrap_or("baseline"))
        ));
        let joined = |pointer: &str| {
            comparison
                .pointer(pointer)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(md)
                .collect::<Vec<_>>()
                .join(", ")
        };
        out.push_str(&format!(
            "- Source changes: added {}; removed {}\n",
            if joined("/sourceChanges/added").is_empty() {
                "none".into()
            } else {
                joined("/sourceChanges/added")
            },
            if joined("/sourceChanges/removed").is_empty() {
                "none".into()
            } else {
                joined("/sourceChanges/removed")
            }
        ));
        out.push_str(&format!(
            "- Target changed: {}\n- Architecture changes: {}\n",
            comparison["targetChanged"].as_bool().unwrap_or(false),
            if joined("/architectureChanges").is_empty() {
                "none".into()
            } else {
                joined("/architectureChanges")
            }
        ));
        let selection_changes = comparison["selectionChanges"].as_array().unwrap();
        out.push_str(&format!(
            "- Selection changes: {}\n",
            selection_changes.len()
        ));
        for change in selection_changes {
            out.push_str(&format!(
                "  - {} — {}; before {}; after {}\n",
                md(change["id"].as_str().unwrap_or("unknown")),
                md(change["change"].as_str().unwrap_or("changed")),
                selection_summary(&change["before"]),
                selection_summary(&change["after"]),
            ));
        }
        for direction in ["added", "removed"] {
            for dependency in comparison
                .pointer(&format!("/dependencyChanges/{direction}"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                out.push_str(&format!(
                    "  - Dependency {}: {} to {} — {}\n",
                    direction,
                    md(dependency["from"].as_str().unwrap_or("unknown")),
                    md(dependency["to"].as_str().unwrap_or("unknown")),
                    md(dependency["rationale"].as_str().unwrap_or("unspecified"))
                ));
            }
        }
        out.push_str(&format!(
            "- Dependency changes: {} added; {} removed\n- Blocker counts: {} before; {} after\n\n",
            comparison
                .pointer("/dependencyChanges/added")
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
            comparison
                .pointer("/dependencyChanges/removed")
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
            comparison
                .pointer("/blockerCounts/before")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            comparison
                .pointer("/blockerCounts/after")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        ));
    }
    out.push_str("## Limitations\n\n");
    for item in blueprint["limitations"].as_array().unwrap() {
        out.push_str(&format!(
            "- {}\n",
            md(item.as_str().unwrap_or("Unknown limitation"))
        ));
    }
    Ok(out)
}
pub fn publish(
    target: DirectoryTarget,
    pinned: &Project,
    blueprint: &Value,
    review: &str,
    final_check: impl FnOnce() -> Result<()>,
) -> Result<std::path::PathBuf> {
    let mut project_bytes = serde_json::to_vec_pretty(pinned)?;
    project_bytes.push(b'\n');
    let mut blueprint_bytes = serde_json::to_vec_pretty(blueprint)?;
    blueprint_bytes.push(b'\n');
    let review_bytes = review.as_bytes();
    let workspace = crate::composition_workspace::render(pinned, blueprint)?;
    let workspace_bytes = workspace.as_bytes();
    target.write("project.json", &project_bytes)?;
    target.write("blueprint.json", &blueprint_bytes)?;
    target.write("review.md", review_bytes)?;
    target.write("workspace.html", workspace_bytes)?;
    let records = [
        ("project.json", &project_bytes[..]),
        ("blueprint.json", &blueprint_bytes[..]),
        ("review.md", review_bytes),
        ("workspace.html", workspace_bytes),
    ]
    .map(|(path, bytes)| {
        json!({"path":path,"sha256":paths::sha256_bytes(bytes),"bytes":bytes.len()})
    });
    let mut manifest = serde_json::to_vec_pretty(
        &json!({"schemaVersion":1,"kind":"rhubase-composition-artifact-manifest","files":records}),
    )?;
    manifest.push(b'\n');
    target.write("manifest.json", &manifest)?;
    final_check()?;
    target.commit()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    fn base() -> Project {
        serde_json::from_value(json!({"schemaVersion":1,"kind":"rhubase-composition-project","title":"Foundation","sources":[{"id":"a","digest":null,"declaredModes":[]},{"id":"b","digest":null,"declaredModes":["dark"]}],"scenarios":[{"id":"ab","title":"A+B","includedSources":["a","b"],"target":{"name":"@x/foundation","mode":"new","baseSource":null},"selections":[],"dependencies":[],"architecture":{"layout":"colocated","topology":"single-package","delivery":"minimal","deliverySource":null}}]})).unwrap()
    }
    #[test]
    fn accepts_minimal_closed_project() {
        validate_project(&base()).unwrap()
    }
    #[test]
    fn rejects_unknown_disposition() {
        let mut p = base();
        p.scenarios[0].selections.push(Selection {
            id: "x".into(),
            source: "a".into(),
            kind: "component".into(),
            name: "Button".into(),
            target_name: "Button".into(),
            disposition: "replace".into(),
            rationale: "x".into(),
        });
        assert!(
            validate_project(&p)
                .unwrap_err()
                .to_string()
                .contains("unsupported disposition")
        );
    }
    #[test]
    fn required_nullable_fields_cannot_be_omitted() {
        let mut value = serde_json::to_value(base()).unwrap();
        value["sources"][0]
            .as_object_mut()
            .unwrap()
            .remove("digest");
        assert!(validate_project_shape(&value).is_err());
        let mut value = serde_json::to_value(base()).unwrap();
        value["scenarios"][0]["target"]
            .as_object_mut()
            .unwrap()
            .remove("baseSource");
        assert!(validate_project_shape(&value).is_err());
        let mut value = serde_json::to_value(base()).unwrap();
        value["scenarios"][0]["architecture"]
            .as_object_mut()
            .unwrap()
            .remove("deliverySource");
        assert!(validate_project_shape(&value).is_err());
    }
    #[test]
    fn evidence_quote_must_match_its_claimed_line_span() {
        let root = std::env::temp_dir().join(format!(
            "rhubase-composition-evidence-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::write(
            root.join("package.json"),
            b"{\"name\":\"@test/a\",\"version\":\"1.0.0\"}",
        )
        .unwrap();
        fs::write(root.join("index.d.ts"), b"first line\nsecond line\n").unwrap();
        let guard = TreeGuard::open(&root).unwrap();
        let digest = paths::sha256_file(&root.join("index.d.ts")).unwrap();
        let forged = json!({"file":"index.d.ts","sha256":digest,"startLine":2,"endLine":2,"quote":"first line"});
        assert!(
            evidence(&json!({"evidence":[forged]}), &guard)
                .unwrap_err()
                .to_string()
                .contains("forged source evidence")
        );
        assert!(evidence(&json!({"evidence":[]}), &guard).is_err());
        assert!(evidence(&json!({"evidence":[{"file":"index.d.ts"}]}), &guard).is_err());
        assert!(evidence(&json!({"evidence":[{"file":"index.d.ts","sha256":digest,"startLine":1,"endLine":1,"quote":"first line","approved":true}]}), &guard).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
