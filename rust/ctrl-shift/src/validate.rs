use crate::{
    error::{AppError, Result},
    paths::TreeGuard,
};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

const COLLECTIONS: &[&str] = &[
    "entrypoints",
    "exports",
    "propSurfaces",
    "tokenFiles",
    "tokens",
    "documentationFiles",
];
const CHANGE_KINDS: &[&str] = &[
    "export-added",
    "export-removed",
    "prop-added",
    "prop-removed",
    "prop-type-changed",
    "prop-requiredness-changed",
    "prop-default-changed",
    "prop-literals-changed",
    "token-added",
    "token-removed",
    "token-value-changed",
    "token-type-changed",
];
const PROPOSAL_KINDS: &[&str] = &[
    "component-rename",
    "component-split",
    "prop-rename",
    "prop-value-rename",
    "token-rename",
];
const PROPOSAL_BASES: &[&str] = &[
    "documentation-explicit",
    "structural-candidate",
    "model-suggestion",
    "ambiguous-candidates",
];

pub struct ValidationContext<'a> {
    pub from: &'a TreeGuard,
    pub to: &'a TreeGuard,
    pub compiler_sha256: &'a str,
}

struct CachedFile {
    text: String,
    sha256: String,
}

struct EvidenceCache<'context, 'guard> {
    context: &'context ValidationContext<'guard>,
    files: HashMap<(&'static str, String), CachedFile>,
}

impl<'context, 'guard> EvidenceCache<'context, 'guard> {
    fn new(context: &'context ValidationContext<'guard>) -> Self {
        Self {
            context,
            files: HashMap::new(),
        }
    }

    fn read(&mut self, snapshot: &'static str, relative: &str) -> Result<&CachedFile> {
        let key = (snapshot, relative.to_owned());
        if !self.files.contains_key(&key) {
            let guard = if snapshot == "from" {
                self.context.from
            } else {
                self.context.to
            };
            let (text, sha256) = guard.evidence_text(relative)?;
            self.files.insert(key.clone(), CachedFile { text, sha256 });
        }
        self.files
            .get(&key)
            .ok_or_else(|| invalid("evidence cache insertion failed"))
    }
}

#[derive(Default)]
struct Collection {
    extracted: HashSet<String>,
    unsupported: HashSet<String>,
}

#[derive(Default)]
struct SideCoverage {
    entrypoints: Collection,
    exports: Collection,
    props: Collection,
    tokens: Collection,
}

#[derive(Default)]
struct UnsafeRefs {
    duplicate_tokens: HashSet<String>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(format!("invalid migration contract: {}", message.into()))
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
        .ok_or_else(|| invalid(format!("{label}.{key} is required")))
}

fn text<'a>(value: &'a Value, label: &str) -> Result<&'a str> {
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("{label} must be a nonempty string")))
}

fn exact_keys(map: &Map<String, Value>, expected: &[&str], label: &str) -> Result<()> {
    let expected: HashSet<&str> = expected.iter().copied().collect();
    if map.len() != expected.len() || map.keys().any(|key| !expected.contains(key.as_str())) {
        return Err(invalid(format!("{label} has unexpected or missing fields")));
    }
    Ok(())
}

