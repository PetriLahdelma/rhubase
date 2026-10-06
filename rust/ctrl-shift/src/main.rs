use ctrl_shift::{
    assess,
    cli::{self, Action, InferArgs},
    error::{AppError, Result},
    paths::{self, FileGuard, OutputTarget, TreeGuard},
    process,
    protocol::{self, Outcome},
    terminal::{
        self, AssessmentSummary, JsonCounts, JsonError, JsonErrorBody, JsonHelp, JsonSuccess,
        JsonVersion, Summary, Terminal,
    },
    validate::{self, ValidationContext},
};
use serde_json::Value;
use std::{
    env,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

fn text(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| AppError::new("path is not UTF-8"))
}
fn checkout_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .components()
        .collect()
}
fn seed_part(seed: &mut Vec<u8>, value: &[u8]) {
    seed.extend_from_slice(&(value.len() as u64).to_be_bytes());
    seed.extend_from_slice(value)
}
fn field<'a>(value: &'a Value, key: &str) -> Result<&'a Value> {
    value
        .get(key)
        .ok_or_else(|| AppError::new(format!("validated contract missing {key}")))
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    field(value, key)?
        .as_str()
        .ok_or_else(|| AppError::new(format!("validated contract {key} is not text")))
}
fn len(value: &Value, key: &str) -> Result<usize> {
    field(value, key)?
        .as_array()
        .map(Vec::len)
        .ok_or_else(|| AppError::new(format!("validated contract {key} is not an array")))
}

struct Completed {
    contract: Value,
    path: PathBuf,
}

fn execute(args: InferArgs, terminal: &Terminal, cancelled: &Arc<AtomicBool>) -> Result<Completed> {
    let compiler = args
        .compiler
        .or_else(|| {
            env::var_os("SHIFT_TYPESCRIPT_PATH")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        })
        .ok_or_else(|| AppError::usage("TypeScript compiler is required."))?;
    terminal.run_mark("infer");
    terminal.stage("Inspecting snapshots", false);
    if env::var_os("NODE_OPTIONS").is_some_and(|value| !value.is_empty()) {
        return Err(AppError::new("NODE_OPTIONS must be unset"));
    }
    let from = TreeGuard::open(&args.from)?;
    let to = TreeGuard::open(&args.to)?;
    if from.root == to.root {
        return Err(AppError::new("old and new snapshots must differ"));
    }
    let output = OutputTarget::new(&args.out, &[&from.root, &to.root])?;
    let node = paths::resolve_node(args.node.as_deref())?;
    let compiler = paths::canonical_file(&compiler, "TypeScript compiler")?;
    let checkout = checkout_root();
    let default_worker = checkout.join("src/inference-worker.mjs");
    let worker = paths::canonical_file(
        args.worker.as_deref().unwrap_or(&default_worker),
        "inference worker",
    )?;
    let source_root = checkout.join("src");
    let engine = [
        "inference.mjs",
        "snapshot-api.mjs",
        "source-analysis.mjs",
        "files.mjs",
    ]
    .map(|name| source_root.join(name));
    for file in &engine {
        if !file.is_file() {
            return Err(AppError::new(format!(
                "engine file missing: {}",
                file.display()
            )));
        }
    }
    let guarded_paths = [node.clone(), compiler.clone(), worker.clone()]
        .into_iter()
        .chain(engine)
        .collect::<Vec<_>>();
    let tool_guard = FileGuard::new(guarded_paths.clone())?;
    let compiler_sha = paths::sha256_file(&compiler)?;
    terminal.stage("Inputs accepted", true);
    terminal.stage("Comparing public APIs and tokens", false);
    let mut seed = Vec::new();
    for value in [
        "1",
        "infer",
        text(&from.root)?,
        text(&to.root)?,
        text(&compiler)?,
        text(&node)?,
        text(&worker)?,
        &from.fingerprint,
        &to.fingerprint,
    ] {
        seed_part(&mut seed, value.as_bytes())
    }
    for path in &guarded_paths {
        seed_part(&mut seed, paths::sha256_file(path)?.as_bytes())
    }
    let request_id = protocol::request_id(&seed);
    let request = protocol::encode_request(
        &request_id,
        text(&from.root)?,
        text(&to.root)?,
        text(&compiler)?,
    )?;
    let path_env = paths::minimal_path(&node);
    let spec = process::WorkerSpec {
        node: &node,
        worker: &worker,
        timeout_ms: args.timeout_ms,
        stdout_cap: args.max_output_bytes,
        stderr_cap: 1024 * 1024,
        path_env: &path_env,
    };
    let result = process::run_worker(&spec, request, cancelled)?;
    if result.status.success() && !result.stderr.is_empty() {
        return Err(AppError::new("successful worker wrote to stderr"));
    }
    let outcome = protocol::decode_envelope(&result.stdout, &request_id)?;
    let contract = match (result.status.success(), outcome) {
        (true, Outcome::Success(value)) => value,
        (false, Outcome::Failure { code, message }) => {
            let expected = format!("shift inference worker: {code}: {message}\n");
            if result.stderr != expected.as_bytes() {
                return Err(AppError::new("worker error diagnostic mismatch"));
            }
            return Err(AppError::new(format!("worker {code}: {message}")));
        }
        (false, Outcome::Success(_)) => {
            return Err(AppError::new(
                "worker returned success envelope with nonzero exit",
            ));
        }
        (true, Outcome::Failure { code, message }) => {
            return Err(AppError::new(format!(
                "worker returned error envelope with zero exit: {code}: {message}"
            )));
        }
    };
    terminal.stage("Worker response received", true);
    terminal.stage("Validating contract evidence", false);
    validate::validate_contract(
        &contract,
        &ValidationContext {
            from: &from,
            to: &to,
            compiler_sha256: &compiler_sha,
        },
    )?;
    terminal.stage("Evidence references accepted", true);
    if cancelled.load(Ordering::SeqCst) {
        return Err(AppError::interrupted("interrupted"));
    }
    if !from.unchanged()? || !to.unchanged()? {
        return Err(AppError::new("input snapshot changed during inference"));
    }
    if !tool_guard.unchanged()? {
        return Err(AppError::new(
            "worker/compiler/engine changed during inference",
        ));
    }
    if cancelled.load(Ordering::SeqCst) {
        return Err(AppError::interrupted("interrupted"));
    }
    terminal.stage("Saving draft contract", false);
    let mut bytes = serde_json::to_vec(&contract)?;
    bytes.push(b'\n');
    if cancelled.load(Ordering::SeqCst) {
        return Err(AppError::interrupted("interrupted"));
    }
    output.publish(&bytes)?;
    terminal.stage("Draft contract saved", true);
    Ok(Completed {
        contract,
        path: output.final_path,
    })
}

