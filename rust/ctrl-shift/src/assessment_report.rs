use crate::error::{AppError, Result};
use serde_json::{Map, Value};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(format!("invalid consumer assessment: {}", message.into()))
}

fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("{label} must be an object")))
}

fn array<'a>(map: &'a Map<String, Value>, key: &str, label: &str) -> Result<&'a Vec<Value>> {
    map.get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(format!("{label}.{key} must be an array")))
}

fn text<'a>(map: &'a Map<String, Value>, key: &str, label: &str) -> Result<&'a str> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("{label}.{key} must be a nonempty string")))
}

fn safe_text(value: &str) -> String {
    let compact: String = value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(500)
        .collect();
    let mut escaped = String::new();
    for character in compact.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '\\' | '`' | '*' | '_' | '[' | ']' | '(' | ')' | '#' | '|' | '!' => {
                escaped.push('\\');
                escaped.push(character);
            }
            _ => escaped.push(character),
        }
    }
    escaped
}

fn inline_code(value: &str) -> String {
    let compact: String = value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(500)
        .collect();
    let escaped = compact
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let longest = escaped
        .split(|character| character != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "`".repeat(longest + 1);
    format!("{fence} {escaped} {fence}")
}

fn identity_label(identity: &Map<String, Value>) -> Result<String> {
    Ok(format!(
        "{} {}",
        inline_code(text(identity, "name", "identity")?),
        inline_code(text(identity, "version", "identity")?)
    ))
}

fn number(map: &Map<String, Value>, key: &str) -> usize {
    map.get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(0)
}

fn reference_label(value: &Value) -> Result<String> {
    let reference = object(value, "reference")?;
    let mut label = text(reference, "export", "reference")?.to_owned();
    if let Some(prop) = reference.get("prop").and_then(Value::as_str) {
        label.push('.');
        label.push_str(prop);
    }
    if let Some(value) = reference.get("value") {
        label.push('=');
        label.push_str(&serde_json::to_string(value)?);
    }
    Ok(inline_code(&label))
}

fn verification_label(check: &Map<String, Value>) -> Result<String> {
    let category = text(check, "category", "check")?;
    let status = text(check, "status", "check")?;
    let detail = if let Some(script) = check.get("script").and_then(Value::as_str) {
        let manifest = text(check, "manifest", "check")?;
        format!(
            "script {} from {}",
            inline_code(script),
            inline_code(manifest)
        )
    } else if let Some(file) = check.get("ciFile").and_then(Value::as_str) {
        format!("CI configuration {}", inline_code(file))
    } else if status == "missing" {
        format!("missing {} check", inline_code(category))
    } else {
        return Err(invalid("verification candidate detail is incomplete"));
    };
    Ok(format!("{detail} ({})", inline_code(status)))
}

fn condition_label(group: &Map<String, Value>) -> Result<String> {
    let condition = object(
        group
            .get("condition")
            .ok_or_else(|| invalid("group.condition is required"))?,
        "group.condition",
    )?;
    let mut literals = Vec::new();
    for item in array(condition, "literalProps", "condition")? {
        let item = object(item, "literal prop")?;
        literals.push(format!(
            "{}={}",
            text(item, "name", "literal prop")?,
            serde_json::to_string(
                item.get("value")
                    .ok_or_else(|| invalid("literal prop.value is required"))?
            )?
        ));
    }
    let names = |key: &str| -> Result<String> {
        Ok(array(condition, key, "condition")?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| invalid(format!("condition.{key} must contain strings")))
            })
            .collect::<Result<Vec<_>>>()?
            .join(", "))
    };
    let present = names("presentProps")?;
    let dynamic = names("dynamicProps")?;
    let spread = condition
        .get("hasSpread")
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid("condition.hasSpread must be a boolean"))?;
    Ok(format!(
        "literals: {}; present: {}; dynamic: {}; spread: {}",
        if literals.is_empty() {
            "none".to_owned()
        } else {
            literals.join(", ")
        },
        if present.is_empty() { "none" } else { &present },
        if dynamic.is_empty() { "none" } else { &dynamic },
        if spread { "yes" } else { "no" }
    ))
}