fn allowed_keys(
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

fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn safe_relative(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value.contains('\\')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn string_set(value: &Value, label: &str) -> Result<HashSet<String>> {
    let mut result = HashSet::new();
    for (index, item) in array(value, label)?.iter().enumerate() {
        let item = text(item, &format!("{label}[{index}]"))?;
        if !result.insert(item.to_owned()) {
            return Err(invalid(format!("{label} contains duplicate values")));
        }
    }
    Ok(result)
}

fn line_number(text: &str, byte: usize) -> usize {
    text.as_bytes()[..byte]
        .iter()
        .filter(|byte| **byte == b'\n')
        .count()
        + 1
}

fn validate_evidence_item(
    value: &Value,
    cache: &mut EvidenceCache<'_, '_>,
    label: &str,
) -> Result<&'static str> {
    let item = object(value, label)?;
    exact_keys(
        item,
        &[
            "snapshot",
            "file",
            "sha256",
            "startLine",
            "endLine",
            "quote",
        ],
        label,
    )?;
    let snapshot = text(
        field(item, "snapshot", label)?,
        &format!("{label}.snapshot"),
    )?;
    let snapshot = match snapshot {
        "from" => "from",
        "to" => "to",
        _ => return Err(invalid(format!("{label}.snapshot must be from or to"))),
    };
    let file = text(field(item, "file", label)?, &format!("{label}.file"))?;
    if !safe_relative(file) {
        return Err(invalid(format!("{label}.file is unsafe")));
    }
    let expected_sha = text(field(item, "sha256", label)?, &format!("{label}.sha256"))?;
    if !hex64(expected_sha) {
        return Err(invalid(format!("{label}.sha256 must be lowercase SHA-256")));
    }
    let start_line = field(item, "startLine", label)?
        .as_u64()
        .and_then(|number| usize::try_from(number).ok())
        .filter(|number| *number > 0)
        .ok_or_else(|| invalid(format!("{label}.startLine must be a positive integer")))?;
    let end_line = field(item, "endLine", label)?
        .as_u64()
        .and_then(|number| usize::try_from(number).ok())
        .filter(|number| *number >= start_line)
        .ok_or_else(|| invalid(format!("{label}.endLine must follow startLine")))?;
    let quote = text(field(item, "quote", label)?, &format!("{label}.quote"))?;
    let cached = cache.read(snapshot, file)?;
    if cached.sha256 != expected_sha {
        return Err(invalid(format!(
            "{label}.sha256 does not match the snapshot"
        )));
    }
    let line_count = cached.text.bytes().filter(|byte| *byte == b'\n').count() + 1;
    if end_line > line_count {
        return Err(invalid(format!("{label} line range exceeds the source")));
    }
    let found = cached.text.match_indices(quote).any(|(start, matched)| {
        line_number(&cached.text, start) == start_line
            && line_number(&cached.text, start + matched.len()) == end_line
    });
    if !found {
        return Err(invalid(format!(
            "{label}.quote does not match its exact line span"
        )));
    }
    Ok(snapshot)
}

fn validate_evidence(
    value: &Value,
    cache: &mut EvidenceCache<'_, '_>,
    label: &str,
) -> Result<HashSet<&'static str>> {
    let entries = array(value, label)?;
    if entries.is_empty() {
        return Err(invalid(format!("{label} must not be empty")));
    }
    let mut sides = HashSet::new();
    for (index, item) in entries.iter().enumerate() {
        sides.insert(validate_evidence_item(
            item,
            cache,
            &format!("{label}[{index}]"),
        )?);
    }
    Ok(sides)
}

fn validate_collection(
    value: &Value,
    cache: &mut EvidenceCache<'_, '_>,
    label: &str,
) -> Result<Collection> {
    let map = object(value, label)?;
    exact_keys(map, &["eligible", "extracted", "unsupported"], label)?;
    let eligible = string_set(field(map, "eligible", label)?, &format!("{label}.eligible"))?;
    let extracted = string_set(
        field(map, "extracted", label)?,
        &format!("{label}.extracted"),
    )?;
    if !extracted.is_subset(&eligible) {
        return Err(invalid(format!(
            "{label}.extracted must be a subset of eligible"
        )));
    }
    let mut unsupported = HashSet::new();
    for (index, entry) in array(
        field(map, "unsupported", label)?,
        &format!("{label}.unsupported"),
    )?
    .iter()
    .enumerate()
    {
        let entry_label = format!("{label}.unsupported[{index}]");
        let record = object(entry, &entry_label)?;
        exact_keys(record, &["id", "reason", "evidence"], &entry_label)?;
        let id = text(
            field(record, "id", &entry_label)?,
            &format!("{entry_label}.id"),
        )?;
        text(
            field(record, "reason", &entry_label)?,
            &format!("{entry_label}.reason"),
        )?;
        if !eligible.contains(id) || !unsupported.insert(id.to_owned()) {
            return Err(invalid(format!(
                "{entry_label}.id must be a unique eligible ID"
            )));
        }
        validate_evidence(
            field(record, "evidence", &entry_label)?,
            cache,
            &format!("{entry_label}.evidence"),
        )?;
    }
    Ok(Collection {
        extracted,
        unsupported,
    })
}

fn validate_coverage_side(
    value: &Value,
    cache: &mut EvidenceCache<'_, '_>,
    label: &str,
) -> Result<SideCoverage> {
    let map = object(value, label)?;
    exact_keys(
        map,
        &[
            "entrypoints",
            "exports",
            "propSurfaces",
            "tokenFiles",
            "tokens",
            "documentationFiles",
            "excludedFiles",
        ],
        label,
    )?;
    let mut collections = Vec::new();
    for name in COLLECTIONS {
        collections.push(validate_collection(
            field(map, name, label)?,
            cache,
            &format!("{label}.{name}"),
        )?);
    }
    let mut excluded = HashSet::new();
    for (index, item) in array(
        field(map, "excludedFiles", label)?,
        &format!("{label}.excludedFiles"),
    )?
    .iter()
    .enumerate()
    {
        let item_label = format!("{label}.excludedFiles[{index}]");
        let record = object(item, &item_label)?;
        exact_keys(record, &["file", "reason"], &item_label)?;
        let file = text(
            field(record, "file", &item_label)?,
            &format!("{item_label}.file"),
        )?;
        if !safe_relative(file) || !excluded.insert(file) {
            return Err(invalid(format!(
                "{item_label}.file must be unique and relative"
            )));
        }
        text(
            field(record, "reason", &item_label)?,
            &format!("{item_label}.reason"),
        )?;
    }
    let [
        entrypoints,
        exports,
        props,
        _token_files,
        tokens,
        _documentation_files,
    ]: [Collection; 6] = collections
        .try_into()
        .map_err(|_| invalid("coverage collection count mismatch"))?;
    Ok(SideCoverage {
        entrypoints,
        exports,
        props,
        tokens,
    })
}