fn human_summary(completed: &Completed) -> Result<Summary<'_>> {
    let from = field(&completed.contract, "from")?;
    let to = field(&completed.contract, "to")?;
    Ok(Summary {
        old_name: string(from, "name")?,
        old_version: string(from, "version")?,
        new_name: string(to, "name")?,
        new_version: string(to, "version")?,
        changes: len(&completed.contract, "changes")?,
        proposals: len(&completed.contract, "proposals")?,
        unresolved: len(&completed.contract, "unresolved")?,
        status: string(&completed.contract, "status")?,
        path: &completed.path,
    })
}

fn write_stderr(bytes: &[u8]) -> std::io::Result<()> {
    match std::io::Write::write_all(&mut std::io::stderr(), bytes) {
        Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
        result => result,
    }
}
fn emit_error(terminal: &Terminal, error: &AppError) -> bool {
    if terminal.json() {
        let hint = terminal::hint(error);
        let body = JsonError {
            schema_version: 1,
            kind: "ctrl-shift-error",
            error: JsonErrorBody {
                code: terminal::error_code(error),
                message: terminal::bound_text(&terminal::message(error), 2048),
                hint: hint.map(|value| terminal::bound_text(&value, 2048)),
            },
            exit_code: error.exit,
        };
        terminal.write_json(&body).is_ok()
    } else {
        write_stderr(terminal.error_text(error).as_bytes()).is_ok()
    }
}