pub fn render_markdown(assessment: &Value) -> Result<String> {
    let root = object(assessment, "assessment")?;
    if root.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || root.get("kind").and_then(Value::as_str) != Some("consumer-migration-assessment")
        || root.get("status").and_then(Value::as_str) != Some("draft-review")
        || root.get("executable").and_then(Value::as_bool) != Some(false)
    {
        return Err(invalid(
            "header is not a draft, non-executable v1 assessment",
        ));
    }
    let repository = object(
        root.get("repository")
            .ok_or_else(|| invalid("repository is required"))?,
        "repository",
    )?;
    let target = object(
        root.get("target")
            .ok_or_else(|| invalid("target is required"))?,
        "target",
    )?;
    let target_identity = object(
        target
            .get("identity")
            .ok_or_else(|| invalid("target.identity is required"))?,
        "target.identity",
    )?;
    let sources = array(root, "sources", "assessment")?;
    let inventory = object(
        root.get("usageInventory")
            .ok_or_else(|| invalid("usageInventory is required"))?,
        "usageInventory",
    )?;
    let usages = array(inventory, "usages", "usageInventory")?;
    let unsupported = array(inventory, "unsupported", "usageInventory")?;
    let coverage = object(
        inventory
            .get("coverage")
            .ok_or_else(|| invalid("usageInventory.coverage is required"))?,
        "coverage",
    )?;
    let groups = array(root, "mappingGroups", "assessment")?;
    let decisions = array(root, "decisionsRequired", "assessment")?;
    let checks = array(root, "verificationCandidates", "assessment")?;
    let limitations = array(root, "limitations", "assessment")?;

    let mut output = String::from("# Ctrl + Shift migration assessment\n\n");
    output.push_str("> **Draft for review.** This report is read-only and does not authorize or execute migration changes.\n\n");
    let repository_name = repository
        .get("name")
        .and_then(Value::as_str)
        .map(inline_code)
        .unwrap_or_else(|| "unnamed repository".to_owned());
    output.push_str(&format!(
        "Repository: {repository_name}  \nTarget: {}\n\n",
        identity_label(target_identity)?
    ));

    output.push_str("## Consolidation inputs\n\n| Source system | Selected as | Target system |\n| --- | --- | --- |\n");
    for (index, source) in sources.iter().enumerate() {
        let source = object(source, &format!("sources[{index}]"))?;
        let identity = object(
            source
                .get("identity")
                .ok_or_else(|| invalid("source.identity is required"))?,
            "source.identity",
        )?;
        output.push_str(&format!(
            "| {} | {} | {} |\n",
            identity_label(identity)?,
            inline_code(text(source, "resolution", "source")?),
            identity_label(target_identity)?
        ));
    }

    output.push_str("\n## Scope\n\n");
    output.push_str(&format!("- {} consumer source files scanned\n- {} selected-system JSX usages recognized\n- {} usage patterns\n- {} decisions requiring review\n- {} coverage gaps and unsupported references\n", number(inventory, "filesScanned"), usages.len(), groups.len(), decisions.len(), unsupported.len()));
    output.push_str(&format!(
        "- Coverage status: {}\n",
        inline_code(text(coverage, "status", "coverage")?)
    ));

    output.push_str("\n## Usage groups\n\nCandidate extraction recognizes a bounded migration-document grammar. **No candidate extracted** means the current parser did not establish one; it does not prove that migration guidance is absent.\n\n");
    if groups.is_empty() {
        output.push_str("No supported selected-system JSX usages were grouped.\n");
    }
    for (index, group) in groups.iter().enumerate() {
        let group = object(group, &format!("mappingGroups[{index}]"))?;
        let source_id = text(group, "sourceId", "group")?;
        let source = sources
            .iter()
            .filter_map(Value::as_object)
            .find(|source| source.get("id").and_then(Value::as_str) == Some(source_id))
            .ok_or_else(|| invalid("group sourceId does not identify a selected source"))?;
        let source_identity = object(
            source
                .get("identity")
                .ok_or_else(|| invalid("source.identity is required"))?,
            "source.identity",
        )?;
        let representative = object(
            group
                .get("representative")
                .ok_or_else(|| invalid("group representative is required"))?,
            "representative",
        )?;
        let file = text(representative, "file", "representative")?;
        let line = representative
            .get("line")
            .and_then(Value::as_u64)
            .unwrap_or(1);
        let column = representative
            .get("column")
            .and_then(Value::as_u64)
            .unwrap_or(1);
        let location = inline_code(&format!("{file}:{line}:{column}"));
        let condition = inline_code(&condition_label(group)?);
        let excerpt = group
            .get("evidence")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(Value::as_object)
            .and_then(|item| item.get("quote"))
            .and_then(Value::as_str)
            .map(inline_code)
            .unwrap_or_else(|| "no bounded excerpt".to_owned());
        let candidates = group
            .get("candidateTargets")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("group.candidateTargets must be an array"))?;
        let candidate_text = if candidates.is_empty() {
            "no candidate extracted".to_owned()
        } else {
            candidates
                .iter()
                .map(reference_label)
                .collect::<Result<Vec<_>>>()?
                .join(", ")
        };
        output.push_str(&format!("- **{} {} / {}** — {} usage(s), route {}; candidate coordinates: {}  \n  Condition: {}  \n  Representative: {}  \n  Source excerpt: {}\n",
            inline_code(text(source, "importName", "source")?), inline_code(text(source_identity, "version", "source.identity")?),
            safe_text(text(group, "export", "group")?), number(group, "count"), inline_code(text(group, "route", "group")?),
            candidate_text, condition, location, excerpt));
    }

    output.push_str("\n## Decisions required\n\n");
    if decisions.is_empty() {
        output.push_str("No supported usage decisions were generated. Review the gaps before treating this as no migration work.\n");
    }
    for (index, decision) in decisions.iter().enumerate() {
        let decision = object(decision, &format!("decisionsRequired[{index}]"))?;
        let group_id = text(decision, "groupId", "decision")?;
        let group = groups
            .iter()
            .filter_map(Value::as_object)
            .find(|group| group.get("id").and_then(Value::as_str) == Some(group_id))
            .ok_or_else(|| invalid("decision.groupId does not identify a usage group"))?;
        let source_id = text(group, "sourceId", "group")?;
        let source = sources
            .iter()
            .filter_map(Value::as_object)
            .find(|source| source.get("id").and_then(Value::as_str) == Some(source_id))
            .ok_or_else(|| invalid("decision group source is unknown"))?;
        let owners = array(decision, "candidateOwners", "decision")?;
        let owner_text = if owners.is_empty() {
            "unassigned".to_owned()
        } else {
            owners
                .iter()
                .filter_map(Value::as_str)
                .map(inline_code)
                .collect::<Vec<_>>()
                .join(", ")
        };
        let usage_refs = array(decision, "usageIds", "decision")?
            .iter()
            .filter_map(Value::as_str)
            .filter_map(|id| {
                usages
                    .iter()
                    .filter_map(Value::as_object)
                    .find(|usage| usage.get("id").and_then(Value::as_str) == Some(id))
            })
            .filter_map(|usage| {
                Some(format!(
                    "{}:{}:{}",
                    usage.get("file")?.as_str()?,
                    usage.get("line")?.as_u64()?,
                    usage.get("column")?.as_u64()?
                ))
            })
            .map(|reference| inline_code(&reference))
            .collect::<Vec<_>>()
            .join(", ");
        let preconditions = array(decision, "preconditions", "decision")?
            .iter()
            .filter_map(Value::as_str)
            .map(safe_text)
            .collect::<Vec<_>>()
            .join("; ");
        let required_checks = array(decision, "requiredChecks", "decision")?
            .iter()
            .filter_map(Value::as_str)
            .map(inline_code)
            .collect::<Vec<_>>()
            .join(", ");
        output.push_str(&format!(
            "{}. **{} / {} — {}**  \n   Condition: {}  \n   Reason: {}  \n   Owner candidate: {} ({})  \n   Usages: {}  \n   Preconditions: {}  \n   Checks to define or confirm: {}  \n   Status: {}\n",
            index + 1,
            inline_code(text(source, "importName", "source")?),
            safe_text(text(group, "export", "group")?),
            safe_text(text(decision, "kind", "decision")?),
            inline_code(&condition_label(group)?),
            safe_text(text(decision, "reason", "decision")?),
            owner_text,
            inline_code(text(decision, "ownerStatus", "decision")?),
            if usage_refs.is_empty() { "none" } else { &usage_refs },
            if preconditions.is_empty() { "none recorded" } else { &preconditions },
            if required_checks.is_empty() { "none recorded" } else { &required_checks },
            inline_code(text(decision, "status", "decision")?)
        ));
    }

    output.push_str("\n## Verification candidates\n\nDeclared checks were discovered as metadata and were not run. Missing categories still need a check definition. Nothing in this section has passed.\n\n");
    let mut verification_count = 0;
    for (index, check) in checks.iter().enumerate() {
        let check = object(check, &format!("verificationCandidates[{index}]"))?;
        if check.get("category").and_then(Value::as_str) == Some("other") {
            continue;
        }
        verification_count += 1;
        output.push_str(&format!("- {}\n", verification_label(check)?));
    }
    if verification_count == 0 {
        output.push_str("- No supported verification candidate was discovered.\n");
    }

    output.push_str("\n### Other declared scripts (not verification recommendations)\n\n");
    let mut other_count = 0;
    for (index, check) in checks.iter().enumerate() {
        let check = object(check, &format!("verificationCandidates[{index}]"))?;
        if check.get("category").and_then(Value::as_str) != Some("other") {
            continue;
        }
        other_count += 1;
        output.push_str(&format!("- {}\n", verification_label(check)?));
    }
    if other_count == 0 {
        output.push_str("- None discovered.\n");
    }

    output.push_str("\n## Gaps and unknowns\n\n");
    if unsupported.is_empty() {
        output
            .push_str("- No unknown reference was reported inside the supported scan boundary.\n");
    }
    for (index, item) in unsupported.iter().enumerate() {
        let item = object(item, &format!("unsupported[{index}]"))?;
        let location = item
            .get("file")
            .and_then(Value::as_str)
            .map(inline_code)
            .unwrap_or_else(|| "repository scope".to_owned());
        output.push_str(&format!(
            "- {}: {} — {}\n",
            location,
            safe_text(text(item, "kind", "unsupported")?),
            safe_text(text(item, "reason", "unsupported")?)
        ));
    }

    output.push_str("\n## Limitations\n\n");
    for (index, limitation) in limitations.iter().enumerate() {
        let limitation = limitation
            .as_str()
            .ok_or_else(|| invalid(format!("limitations[{index}] must be a string")))?;
        output.push_str(&format!("- {}\n", safe_text(limitation)));
    }
    output.push_str("\n## Next review steps\n\n1. Assign an accountable owner to every decision.\n2. Confirm each documented candidate against representative product behavior and accessibility requirements.\n3. Select the checks that must pass; listed checks are discovery evidence only.\n4. Resolve or explicitly accept every gap before authorizing any application change.\n");
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn assessment() -> Value {
        json!({
            "schemaVersion":1,"kind":"consumer-migration-assessment","status":"draft-review","executable":false,
            "repository":{"name":"demo<script>","digest":"a"},
            "target":{"id":"target:1","resolution":"workspace","identity":{"name":"@new/ui","version":"2.0.0"}},
            "sources":[{"id":"source:1","importName":"@old/ui","resolution":"workspace","identity":{"name":"@old/ui","version":"1.0.0"},"contractFile":"contracts/source:1.json"}],
            "usageInventory":{"filesScanned":1,"usages":[{"id":"usage:1","file":"src/a [x].tsx","line":3,"column":2}],"unsupported":[],"coverage":{"status":"scoped"}},
            "mappingGroups":[{"id":"group:1","sourceId":"source:1","export":"Button","condition":{"literalProps":[{"name":"variant","value":"danger<script>"}],"presentProps":["variant","label"],"hasSpread":true,"dynamicProps":["label"]},"usageIds":["usage:1"],"count":1,"route":"decision-required","reviewRequired":true,"target":null,"candidateTargets":[],"contractChangeIds":[],"proposalIds":[],"candidateOwners":[],"evidence":[{"quote":"<Button variant=\"danger\" {...props} /> <script>"}],"representative":{"file":"src/a [x].tsx","line":3,"column":2}}],
            "decisionsRequired":[{"id":"decision:1","groupId":"group:1","kind":"choose-target","reason":"Review <behavior> and `untrusted` prose","usageIds":["usage:1"],"candidateOwners":[],"ownerStatus":"unassigned","status":"needs-review","preconditions":[],"requiredChecks":[]}],
            "verificationCandidates":[
              {"manifest":"package.json","script":"test:e2e","category":"test","status":"declared-not-run"},
              {"ciFile":".github/workflows/ci.yml","category":"ci","status":"declared-not-run"},
              {"category":"storybook","status":"missing"},
              {"manifest":"packages/old/package.json","script":"preinstall","category":"other","status":"declared-not-run"}
            ],
            "limitations":["No `proof` <yet>."]
        })
    }

    #[test]
    fn report_is_explicitly_draft_and_escapes_untrusted_text() {
        let report = render_markdown(&assessment()).unwrap();
        assert!(report.contains("Draft for review"));
        assert!(report.contains("were not run"));
        assert!(report.contains("Nothing in this section has passed"));
        assert!(report.contains("test:e2e"));
        assert!(report.contains("package.json"));
        assert!(report.contains(".github/workflows/ci.yml"));
        assert!(report.contains("missing"));
        assert!(report.contains("storybook"));
        assert!(report.contains("Other declared scripts"));
        assert!(report.contains("preinstall"));
        assert!(report.contains("not verification recommendations"));
        assert!(report.contains("no candidate extracted"));
        assert!(report.contains("bounded migration-document grammar"));
        assert!(report.contains("variant"));
        assert!(report.contains("spread: yes"));
        assert!(report.contains("&lt;Button variant=\"danger\""));
        assert!(report.contains("@old/ui"));
        assert!(report.contains("src/a [x].tsx:3:2"));
        assert!(
            !report.contains("]("),
            "repository-relative locations are not rendered as broken links"
        );
        assert!(!report.contains("unknown check"));
        assert!(report.contains("demo&lt;script&gt;"));
        assert!(report.contains("Review &lt;behavior&gt; and \\`untrusted\\` prose"));
        assert!(!report.contains("<script>"));
    }

    #[test]
    fn report_rejects_executable_or_non_draft_input() {
        let mut value = assessment();
        value["executable"] = Value::Bool(true);
        assert!(
            render_markdown(&value)
                .unwrap_err()
                .to_string()
                .contains("draft, non-executable")
        );
    }

    #[test]
    fn all_other_scripts_leave_the_verification_recommendation_list_explicitly_empty() {
        let mut value = assessment();
        value["verificationCandidates"] = json!([{
            "manifest":"package.json","script":"preinstall","category":"other","status":"declared-not-run"
        }]);
        let report = render_markdown(&value).unwrap();
        assert!(report.contains("No supported verification candidate was discovered"));
        assert!(report.contains("Other declared scripts"));
        assert!(report.contains("preinstall"));
    }
}