fn validate_identity(
    value: &Value,
    guard: &TreeGuard,
    cache: &mut EvidenceCache<'_, '_>,
    side: &'static str,
    label: &str,
) -> Result<HashSet<String>> {
    let map = object(value, label)?;
    exact_keys(map, &["name", "version", "digest", "entrypoints"], label)?;
    if text(field(map, "name", label)?, &format!("{label}.name"))? != guard.package_name
        || text(field(map, "version", label)?, &format!("{label}.version"))?
            != guard.package_version
    {
        return Err(invalid(format!("{label} package identity mismatch")));
    }
    let digest = text(field(map, "digest", label)?, &format!("{label}.digest"))?;
    if !hex64(digest) || digest != guard.node_digest {
        return Err(invalid(format!(
            "{label}.digest does not match the snapshot"
        )));
    }
    let mut ids = HashSet::new();
    for (index, entry) in array(
        field(map, "entrypoints", label)?,
        &format!("{label}.entrypoints"),
    )?
    .iter()
    .enumerate()
    {
        let entry_label = format!("{label}.entrypoints[{index}]");
        let entry = object(entry, &entry_label)?;
        exact_keys(entry, &["name", "file"], &entry_label)?;
        let name = text(
            field(entry, "name", &entry_label)?,
            &format!("{entry_label}.name"),
        )?;
        let file = text(
            field(entry, "file", &entry_label)?,
            &format!("{entry_label}.file"),
        )?;
        if !safe_relative(file) {
            return Err(invalid(format!("{entry_label}.file is unsafe")));
        }
        cache.read(side, file)?;
        if !ids.insert(format!("{name}:{file}")) {
            return Err(invalid(format!("{label}.entrypoints contains duplicates")));
        }
    }
    Ok(ids)
}

fn coverage_export_id(value: &str) -> Result<String> {
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(invalid("export reference must be a nonempty safe string"));
    }
    if let Some((entrypoint, name)) = value.split_once('#') {
        if !entrypoint.starts_with('.') || name.is_empty() || name.contains('#') {
            return Err(invalid("qualified export reference is malformed"));
        }
        Ok(value.to_owned())
    } else {
        Ok(format!(".#{value}"))
    }
}

fn require_extracted(id: &str, collection: &Collection, label: &str) -> Result<()> {
    if !collection.extracted.contains(id) || collection.unsupported.contains(id) {
        return Err(invalid(format!(
            "{label} does not reference a safely extracted surface"
        )));
    }
    Ok(())
}

fn validate_ref(
    value: &Value,
    side: &SideCoverage,
    unsafe_refs: &UnsafeRefs,
    label: &str,
) -> Result<()> {
    let reference = object(value, label)?;
    if reference.contains_key("token") {
        exact_keys(reference, &["token"], label)?;
        let token = text(field(reference, "token", label)?, &format!("{label}.token"))?;
        require_extracted(token, &side.tokens, label)?;
        if unsafe_refs.duplicate_tokens.contains(token) {
            return Err(invalid(format!("{label} references a duplicate token")));
        }
        return Ok(());
    }
    allowed_keys(reference, &["export"], &["export", "prop", "value"], label)?;
    let export = text(
        field(reference, "export", label)?,
        &format!("{label}.export"),
    )?;
    let export_id = coverage_export_id(export)?;
    require_extracted(&export_id, &side.exports, label)?;
    if let Some(prop) = reference.get("prop") {
        let prop = text(prop, &format!("{label}.prop"))?;
        let prop_id = format!("{export_id}.{prop}");
        require_extracted(&prop_id, &side.props, label)?;
    } else if reference.contains_key("value") {
        return Err(invalid(format!("{label}.value requires prop")));
    }
    Ok(())
}

