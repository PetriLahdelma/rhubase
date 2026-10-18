use crate::{composition::Project, error::Result};
use serde_json::Value;
use sha2::{Digest, Sha256};

const TEMPLATE: &str = include_str!("../../../src/composition-workspace.html");
const SCRIPT: &str = include_str!("../../../src/composition-workspace.mjs");
const STYLE: &str = include_str!("../../../src/composition-workspace.css");
const LOGO: &str = include_str!("../../../assets/brand/rhubase/gap-variants/rhubase-gap-1.svg");

fn script_json(value: &impl serde::Serialize) -> Result<String> {
    Ok(serde_json::to_string(value)?
        .replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029"))
}

// CSP expects the standard base64 representation of a SHA-256 digest.
fn content_hash(content: &str) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let digest = Sha256::digest(content.as_bytes());
    let mut result = String::with_capacity(44);
    for chunk in digest.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        result.push(ALPHABET[(a >> 2) as usize] as char);
        result.push(ALPHABET[(((a & 3) << 4) | (b >> 4)) as usize] as char);
        result.push(if chunk.len() > 1 {
            ALPHABET[(((b & 15) << 2) | (c >> 6)) as usize] as char
        } else {
            '='
        });
        result.push(if chunk.len() > 2 {
            ALPHABET[(c & 63) as usize] as char
        } else {
            '='
        });
    }
    result
}

pub fn render(project: &Project, blueprint: &Value) -> Result<String> {
    let project_json = script_json(project)?;
    let blueprint_json = script_json(blueprint)?;
    let logo = LOGO.replace("viewBox=\"0 0 80 80\"", "viewBox=\"4 29 73 22\"");
    let template = TEMPLATE
        .replace(
            "style-src 'nonce-rhubase-workspace'",
            &format!("style-src 'sha256-{}'", content_hash(STYLE)),
        )
        .replace(
            "script-src 'nonce-rhubase-workspace'",
            &format!("script-src 'sha256-{}'", content_hash(SCRIPT)),
        )
        .replace(" nonce=\"rhubase-workspace\"", "");
    let slots = [
        ("__WORKSPACE_CSS__", STYLE),
        ("__WORKSPACE_JS__", SCRIPT),
        ("__PROJECT_JSON__", project_json.as_str()),
        ("__BLUEPRINT_JSON__", blueprint_json.as_str()),
        ("__RHUBASE_LOGO__", logo.as_str()),
    ];
    // Scan only the trusted template: placeholder-shaped user text remains data.
    let mut rest = template.as_str();
    let mut output = String::new();
    while let Some((offset, marker, replacement)) = slots
        .iter()
        .filter_map(|(marker, replacement)| rest.find(marker).map(|n| (n, *marker, *replacement)))
        .min_by_key(|(offset, _, _)| *offset)
    {
        output.push_str(&rest[..offset]);
        output.push_str(replacement);
        rest = &rest[offset + marker.len()..];
    }
    output.push_str(rest);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn content_hash_matches_standard_sha256_base64() {
        assert_eq!(
            content_hash("abc"),
            "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="
        );
    }

    #[test]
    fn embedded_user_text_is_not_markup_or_a_template() {
        let project: Project = serde_json::from_value(json!({
            "schemaVersion": 1, "kind": "rhubase-composition-project",
            "title": "</script><img onerror=alert(1)> __BLUEPRINT_JSON__ & \u{2028}",
            "sources": [], "scenarios": []
        }))
        .unwrap();
        let blueprint = json!({"title": "__WORKSPACE_JS__ </script>"});
        let output = render(&project, &blueprint).unwrap();
        assert!(!output.contains("<img onerror"));
        assert!(!output.contains("nonce="));
        assert!(!output.contains("unsafe-inline"));
        assert!(output.contains(&format!("script-src 'sha256-{}'", content_hash(SCRIPT))));
        assert!(output.contains("connect-src 'none'"));
        let project_data = output
            .split("id=\"rhubase-project\">")
            .nth(1)
            .unwrap()
            .split("</script>")
            .next()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(project_data).unwrap()["title"],
            project.title
        );
        let blueprint_data = output
            .split("id=\"rhubase-blueprint\">")
            .nth(1)
            .unwrap()
            .split("</script>")
            .next()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(blueprint_data).unwrap(),
            blueprint
        );
    }
}
