use crate::error::{AppError, Result};
use std::{collections::HashMap, path::PathBuf};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ColorMode {
    #[default]
    Auto,
    Always,
    Never,
}
#[derive(Debug, Clone, Copy, Default)]
pub struct Globals {
    pub color: ColorMode,
    pub quiet: bool,
    pub json: bool,
}

#[derive(Debug, Clone)]
pub struct InferArgs {
    pub from: PathBuf,
    pub to: PathBuf,
    pub compiler: Option<PathBuf>,
    pub out: PathBuf,
    pub node: Option<PathBuf>,
    pub worker: Option<PathBuf>,
    pub timeout_ms: u64,
    pub max_output_bytes: usize,
    pub globals: Globals,
}
#[derive(Debug, Clone)]
pub struct AssessArgs {
    pub repo: Option<PathBuf>,
    pub sources: Vec<String>,
    pub target: String,
    pub compiler: Option<PathBuf>,
    pub out: PathBuf,
    pub node: Option<PathBuf>,
    pub worker: Option<PathBuf>,
    pub timeout_ms: u64,
    pub max_output_bytes: usize,
    pub globals: Globals,
}
#[derive(Debug)]
pub enum Action {
    Help {
        command: Option<&'static str>,
        globals: Globals,
    },
    Version {
        globals: Globals,
    },
    Infer(InferArgs),
    Assess(AssessArgs),
}

pub fn pre_scan(values: &[String]) -> Globals {
    let mut result = Globals::default();
    let mut index = 1;
    while index < values.len() {
        match values[index].as_str() {
            "--json" => result.json = true,
            "--quiet" | "-q" => result.quiet = true,
            "--color" if index + 1 < values.len() => {
                result.color = parse_color(&values[index + 1]).unwrap_or(ColorMode::Auto);
                index += 1;
            }
            _ => {}
        }
        index += 1;
    }
    result
}

fn parse_color(value: &str) -> Option<ColorMode> {
    match value {
        "auto" => Some(ColorMode::Auto),
        "always" => Some(ColorMode::Always),
        "never" => Some(ColorMode::Never),
        _ => None,
    }
}
fn number(
    map: &HashMap<String, String>,
    key: &str,
    default: u64,
    min: u64,
    max: u64,
) -> Result<u64> {
    let value = match map.get(key) {
        Some(v) => v
            .parse::<u64>()
            .map_err(|_| AppError::usage(format!("invalid value for `{key}`")))?,
        None => default,
    };
    if !(min..=max).contains(&value) {
        return Err(AppError::usage(format!(
            "`{key}` must be between {min} and {max}"
        )));
    }
    Ok(value)
}