fn change_ref(
    map: &Map<String, Value>,
    side: &SideCoverage,
    unsafe_refs: &UnsafeRefs,
    label: &str,
) -> Result<()> {
    let reference = if let Some(token) = map.get("token") {
        serde_json::json!({ "token": token })
    } else if let Some(prop) = map.get("prop") {
        serde_json::json!({ "export": field(map, "export", label)?, "prop": prop })
    } else {
        serde_json::json!({ "export": field(map, "export", label)? })
    };
    validate_ref(&reference, side, unsafe_refs, label)
}

fn validate_scalar(value: &Value, label: &str) -> Result<()> {
    if value.is_null() || value.is_boolean() || value.is_number() || value.is_string() {
        Ok(())
    } else {
        Err(invalid(format!("{label} must be a JSON scalar")))
    }
}

fn validate_literals(value: &Value, label: &str) -> Result<()> {
    for (index, item) in array(value, label)?.iter().enumerate() {
        validate_scalar(item, &format!("{label}[{index}]"))?;
    }
    Ok(())
}

fn validate_export_state(value: &Value, label: &str) -> Result<()> {
    let state = object(value, label)?;
    exact_keys(state, &["entrypoint", "kind"], label)?;
    text(
        field(state, "entrypoint", label)?,
        &format!("{label}.entrypoint"),
    )?;
    let kind = text(field(state, "kind", label)?, &format!("{label}.kind"))?;
    if !["type", "component", "function", "class", "value"].contains(&kind) {
        return Err(invalid(format!("{label}.kind is unsupported")));
    }
    Ok(())
}

fn validate_prop_state(value: &Value, label: &str) -> Result<()> {
    let state = object(value, label)?;
    allowed_keys(
        state,
        &["type", "required"],
        &["type", "required", "literals", "default"],
        label,
    )?;
    text(field(state, "type", label)?, &format!("{label}.type"))?;
    if field(state, "required", label)?.as_bool().is_none() {
        return Err(invalid(format!("{label}.required must be boolean")));
    }
    if let Some(literals) = state.get("literals") {
        validate_literals(literals, &format!("{label}.literals"))?;
    }
    Ok(())
}

fn validate_token_state(value: &Value, label: &str) -> Result<()> {
    let state = object(value, label)?;
    exact_keys(state, &["value", "type"], label)?;
    if !field(state, "type", label)?.is_null() {
        text(field(state, "type", label)?, &format!("{label}.type"))?;
    }
    Ok(())
}

fn validate_nullable_text(value: &Value, label: &str) -> Result<()> {
    if value.is_null() {
        Ok(())
    } else {
        text(value, label).map(|_| ())
    }
}

fn validate_unresolved(
    value: &Value,
    cache: &mut EvidenceCache<'_, '_>,
    from: &SideCoverage,
) -> Result<UnsafeRefs> {
    let mut unsafe_refs = UnsafeRefs::default();
    for (index, item) in array(value, "unresolved")?.iter().enumerate() {
        let label = format!("unresolved[{index}]");
        let map = object(item, &label)?;
        allowed_keys(
            map,
            &["kind", "reason", "evidence"],
            &["kind", "source", "reason", "evidence"],
            &label,
        )?;
        let kind = text(field(map, "kind", &label)?, &format!("{label}.kind"))?;
        let reason = text(field(map, "reason", &label)?, &format!("{label}.reason"))?;
        if let Some(source) = map.get("source") {
            validate_ref(
                source,
                from,
                &UnsafeRefs::default(),
                &format!("{label}.source"),
            )?;
        }
        validate_evidence(
            field(map, "evidence", &label)?,
            cache,
            &format!("{label}.evidence"),
        )?;
        if kind == "unsupported-extraction"
            && let Some((_, token)) = reason.rsplit_once("duplicate token name: ")
            && !token.is_empty()
        {
            unsafe_refs.duplicate_tokens.insert(token.to_owned());
        }
    }
    Ok(unsafe_refs)
}

