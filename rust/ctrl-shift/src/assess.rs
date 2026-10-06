use crate::{
    assessment::{self},
    cli::AssessArgs,
    compiler::CompilerGuard,
    error::{AppError, Result},
    paths::{self, DirectoryTarget, FileGuard, TreeGuard},
    process::{self, WorkerSpec},
    protocol::{self, Outcome},
    terminal::Terminal,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
pub struct Completed {
    pub assessment: Value,
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
fn run_phase(
    worker: &Path,
    node: &Path,
    method: &str,
    params: Value,
    seed_values: &[&str],
    args: &AssessArgs,
    cancelled: &Arc<AtomicBool>,
) -> Result<Value> {
    let mut seed = Vec::new();
    for value in seed_values {
        seed_part(&mut seed, value.as_bytes())
    }
    let id = protocol::request_id(&seed);
    let request = protocol::encode_method_request(&id, method, params)?;
    let path_env = paths::minimal_path(node);
    let spec = WorkerSpec {
        node,
        worker,
        timeout_ms: args.timeout_ms,
        stdout_cap: args.max_output_bytes,
        stderr_cap: 1024 * 1024,
        path_env: &path_env,
    };
    let output = process::run_worker(&spec, request, cancelled)?;
    let outcome = protocol::decode_envelope(&output.stdout, &id)?;
    match (output.status.success(), outcome) {
        (true, Outcome::Success(value)) if output.stderr.is_empty() => Ok(value),
        (false, Outcome::Failure { code, message }) => {
            let expected = format!("ctrl+shift assessment worker: {code}: {message}\n");
            if output.stderr != expected.as_bytes() {
                return Err(AppError::new("assessment worker diagnostic mismatch"));
            }
            Err(AppError::new(format!(
                "assessment worker {code}: {message}"
            )))
        }
        _ => Err(AppError::new("assessment worker exit/envelope mismatch")),
    }
}
fn package_guard(package: &assessment::ResolvedPackage) -> Result<TreeGuard> {
    let guard = TreeGuard::open(Path::new(&package.root))?;
    if guard.package_name != package.identity.name
        || guard.package_version != package.identity.version
    {
        return Err(AppError::new("resolved package identity mismatch"));
    }
    Ok(guard)
}

pub fn execute(
    args: AssessArgs,
    terminal: &Terminal,
    checkout: &Path,
    cancelled: &Arc<AtomicBool>,
) -> Result<Completed> {
    if env::var_os("NODE_OPTIONS").is_some_and(|value| !value.is_empty()) {
        return Err(AppError::new("NODE_OPTIONS must be unset"));
    }
    terminal.run_mark("assess");
    terminal.stage("Resolving repository and design systems", false);
    let repo_input = args.repo.clone().unwrap_or(env::current_dir()?);
    let repo_meta = fs::symlink_metadata(&repo_input)?;
    if repo_meta.file_type().is_symlink() || !repo_meta.is_dir() {
        return Err(AppError::new(
            "assessment repository must be a real directory",
        ));
    }
    let repo = fs::canonicalize(repo_input)?;
    let node = paths::resolve_node(args.node.as_deref())?;
    let default_worker = checkout.join("src/assessment-worker.mjs");
    let worker = paths::canonical_file(
        args.worker.as_deref().unwrap_or(&default_worker),
        "assessment worker",
    )?;
    let core = [
        "assessment-worker.mjs",
        "consumer-assessment.mjs",
        "consumer-discovery.mjs",
        "consumer-usages.mjs",
        "inference.mjs",
        "snapshot-api.mjs",
        "source-analysis.mjs",
        "files.mjs",
    ]
    .map(|name| checkout.join("src").join(name));
    for file in &core {
        if !file.is_file() {
            return Err(AppError::new(format!(
                "assessment engine file missing: {}",
                file.display()
            )));
        }
    }
    let guarded = [node.clone(), worker.clone()]
        .into_iter()
        .chain(core)
        .collect::<Vec<_>>();
    let tools = FileGuard::new(guarded.clone())?;
    let engine_seed = guarded
        .iter()
        .map(|path| paths::sha256_file(path))
        .collect::<Result<Vec<_>>>()?
        .join(":");
    let repo_text = text(&repo)?;
    let selector_value = serde_json::to_string(&(&args.sources, &args.target))?;
    let resolution = run_phase(
        &worker,
        &node,
        "resolve-assessment",
        serde_json::json!({"repo":repo_text,"sources":args.sources,"target":args.target}),
        &[
            "1",
            "resolve-assessment",
            repo_text,
            &selector_value,
            &engine_seed,
        ],
        &args,
        cancelled,
    )?;
    let (resolution, repository_guard) = assessment::validate_resolution(&resolution, &repo)?;
    terminal.stage("Repository and systems resolved", true);
    let mut source_guards = HashMap::new();
    for source in &resolution.sources {
        source_guards.insert(source.id.clone(), package_guard(source)?);
    }
    let target_guard = package_guard(&resolution.target)?;
    let workspace_roots = resolution
        .repository
        .get("workspaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("path").and_then(Value::as_str))
        .map(|relative| repo.join(relative))
        .collect::<Vec<_>>();
    let package_roots = resolution
        .sources
        .iter()
        .chain([&resolution.target])
        .map(|package| PathBuf::from(&package.root))
        .collect::<Vec<_>>();
    let mut compiler_protected = vec![repo.clone(), checkout.to_path_buf()];
    compiler_protected.extend(package_roots);
    let compiler = CompilerGuard::resolve(
        args.compiler.as_deref(),
        &repo,
        &workspace_roots,
        checkout,
        &compiler_protected,
    )?;
    let compiler_sha = compiler.sha256().to_owned();
    let mut protected: Vec<&Path> = vec![repo.as_path()];
    for guard in source_guards.values() {
        protected.push(guard.root.as_path())
    }
    protected.push(target_guard.root.as_path());
    protected.push(checkout);
    protected.push(node.parent().unwrap_or(&node));
    protected.push(worker.parent().unwrap_or(&worker));
    protected.push(compiler.original.parent().unwrap_or(&compiler.original));
    protected.push(compiler.path.parent().unwrap_or(&compiler.path));
    let output = DirectoryTarget::new(&args.out, &protected)?;
    terminal.stage("Inventorying consumer usage and decisions", false);
    let second_seed = format!("{}:{}:{}", repo_text, resolution.digest, compiler_sha);
    let result = run_phase(
        &worker,
        &node,
        "assess",
        serde_json::json!({"repo":repo_text,"sources":args.sources,"target":args.target,"compiler":text(&compiler.path)?,"expectedResolutionDigest":resolution.digest}),
        &["1", "assess", &second_seed, &engine_seed],
        &args,
        cancelled,
    )?;
    terminal.stage("Assessment worker response received", true);
    terminal.stage("Validating assessment evidence", false);
    let validated = assessment::validate_result(
        &result,
        &resolution,
        &repository_guard,
        &source_guards,
        &target_guard,
        &compiler_sha,
    )?;
    terminal.stage("Assessment evidence accepted", true);
    terminal.stage("Saving draft assessment", false);
    let path = assessment::publish_report(output, &validated, || {
        let final_resolution = run_phase(
            &worker,
            &node,
            "resolve-assessment",
            serde_json::json!({"repo":repo_text,"sources":args.sources,"target":args.target}),
            &[
                "1",
                "resolve-assessment-final",
                repo_text,
                &selector_value,
                &engine_seed,
            ],
            &args,
            cancelled,
        )?;
        let (final_resolution, final_repository_guard) =
            assessment::validate_resolution(&final_resolution, &repo)?;
        if final_resolution.digest != resolution.digest || !final_repository_guard.unchanged()? {
            return Err(AppError::new(
                "assessment resolution changed during execution",
            ));
        }
        if cancelled.load(Ordering::SeqCst)
            || !repository_guard.unchanged()?
            || !target_guard.unchanged()?
            || !compiler.unchanged()?
            || !tools.unchanged()?
        {
            return Err(AppError::new(
                "assessment inputs or tools changed during execution",
            ));
        }
        for guard in source_guards.values() {
            if !guard.unchanged()? {
                return Err(AppError::new("assessment package changed during execution"));
            }
        }
        Ok(())
    })?;
    terminal.stage("Draft assessment saved", true);
    Ok(Completed {
        assessment: validated.assessment,
        path,
    })
}