pub fn parse(values: &[String]) -> Result<Action> {
    let mut globals = Globals::default();
    let mut command = None;
    let mut help = false;
    let mut version = false;
    let mut repo = None;
    let mut sources = Vec::new();
    let mut map = HashMap::new();
    let mut seen = HashMap::<String, ()>::new();
    let mut index = 1;
    while index < values.len() {
        let token = &values[index];
        match token.as_str() {
            "infer" if command.is_none() => command = Some("infer"),
            "assess" if command.is_none() => command = Some("assess"),
            "assess" => return Err(AppError::usage("duplicate command `assess`")),
            "infer" => return Err(AppError::usage("duplicate command `infer`")),
            "--help" | "-h" => {
                if seen.insert("help".into(), ()).is_some() {
                    return Err(AppError::usage("duplicate option `--help`"));
                }
                help = true;
            }
            "--version" | "-V" => {
                if seen.insert("version".into(), ()).is_some() {
                    return Err(AppError::usage("duplicate option `--version`"));
                }
                version = true;
            }
            "--quiet" | "-q" => {
                if seen.insert("quiet".into(), ()).is_some() {
                    return Err(AppError::usage("duplicate option `--quiet`"));
                }
                globals.quiet = true;
            }
            "--json" => {
                if seen.insert("json".into(), ()).is_some() {
                    return Err(AppError::usage("duplicate option `--json`"));
                }
                globals.json = true;
            }
            "--color" => {
                if seen.insert("color".into(), ()).is_some() {
                    return Err(AppError::usage("duplicate option `--color`"));
                }
                index += 1;
                let value = values
                    .get(index)
                    .ok_or_else(|| AppError::usage("missing value for `--color`"))?;
                globals.color = parse_color(value)
                    .ok_or_else(|| AppError::usage("`--color` must be auto, always, or never"))?;
            }
            "--source" if command == Some("assess") => {
                index += 1;
                let value = values
                    .get(index)
                    .ok_or_else(|| AppError::usage("missing value for `--source`"))?;
                if value.starts_with('-') || value.is_empty() {
                    return Err(AppError::usage("invalid value for `--source`"));
                }
                sources.push(value.clone());
            }
            flag @ ("--from" | "--to" | "--compiler" | "--out" | "--node" | "--worker"
            | "--timeout-ms" | "--max-output-bytes" | "--target") => {
                let valid = match command {
                    Some("infer") => flag != "--target",
                    Some("assess") => !["--from", "--to"].contains(&flag),
                    _ => false,
                };
                if !valid {
                    return Err(AppError::usage(format!(
                        "option `{flag}` requires the `infer` command"
                    )));
                }
                if seen.insert(flag.into(), ()).is_some() {
                    return Err(AppError::usage(format!("duplicate option `{flag}`")));
                }
                index += 1;
                let value = values
                    .get(index)
                    .ok_or_else(|| AppError::usage(format!("missing value for `{flag}`")))?;
                if value.starts_with('-') {
                    return Err(AppError::usage(format!("missing value for `{flag}`")));
                }
                map.insert(flag.into(), value.clone());
            }
            unknown if unknown.starts_with('-') => {
                return Err(AppError::usage(format!("unknown option `{unknown}`")));
            }
            other if command == Some("assess") && repo.is_none() => {
                repo = Some(PathBuf::from(other))
            }
            other => return Err(AppError::usage(format!("unexpected argument `{other}`"))),
        }
        index += 1;
    }
    if version {
        if command.is_some() || help {
            return Err(AppError::usage(
                "`--version` cannot be combined with a command or help",
            ));
        }
        return Ok(Action::Version { globals });
    }
    if help || command.is_none() {
        return Ok(Action::Help { command, globals });
    }
    let required = |key: &str| {
        map.get(key)
            .map(PathBuf::from)
            .ok_or_else(|| AppError::usage(format!("missing required option `{key}`")))
    };
    if command == Some("assess") {
        if sources.is_empty() {
            return Err(AppError::usage("at least one `--source` is required"));
        }
        let target = map
            .get("--target")
            .filter(|value| !value.is_empty())
            .cloned()
            .ok_or_else(|| AppError::usage("missing required option `--target`"))?;
        return Ok(Action::Assess(AssessArgs {
            repo,
            sources,
            target,
            compiler: map.get("--compiler").map(PathBuf::from),
            out: required("--out")?,
            node: map.get("--node").map(PathBuf::from),
            worker: map.get("--worker").map(PathBuf::from),
            timeout_ms: number(&map, "--timeout-ms", 30_000, 100, 300_000)?,
            max_output_bytes: number(
                &map,
                "--max-output-bytes",
                32 * 1024 * 1024,
                1024,
                32 * 1024 * 1024,
            )? as usize,
            globals,
        }));
    }
    Ok(Action::Infer(InferArgs {
        from: required("--from")?,
        to: required("--to")?,
        compiler: map.get("--compiler").map(PathBuf::from),
        out: required("--out")?,
        node: map.get("--node").map(PathBuf::from),
        worker: map.get("--worker").map(PathBuf::from),
        timeout_ms: number(&map, "--timeout-ms", 30_000, 100, 300_000)?,
        max_output_bytes: number(
            &map,
            "--max-output-bytes",
            32 * 1024 * 1024,
            1024,
            32 * 1024 * 1024,
        )? as usize,
        globals,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }
    #[test]
    fn help_bypasses_required() {
        assert!(matches!(
            parse(&args(&["x", "infer", "--help"])).unwrap(),
            Action::Help {
                command: Some("infer"),
                ..
            }
        ));
    }
    #[test]
    fn globals_work_before_command() {
        let Action::Infer(parsed) = parse(&args(&[
            "x", "--json", "infer", "--from", "a", "--to", "b", "--out", "c",
        ]))
        .unwrap() else {
            panic!()
        };
        assert!(parsed.globals.json);
    }
    #[test]
    fn rejects_duplicate() {
        assert_eq!(
            parse(&args(&["x", "infer", "--from", "a", "--from", "b"]))
                .unwrap_err()
                .exit,
            2
        );
    }
    #[test]
    fn rejects_unknown() {
        assert_eq!(
            parse(&args(&["x", "infer", "--wat", "a"]))
                .unwrap_err()
                .exit,
            2
        );
    }
}