fn validate_changes(
    value: &Value,
    cache: &mut EvidenceCache<'_, '_>,
    from: &SideCoverage,
    to: &SideCoverage,
    unsafe_refs: &UnsafeRefs,
    ids: &mut HashSet<String>,
) -> Result<()> {
    for (index, item) in array(value, "changes")?.iter().enumerate() {
        let label = format!("changes[{index}]");
        let map = object(item, &label)?;
        let id = text(field(map, "id", &label)?, &format!("{label}.id"))?;
        if !ids.insert(id.to_owned()) {
            return Err(invalid("change/proposal IDs must be globally unique"));
        }
        let kind = text(field(map, "kind", &label)?, &format!("{label}.kind"))?;
        if !CHANGE_KINDS.contains(&kind) {
            return Err(invalid(format!("{label}.kind is unsupported")));
        }
        let expected_sides: &[&str] = match kind {
            "export-removed" => {
                exact_keys(map, &["id", "kind", "export", "before", "evidence"], &label)?;
                validate_export_state(field(map, "before", &label)?, &format!("{label}.before"))?;
                &["from"]
            }
            "export-added" => {
                exact_keys(map, &["id", "kind", "export", "after", "evidence"], &label)?;
                validate_export_state(field(map, "after", &label)?, &format!("{label}.after"))?;
                &["to"]
            }
            "prop-removed" => {
                exact_keys(
                    map,
                    &["id", "kind", "export", "prop", "before", "evidence"],
                    &label,
                )?;
                validate_prop_state(field(map, "before", &label)?, &format!("{label}.before"))?;
                &["from"]
            }
            "prop-added" => {
                exact_keys(
                    map,
                    &["id", "kind", "export", "prop", "after", "evidence"],
                    &label,
                )?;
                validate_prop_state(field(map, "after", &label)?, &format!("{label}.after"))?;
                &["to"]
            }
            "prop-type-changed" => {
                exact_keys(
                    map,
                    &[
                        "id", "kind", "export", "prop", "before", "after", "evidence",
                    ],
                    &label,
                )?;
                text(field(map, "before", &label)?, &format!("{label}.before"))?;
                text(field(map, "after", &label)?, &format!("{label}.after"))?;
                &["from", "to"]
            }
            "prop-requiredness-changed" => {
                exact_keys(
                    map,
                    &[
                        "id", "kind", "export", "prop", "before", "after", "evidence",
                    ],
                    &label,
                )?;
                if field(map, "before", &label)?.as_bool().is_none()
                    || field(map, "after", &label)?.as_bool().is_none()
                {
                    return Err(invalid(format!(
                        "{label} requiredness values must be boolean"
                    )));
                }
                &["from", "to"]
            }
            "prop-default-changed" => {
                exact_keys(
                    map,
                    &[
                        "id", "kind", "export", "prop", "before", "after", "evidence",
                    ],
                    &label,
                )?;
                &["from", "to"]
            }
            "prop-literals-changed" => {
                exact_keys(
                    map,
                    &[
                        "id", "kind", "export", "prop", "before", "after", "evidence",
                    ],
                    &label,
                )?;
                validate_literals(field(map, "before", &label)?, &format!("{label}.before"))?;
                validate_literals(field(map, "after", &label)?, &format!("{label}.after"))?;
                &["from", "to"]
            }
            "token-removed" => {
                exact_keys(map, &["id", "kind", "token", "before", "evidence"], &label)?;
                validate_token_state(field(map, "before", &label)?, &format!("{label}.before"))?;
                &["from"]
            }
            "token-added" => {
                exact_keys(map, &["id", "kind", "token", "after", "evidence"], &label)?;
                validate_token_state(field(map, "after", &label)?, &format!("{label}.after"))?;
                &["to"]
            }
            "token-value-changed" => {
                exact_keys(
                    map,
                    &["id", "kind", "token", "before", "after", "evidence"],
                    &label,
                )?;
                &["from", "to"]
            }
            "token-type-changed" => {
                exact_keys(
                    map,
                    &["id", "kind", "token", "before", "after", "evidence"],
                    &label,
                )?;
                validate_nullable_text(field(map, "before", &label)?, &format!("{label}.before"))?;
                validate_nullable_text(field(map, "after", &label)?, &format!("{label}.after"))?;
                &["from", "to"]
            }
            _ => unreachable!("change kind checked above"),
        };
        let sides = validate_evidence(
            field(map, "evidence", &label)?,
            cache,
            &format!("{label}.evidence"),
        )?;
        if expected_sides.iter().any(|side| !sides.contains(side)) {
            return Err(invalid(format!(
                "{label}.evidence is missing a required snapshot side"
            )));
        }
        if expected_sides.contains(&"from") {
            change_ref(map, from, unsafe_refs, &label)?;
        }
        if expected_sides.contains(&"to") {
            change_ref(map, to, unsafe_refs, &label)?;
        }
    }
    Ok(())
}

