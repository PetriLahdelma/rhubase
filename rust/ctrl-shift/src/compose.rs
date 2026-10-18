use crate::{
    cli::ComposeArgs,
    compiler::CompilerGuard,
    composition,
    error::{AppError, Result},
    paths::{self, DirectoryTarget, FileGuard, TreeGuard},
    process::{self, WorkerSpec},
    protocol::{self, Outcome},
    terminal::Terminal,
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    env,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub struct Completed {
    pub blueprint: Value,
    pub path: PathBuf,
}
fn text(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| AppError::new("path is not UTF-8"))
}
fn seed_part(seed: &mut Vec<u8>, value: &[u8]) {
    seed.extend_from_slice(&(value.len() as u64).to_be_bytes());
    seed.extend_from_slice(value)
}
fn source_binding_ids(values: &[String]) -> Result<Vec<String>> {
    values
        .iter()
        .map(|value| {
            let (id, path) = value
                .split_once('=')
                .ok_or_else(|| AppError::usage("compose `--source` must use ID=DIR"))?;
            if path.is_empty() {
                return Err(AppError::usage("compose `--source` must use ID=DIR"));
            }
            Ok(id.to_owned())
        })
        .collect()
}
fn initialized_project(values: &[String], target: &str) -> Result<composition::Project> {
    let source_ids = source_binding_ids(values)?;
    let project = composition::Project {
        schema_version: 1,
        kind: "rhubase-composition-project".into(),
        title: "Shared foundation".into(),
        sources: source_ids
            .iter()
            .map(|id| composition::ProjectSource {
                id: id.clone(),
                digest: None,
                declared_modes: Vec::new(),
            })
            .collect(),
        scenarios: vec![composition::Scenario {
            id: "baseline".into(),
            title: "Baseline".into(),
            included_sources: source_ids,
            target: composition::Target {
                name: target.into(),
                mode: "new".into(),
                base_source: None,
            },
            selections: Vec::new(),
            dependencies: Vec::new(),
            architecture: composition::Architecture {
                layout: "colocated".into(),
                topology: "single-package".into(),
                delivery: "minimal".into(),
                delivery_source: None,
            },
        }],
    };
    composition::validate_project(&project)?;
    Ok(project)
}
fn bindings(
    values: &[String],
    project: &composition::Project,
) -> Result<BTreeMap<String, TreeGuard>> {
    let expected: HashSet<_> = project
        .sources
        .iter()
        .map(|source| source.id.as_str())
        .collect();
    let mut result = BTreeMap::new();
    let mut roots = HashSet::new();
    let mut identities = HashSet::new();
    for value in values {
        let (id, path) = value
            .split_once('=')
            .ok_or_else(|| AppError::usage("compose `--source` must use ID=DIR"))?;
        if !expected.contains(id) || result.contains_key(id) || path.is_empty() {
            return Err(AppError::usage(
                "compose source bindings must name every project source exactly once",
            ));
        }
        let guard = TreeGuard::open(Path::new(path))?;
        if !roots.insert(guard.root.clone()) {
            return Err(AppError::new("composition source roots must be distinct"));
        }
        if !identities.insert((
            guard.package_name.clone(),
            guard.package_version.clone(),
            guard.node_digest.clone(),
        )) {
            return Err(AppError::new(
                "composition source package identities must be distinct",
            ));
        }
        result.insert(id.to_owned(), guard);
    }
    if result.len() != expected.len() {
        return Err(AppError::usage(
            "compose source bindings must name every project source exactly once",
        ));
    }
    Ok(result)
}
pub fn execute(
    args: ComposeArgs,
    terminal: &Terminal,
    checkout: &Path,
    cancelled: &Arc<AtomicBool>,
) -> Result<Completed> {
    if env::var_os("NODE_OPTIONS").is_some_and(|value| !value.is_empty()) {
        return Err(AppError::new("NODE_OPTIONS must be unset"));
    }
    terminal.run_mark("compose");
    terminal.stage("Validating composition project", false);
    let (project, project_guard, project_reference) = if let Some(requested) = &args.project {
        let project_path = paths::canonical_file(requested, "composition project")?;
        let project_sha = paths::sha256_file(&project_path)?;
        let project = composition::read_project(&project_path)?;
        if paths::sha256_file(&project_path)? != project_sha {
            return Err(AppError::new(
                "composition project changed while it was being read",
            ));
        }
        let reference = text(&project_path)?.to_owned();
        (project, Some((project_path, project_sha)), reference)
    } else if args.init {
        let target = args
            .target
            .as_deref()
            .ok_or_else(|| AppError::usage("missing required option `--target` for `--init`"))?;
        let project = initialized_project(&args.sources, target)?;
        let reference = format!(
            "init:{}",
            paths::sha256_bytes(&serde_json::to_vec(&project)?)
        );
        (project, None, reference)
    } else {
        return Err(AppError::usage(
            "compose requires either `--project` or `--init`",
        ));
    };
    let guards = bindings(&args.sources, &project)?;
    let node = paths::resolve_node(args.node.as_deref())?;
    let worker = paths::canonical_file(
        &checkout.join("src/composition-worker.mjs"),
        "composition worker",
    )?;
    let engine = ["composition-worker.mjs", "snapshot-api.mjs", "files.mjs"]
        .map(|name| checkout.join("src").join(name));
    for file in &engine {
        if !file.is_file() {
            return Err(AppError::new(format!(
                "composition engine file missing: {}",
                file.display()
            )));
        }
    }
    let protected_sources = guards
        .values()
        .map(|guard| guard.root.clone())
        .chain([checkout.to_path_buf()])
        .collect::<Vec<_>>();
    let compiler = CompilerGuard::resolve(
        args.compiler.as_deref(),
        checkout,
        &[],
        checkout,
        &protected_sources,
    )?;
    let guarded_files = [node.clone(), worker.clone(), compiler.original.clone()]
        .into_iter()
        .chain(project_guard.as_ref().map(|(path, _)| path.clone()))
        .chain(engine)
        .collect::<Vec<_>>();
    let tools = FileGuard::new(guarded_files.clone())?;
    if let Some((project_path, project_sha)) = &project_guard
        && paths::sha256_file(project_path)? != *project_sha
    {
        return Err(AppError::new(
            "composition project changed before its guard was established",
        ));
    }
    let mut protected = guards
        .values()
        .map(|guard| guard.root.as_path())
        .collect::<Vec<_>>();
    protected.push(checkout);
    protected.push(node.parent().unwrap_or(&node));
    protected.push(worker.parent().unwrap_or(&worker));
    protected.push(compiler.original.parent().unwrap_or(&compiler.original));
    protected.push(compiler.path.parent().unwrap_or(&compiler.path));
    let output = DirectoryTarget::new(&args.out, &protected)?;
    terminal.stage("Composition inputs accepted", true);
    terminal.stage("Extracting bounded source facts", false);
    let source_params = project
        .sources
        .iter()
        .map(|source| {
            let guard = &guards[&source.id];
            serde_json::json!({"id":source.id,"root":text(&guard.root).unwrap()})
        })
        .collect::<Vec<_>>();
    let params = serde_json::json!({"compiler":text(&compiler.path)?,"sources":source_params});
    let mut seed = Vec::new();
    for value in [
        "1",
        "extract-composition",
        &project_reference,
        text(&compiler.path)?,
        text(&node)?,
        text(&worker)?,
    ] {
        seed_part(&mut seed, value.as_bytes())
    }
    for guard in guards.values() {
        seed_part(&mut seed, guard.node_digest.as_bytes())
    }
    for path in &guarded_files {
        seed_part(&mut seed, paths::sha256_file(path)?.as_bytes())
    }
    let request_id = protocol::request_id(&seed);
    let request = protocol::encode_method_request(&request_id, "extract-composition", params)?;
    let path_env = paths::minimal_path(&node);
    let spec = WorkerSpec {
        node: &node,
        worker: &worker,
        timeout_ms: args.timeout_ms,
        stdout_cap: args.max_output_bytes,
        stderr_cap: 1024 * 1024,
        path_env: &path_env,
    };
    let process_result = process::run_worker(&spec, request, cancelled)?;
    let outcome = protocol::decode_envelope(&process_result.stdout, &request_id)?;
    let extraction = match (process_result.status.success(), outcome) {
        (true, Outcome::Success(value)) if process_result.stderr.is_empty() => value,
        (false, Outcome::Failure { code, message }) => {
            let expected = format!("ctrl+shift composition worker: {code}: {message}\n");
            if process_result.stderr != expected.as_bytes() {
                return Err(AppError::new("composition worker diagnostic mismatch"));
            }
            return Err(AppError::new(format!(
                "composition worker {code}: {message}"
            )));
        }
        _ => return Err(AppError::new("composition worker exit/envelope mismatch")),
    };
    terminal.stage("Validating source facts and evidence", false);
    let facts = composition::validate_extraction(&extraction, &project, &guards)?;
    let (pinned, blueprint, review) = composition::build_blueprint(&project, &facts)?;
    terminal.stage("Composition evidence accepted", true);
    if cancelled.load(Ordering::SeqCst) {
        return Err(AppError::interrupted("interrupted"));
    }
    terminal.stage("Saving draft composition blueprint", false);
    let path = composition::publish(output, &pinned, &blueprint, &review, || {
        if cancelled.load(Ordering::SeqCst) || !compiler.unchanged()? || !tools.unchanged()? {
            return Err(AppError::new(
                "composition inputs or tools changed during execution",
            ));
        }
        for guard in guards.values() {
            if !guard.unchanged()? {
                return Err(AppError::new("composition source changed during execution"));
            }
        }
        Ok(())
    })?;
    terminal.stage("Draft composition blueprint saved", true);
    Ok(Completed { blueprint, path })
}