fn run_main() -> i32 {
    let raw = env::args().collect::<Vec<_>>();
    let scanned = cli::pre_scan(&raw);
    let action = match cli::parse(&raw) {
        Ok(action) => action,
        Err(error) => {
            let terminal = Terminal::new(scanned);
            return if emit_error(&terminal, &error) {
                error.exit
            } else {
                1
            };
        }
    };
    let globals = match &action {
        Action::Help { globals, .. }
        | Action::Version { globals }
        | Action::Infer(InferArgs { globals, .. })
        | Action::Assess(cli::AssessArgs { globals, .. }) => *globals,
    };
    let terminal = Terminal::new(globals);
    let cancelled = Arc::new(AtomicBool::new(false));
    if matches!(&action, Action::Infer(_) | Action::Assess(_)) {
        let signal = Arc::clone(&cancelled);
        if let Err(error) = ctrlc::set_handler(move || signal.store(true, Ordering::SeqCst))
            .map_err(|error| AppError::new(format!("cannot register signal handler: {error}")))
        {
            return if emit_error(&terminal, &error) {
                error.exit
            } else {
                1
            };
        }
    }
    match action {
        Action::Help { command, .. } => {
            let help = terminal.help(command);
            if globals.json {
                if terminal
                    .write_json(&JsonHelp {
                        schema_version: 1,
                        kind: "ctrl-shift-help",
                        command,
                        text: &help,
                    })
                    .is_err()
                {
                    return 1;
                }
            } else if !globals.quiet && terminal.write_text(&help).is_err() {
                return 1;
            }
            0
        }
        Action::Version { .. } => {
            if globals.json {
                if terminal
                    .write_json(&JsonVersion {
                        schema_version: 1,
                        kind: "ctrl-shift-version",
                        version: terminal::version(),
                    })
                    .is_err()
                {
                    return 1;
                }
            } else if !globals.quiet {
                let text = format!("{} {}\n", terminal.program_name(), terminal::version());
                if terminal.write_text(&text).is_err() {
                    return 1;
                }
            }
            0
        }
        Action::Infer(args) => match execute(args, &terminal, &cancelled) {
            Ok(completed) => {
                let summary = match human_summary(&completed) {
                    Ok(value) => value,
                    Err(_error) => {
                        if globals.json {
                            return 1;
                        }
                        let _ = write_stderr(
                            b"Contract saved, but its summary could not be prepared.\n",
                        );
                        return 1;
                    }
                };
                if globals.json {
                    let path = completed.path.to_string_lossy();
                    let json = JsonSuccess {
                        schema_version: 1,
                        kind: "ctrl-shift-run-summary",
                        command: "infer",
                        status: "draft-contract-saved",
                        contract_path: &path,
                        counts: JsonCounts {
                            changes: summary.changes,
                            proposals_needing_review: summary.proposals,
                            unresolved: summary.unresolved,
                        },
                        inputs_changed: false,
                    };
                    if terminal.write_json(&json).is_err() {
                        return 1;
                    }
                } else if terminal.summary(&summary).is_err() {
                    let _ =
                        write_stderr(b"Contract saved, but its summary could not be written.\n");
                    return 1;
                }
                0
            }
            Err(error) => {
                if emit_error(&terminal, &error) {
                    error.exit
                } else {
                    1
                }
            }
        },
        Action::Assess(args) => {
            match assess::execute(args, &terminal, &checkout_root(), &cancelled) {
                Ok(completed) => {
                    if globals.quiet && !globals.json {
                        return 0;
                    }
                    let usages = completed
                        .assessment
                        .pointer("/usageInventory/usages")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len);
                    let groups = completed
                        .assessment
                        .get("mappingGroups")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len);
                    let decisions = completed
                        .assessment
                        .get("decisionsRequired")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len);
                    if globals.json {
                        let value = serde_json::json!({"schemaVersion":1,"kind":"ctrl-shift-assessment-summary","command":"assess","status":"draft-assessment-saved","reportPath":completed.path,"counts":{"usages":usages,"mappingGroups":groups,"decisionsRequired":decisions},"inputsChanged":false});
                        if terminal.write_json(&value).is_err() {
                            return 1;
                        }
                    } else {
                        let repository = completed
                            .assessment
                            .pointer("/repository/name")
                            .and_then(Value::as_str)
                            .unwrap_or("(unnamed repository)");
                        let target_name = completed
                            .assessment
                            .pointer("/target/identity/name")
                            .and_then(Value::as_str)
                            .unwrap_or("(unknown target)");
                        let target_version = completed
                            .assessment
                            .pointer("/target/identity/version")
                            .and_then(Value::as_str)
                            .unwrap_or("(unknown version)");
                        let target = format!("{target_name} {target_version}");
                        let sources = completed
                            .assessment
                            .get("sources")
                            .and_then(Value::as_array)
                            .map_or(0, Vec::len);
                        let summary = AssessmentSummary {
                            repository,
                            target: &target,
                            sources,
                            usages,
                            groups,
                            decisions,
                            path: &completed.path,
                        };
                        if terminal.assessment_summary(&summary).is_err() {
                            let _ = write_stderr(
                                b"Assessment saved, but its summary could not be written.\n",
                            );
                            return 1;
                        }
                    }
                    0
                }
                Err(error) => {
                    if emit_error(&terminal, &error) {
                        error.exit
                    } else {
                        1
                    }
                }
            }
        }
    }
}
fn main() {
    std::process::exit(run_main())
}