fn validate_proposals(
    value: &Value,
    cache: &mut EvidenceCache<'_, '_>,
    from: &SideCoverage,
    to: &SideCoverage,
    unsafe_refs: &UnsafeRefs,
    ids: &mut HashSet<String>,
) -> Result<()> {
    for (index, item) in array(value, "proposals")?.iter().enumerate() {
        let label = format!("proposals[{index}]");
        let map = object(item, &label)?;
        allowed_keys(
            map,
            &[
                "id",
                "kind",
                "source",
                "basis",
                "reason",
                "status",
                "executable",
                "evidence",
            ],
            &[
                "id",
                "kind",
                "source",
                "target",
                "targets",
                "basis",
                "reason",
                "status",
                "executable",
                "evidence",
            ],
            &label,
        )?;
        let id = text(field(map, "id", &label)?, &format!("{label}.id"))?;
        if !ids.insert(id.to_owned()) {
            return Err(invalid("change/proposal IDs must be globally unique"));
        }
        let kind = text(field(map, "kind", &label)?, &format!("{label}.kind"))?;
        if !PROPOSAL_KINDS.contains(&kind) {
            return Err(invalid(format!("{label}.kind is unsupported")));
        }
        let basis = text(field(map, "basis", &label)?, &format!("{label}.basis"))?;
        if !PROPOSAL_BASES.contains(&basis) {
            return Err(invalid(format!("{label}.basis is unsupported")));
        }
        text(field(map, "reason", &label)?, &format!("{label}.reason"))?;
        if field(map, "status", &label)?.as_str() != Some("needs-review")
            || field(map, "executable", &label)?.as_bool() != Some(false)
        {
            return Err(invalid(format!(
                "{label} must remain non-executable and need review"
            )));
        }
        let source = field(map, "source", &label)?;
        let source_map = object(source, &format!("{label}.source"))?;
        match kind {
            "component-rename" => exact_keys(source_map, &["export"], &format!("{label}.source"))?,
            "component-split" => exact_keys(source_map, &["export"], &format!("{label}.source"))?,
            "prop-rename" => {
                exact_keys(source_map, &["export", "prop"], &format!("{label}.source"))?
            }
            "prop-value-rename" => exact_keys(
                source_map,
                &["export", "prop", "value"],
                &format!("{label}.source"),
            )?,
            _ => exact_keys(source_map, &["token"], &format!("{label}.source"))?,
        }
        validate_ref(source, from, unsafe_refs, &format!("{label}.source"))?;
        if kind == "component-split" {
            if map.contains_key("target") {
                return Err(invalid(format!("{label} split must use targets only")));
            }
            let targets = array(field(map, "targets", &label)?, &format!("{label}.targets"))?;
            if targets.len() < 2 {
                return Err(invalid(format!(
                    "{label}.targets must contain at least two targets"
                )));
            }
            let mut seen = HashSet::new();
            for (target_index, target) in targets.iter().enumerate() {
                let target_label = format!("{label}.targets[{target_index}]");
                exact_keys(object(target, &target_label)?, &["export"], &target_label)?;
                if !seen.insert(target.to_string()) {
                    return Err(invalid(format!("{label}.targets contains duplicates")));
                }
                validate_ref(target, to, unsafe_refs, &target_label)?;
            }
        } else {
            if map.contains_key("targets") {
                return Err(invalid(format!("{label} must use one target")));
            }
            let target = field(map, "target", &label)?;
            let target_map = object(target, &format!("{label}.target"))?;
            match kind {
                "component-rename" => {
                    exact_keys(target_map, &["export"], &format!("{label}.target"))?
                }
                "prop-rename" => {
                    exact_keys(target_map, &["export", "prop"], &format!("{label}.target"))?
                }
                "prop-value-rename" => exact_keys(
                    target_map,
                    &["export", "prop", "value"],
                    &format!("{label}.target"),
                )?,
                _ => exact_keys(target_map, &["token"], &format!("{label}.target"))?,
            }
            validate_ref(target, to, unsafe_refs, &format!("{label}.target"))?;
        }
        let sides = validate_evidence(
            field(map, "evidence", &label)?,
            cache,
            &format!("{label}.evidence"),
        )?;
        if !sides.contains("from") || !sides.contains("to") {
            return Err(invalid(format!("{label}.evidence must cover from and to")));
        }
    }
    Ok(())
}

pub fn validate_contract(contract: &Value, context: &ValidationContext<'_>) -> Result<()> {
    if !context.from.unchanged()? || !context.to.unchanged()? {
        return Err(invalid("snapshot changed before validation"));
    }
    let root = object(contract, "contract")?;
    exact_keys(
        root,
        &[
            "schemaVersion",
            "kind",
            "status",
            "executable",
            "from",
            "to",
            "compiler",
            "coverage",
            "changes",
            "proposals",
            "unresolved",
            "limitations",
        ],
        "contract",
    )?;
    if field(root, "schemaVersion", "contract")?.as_u64() != Some(1)
        || field(root, "kind", "contract")?.as_str() != Some("migration-contract")
        || field(root, "status", "contract")?.as_str() != Some("draft")
        || field(root, "executable", "contract")?.as_bool() != Some(false)
    {
        return Err(invalid(
            "header must be migration-contract v1 draft and non-executable",
        ));
    }
    let mut cache = EvidenceCache::new(context);
    let from_entrypoints = validate_identity(
        field(root, "from", "contract")?,
        context.from,
        &mut cache,
        "from",
        "from",
    )?;
    let to_entrypoints = validate_identity(
        field(root, "to", "contract")?,
        context.to,
        &mut cache,
        "to",
        "to",
    )?;
    let compiler = object(field(root, "compiler", "contract")?, "compiler")?;
    exact_keys(compiler, &["version", "sha256"], "compiler")?;
    if field(compiler, "version", "compiler")?.as_str() != Some("5.9.3") {
        return Err(invalid("compiler.version must be 5.9.3"));
    }
    let compiler_sha = text(field(compiler, "sha256", "compiler")?, "compiler.sha256")?;
    if !hex64(compiler_sha) || compiler_sha != context.compiler_sha256 {
        return Err(invalid("compiler SHA-256 mismatch"));
    }
    let coverage = object(field(root, "coverage", "contract")?, "coverage")?;
    exact_keys(coverage, &["from", "to"], "coverage")?;
    let from_coverage = validate_coverage_side(
        field(coverage, "from", "coverage")?,
        &mut cache,
        "coverage.from",
    )?;
    let to_coverage = validate_coverage_side(
        field(coverage, "to", "coverage")?,
        &mut cache,
        "coverage.to",
    )?;
    if from_coverage.entrypoints.extracted != from_entrypoints
        || to_coverage.entrypoints.extracted != to_entrypoints
    {
        return Err(invalid(
            "identity entrypoints do not match extracted coverage",
        ));
    }
    let unsafe_refs = validate_unresolved(
        field(root, "unresolved", "contract")?,
        &mut cache,
        &from_coverage,
    )?;
    let mut ids = HashSet::new();
    validate_changes(
        field(root, "changes", "contract")?,
        &mut cache,
        &from_coverage,
        &to_coverage,
        &unsafe_refs,
        &mut ids,
    )?;
    validate_proposals(
        field(root, "proposals", "contract")?,
        &mut cache,
        &from_coverage,
        &to_coverage,
        &unsafe_refs,
        &mut ids,
    )?;
    for (index, limitation) in array(field(root, "limitations", "contract")?, "limitations")?
        .iter()
        .enumerate()
    {
        text(limitation, &format!("limitations[{index}]"))?;
    }
    if !context.from.unchanged()? || !context.to.unchanged()? {
        return Err(invalid("snapshot changed during validation"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::sha256_bytes;
    use serde_json::json;
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        guard: TreeGuard,
        source: String,
        sha: String,
    }
    impl Fixture {
        fn new(version: &str, source: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "ctrl-shift-validate-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).expect("create fixture");
            fs::write(
                root.join("package.json"),
                format!(r#"{{"name":"@demo/system","version":"{version}","types":"index.d.ts"}}"#),
            )
            .expect("write package");
            fs::write(root.join("index.d.ts"), source).expect("write declaration");
            let guard = TreeGuard::open(Path::new(&root)).expect("open fixture");
            Self {
                root,
                guard,
                source: source.to_owned(),
                sha: sha256_bytes(source.as_bytes()),
            }
        }
        fn evidence(&self, snapshot: &str, quote: &str) -> Value {
            json!({
                "snapshot": snapshot,
                "file": "index.d.ts",
                "sha256": self.sha,
                "startLine": 1,
                "endLine": 1,
                "quote": quote
            })
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn collection(eligible: &[&str], extracted: &[&str]) -> Value {
        json!({ "eligible": eligible, "extracted": extracted, "unsupported": [] })
    }

    fn side_coverage(export: &str) -> Value {
        json!({
            "entrypoints": collection(&[".:index.d.ts"], &[".:index.d.ts"]),
            "exports": collection(&[export], &[export]),
            "propSurfaces": collection(&[], &[]),
            "tokenFiles": collection(&[], &[]),
            "tokens": collection(&[], &[]),
            "documentationFiles": collection(&[], &[]),
            "excludedFiles": []
        })
    }

    fn valid_contract(from: &Fixture, to: &Fixture, compiler: &str) -> Value {
        let from_evidence = from.evidence("from", &from.source);
        let to_evidence = to.evidence("to", &to.source);
        json!({
            "schemaVersion": 1,
            "kind": "migration-contract",
            "status": "draft",
            "executable": false,
            "from": { "name": "@demo/system", "version": "1.0.0", "digest": from.guard.node_digest, "entrypoints": [{"name":".","file":"index.d.ts"}] },
            "to": { "name": "@demo/system", "version": "2.0.0", "digest": to.guard.node_digest, "entrypoints": [{"name":".","file":"index.d.ts"}] },
            "compiler": { "version": "5.9.3", "sha256": compiler },
            "coverage": { "from": side_coverage(".#Old"), "to": side_coverage(".#New") },
            "changes": [
                { "id":"change:old", "kind":"export-removed", "export":"Old", "before":{"entrypoint":".","kind":"value"}, "evidence":[from_evidence.clone()] },
                { "id":"change:new", "kind":"export-added", "export":"New", "after":{"entrypoint":".","kind":"value"}, "evidence":[to_evidence.clone()] }
            ],
            "proposals": [{
                "id":"proposal:rename", "kind":"component-rename", "source":{"export":"Old"}, "target":{"export":"New"},
                "basis":"documentation-explicit", "reason":"documented", "status":"needs-review", "executable":false,
                "evidence":[from_evidence,to_evidence]
            }],
            "unresolved": [],
            "limitations": ["static only"]
        })
    }

    fn fixtures() -> (Fixture, Fixture, String) {
        let from = Fixture::new("1.0.0", "export declare const Old: string;");
        let to = Fixture::new("2.0.0", "export declare const New: string;");
        (from, to, "c".repeat(64))
    }

    #[test]
    fn accepts_a_grounded_non_executable_contract() {
        let (from, to, compiler) = fixtures();
        let contract = valid_contract(&from, &to, &compiler);
        let context = ValidationContext {
            from: &from.guard,
            to: &to.guard,
            compiler_sha256: &compiler,
        };
        validate_contract(&contract, &context).expect("valid contract");
    }

    #[test]
    fn rejects_executable_or_mismatched_compiler_contracts() {
        let (from, to, compiler) = fixtures();
        let context = ValidationContext {
            from: &from.guard,
            to: &to.guard,
            compiler_sha256: &compiler,
        };
        let mut executable = valid_contract(&from, &to, &compiler);
        executable["executable"] = json!(true);
        assert!(validate_contract(&executable, &context).is_err());
        let mut compiler_mismatch = valid_contract(&from, &to, &compiler);
        compiler_mismatch["compiler"]["sha256"] = json!("d".repeat(64));
        assert!(validate_contract(&compiler_mismatch, &context).is_err());
        let mut digest_mismatch = valid_contract(&from, &to, &compiler);
        digest_mismatch["from"]["digest"] = json!("d".repeat(64));
        assert!(validate_contract(&digest_mismatch, &context).is_err());
    }

    #[test]
    fn rejects_tampered_evidence_hash_quote_and_line() {
        let (from, to, compiler) = fixtures();
        let context = ValidationContext {
            from: &from.guard,
            to: &to.guard,
            compiler_sha256: &compiler,
        };
        for (field, value) in [
            ("sha256", json!("d".repeat(64))),
            ("quote", json!("not source text")),
            ("startLine", json!(2)),
        ] {
            let mut contract = valid_contract(&from, &to, &compiler);
            contract["changes"][0]["evidence"][0][field] = value;
            assert!(
                validate_contract(&contract, &context).is_err(),
                "accepted bad {field}"
            );
        }
    }

    #[test]
    fn rejects_absent_or_unsupported_proposal_targets() {
        let (from, to, compiler) = fixtures();
        let context = ValidationContext {
            from: &from.guard,
            to: &to.guard,
            compiler_sha256: &compiler,
        };
        let mut absent = valid_contract(&from, &to, &compiler);
        absent["proposals"][0]["target"]["export"] = json!("Missing");
        assert!(validate_contract(&absent, &context).is_err());
        let mut unsupported = valid_contract(&from, &to, &compiler);
        unsupported["coverage"]["to"]["exports"]["unsupported"] = json!([{
            "id":".#New", "reason":"incomplete", "evidence":[to.evidence("to", &to.source)]
        }]);
        assert!(validate_contract(&unsupported, &context).is_err());
    }

    #[test]
    fn rejects_duplicate_ids_and_wrong_target_shape() {
        let (from, to, compiler) = fixtures();
        let context = ValidationContext {
            from: &from.guard,
            to: &to.guard,
            compiler_sha256: &compiler,
        };
        let mut duplicate = valid_contract(&from, &to, &compiler);
        duplicate["proposals"][0]["id"] = json!("change:old");
        assert!(validate_contract(&duplicate, &context).is_err());
        let mut shape = valid_contract(&from, &to, &compiler);
        shape["proposals"][0]["targets"] = json!([{"export":"New"},{"export":"New"}]);
        assert!(validate_contract(&shape, &context).is_err());
        let mut mixed = valid_contract(&from, &to, &compiler);
        mixed["changes"][0]["token"] = json!("injected.coordinate");
        assert!(validate_contract(&mixed, &context).is_err());
    }
}
