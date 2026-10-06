use crate::{
    cli::{ColorMode, Globals},
    error::AppError,
};
use serde::Serialize;
use std::{
    env,
    io::{self, IsTerminal, Write},
    path::Path,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const KNOWN: &[&str] = &[
    "--from",
    "--to",
    "--compiler",
    "--out",
    "--node",
    "--worker",
    "--timeout-ms",
    "--max-output-bytes",
    "--color",
    "--quiet",
    "--json",
    "--help",
    "--version",
];

#[derive(Clone, Copy)]
enum Stream {
    Out,
    Err,
}
#[derive(Clone, Copy)]
enum Tone {
    Accent,
    Complete,
    Review,
    Failure,
    Dim,
    Bold,
}

pub struct Terminal {
    globals: Globals,
    branded: bool,
    out_tty: bool,
    err_tty: bool,
    width: usize,
    unicode: bool,
    decorative: bool,
}
pub struct Summary<'a> {
    pub old_name: &'a str,
    pub old_version: &'a str,
    pub new_name: &'a str,
    pub new_version: &'a str,
    pub changes: usize,
    pub proposals: usize,
    pub unresolved: usize,
    pub status: &'a str,
    pub path: &'a Path,
}
pub struct AssessmentSummary<'a> {
    pub repository: &'a str,
    pub target: &'a str,
    pub sources: usize,
    pub usages: usize,
    pub groups: usize,
    pub decisions: usize,
    pub path: &'a Path,
}

impl Terminal {
    pub fn new(globals: Globals) -> Self {
        let branded = !globals.json && env::var("RHUBASE_CLI").is_ok_and(|value| value == "1");
        let out_tty = io::stdout().is_terminal();
        let err_tty = io::stderr().is_terminal();
        let width = terminal_width(out_tty).unwrap_or(80).clamp(20, 500);
        let term_dumb = env::var("TERM").is_ok_and(|value| value.eq_ignore_ascii_case("dumb"));
        let locale = env::var("LC_ALL")
            .or_else(|_| env::var("LC_CTYPE"))
            .or_else(|_| env::var("LANG"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        let no_color = env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty());
        let unicode = out_tty
            && !term_dumb
            && width >= 60
            && globals.color != ColorMode::Never
            && !no_color
            && (locale.contains("utf-8") || locale.contains("utf8"));
        Self {
            globals,
            branded,
            out_tty,
            err_tty,
            width,
            unicode,
            decorative: out_tty && !term_dumb,
        }
    }
    fn color(&self, stream: Stream) -> bool {
        if self.globals.json {
            return false;
        }
        match self.globals.color {
            ColorMode::Always => true,
            ColorMode::Never => false,
            ColorMode::Auto => {
                let tty = match stream {
                    Stream::Out => self.out_tty,
                    Stream::Err => self.err_tty,
                };
                tty && !env::var("TERM").is_ok_and(|v| v.eq_ignore_ascii_case("dumb"))
                    && env::var_os("NO_COLOR").is_none_or(|value| value.is_empty())
            }
        }
    }
    fn style(&self, stream: Stream, tone: Tone, text: &str) -> String {
        if !self.color(stream) {
            return text.to_owned();
        }
        let code = match tone {
            Tone::Accent => "36",
            Tone::Complete => "32",
            Tone::Review => "33",
            Tone::Failure => "31",
            Tone::Dim => "90",
            Tone::Bold => "1",
        };
        format!("\x1b[{code}m{text}\x1b[0m")
    }
    pub fn help(&self, command: Option<&str>) -> String {
        let mut result = String::new();
        if self.branded && (command.is_some() || !self.decorative) {
            result.push_str("RhuBase\n\n");
        }
        if command.is_none() && self.decorative && !self.globals.quiet && !self.globals.json {
            if self.branded && self.unicode {
                result.push_str(&format!(
                    "╭ {} ╮   ╭ {} ╮\n╰─────╯ {} ╰──────╯\n{}\n\n",
                    self.style(Stream::Out, Tone::Bold, "rhu"),
                    self.style(Stream::Out, Tone::Bold, "base"),
                    self.style(Stream::Out, Tone::Accent, "+"),
                    self.style(
                        Stream::Out,
                        Tone::Dim,
                        "RhuBase · local design-system assessment"
                    )
                ));
            } else if self.branded {
                result.push_str(&format!(
                    "[ {} ] {} [ {} ]\n{}\n\n",
                    self.style(Stream::Out, Tone::Bold, "rhu"),
                    self.style(Stream::Out, Tone::Accent, "+"),
                    self.style(Stream::Out, Tone::Bold, "base"),
                    self.style(
                        Stream::Out,
                        Tone::Dim,
                        "RhuBase · local design-system assessment"
                    )
                ));
            } else if self.unicode {
                result.push_str(&format!(
                    "╭ {} ╮   ╭ {} ╮\n╰──────╯ {} ╰───────╯\n{}\n\n",
                    self.style(Stream::Out, Tone::Bold, "ctrl"),
                    self.style(Stream::Out, Tone::Bold, "shift"),
                    self.style(Stream::Out, Tone::Accent, "+"),
                    self.style(Stream::Out, Tone::Dim, "read-only design-system comparison")
                ));
            } else {
                result.push_str(&format!(
                    "[ {} ] {} [ {} ]\n{}\n\n",
                    self.style(Stream::Out, Tone::Bold, "ctrl"),
                    self.style(Stream::Out, Tone::Accent, "+"),
                    self.style(Stream::Out, Tone::Bold, "shift"),
                    self.style(Stream::Out, Tone::Dim, "read-only design-system comparison")
                ));
            }
        }
        if command == Some("assess") {
            result.push_str("Inventory one consumer against selected source systems and one target.\nWrite a draft review directory; run no repository scripts.\n\nUsage\n  ctrl-shift assess [REPO] --source PACKAGE [--source PACKAGE] --target PACKAGE --out DIR [options]\n\nInputs\n  REPO                    consumer repository; default current directory\n  --source PACKAGE        source package name or local path; repeatable\n  --target PACKAGE        target package name or local path\n                           installed/workspace names or explicit local paths\n                           no registry downloads or version selectors\n  --compiler FILE         override auto-discovered pinned TypeScript 5.9.3\n\nRuntime\n  --node FILE             trusted Node 22+ executable\n  --worker FILE           trusted-operator worker override (not a sandbox)\n  --timeout-ms N          per-phase deadline; default 30000\n  --max-output-bytes N    lower response cap; maximum 33554432\n\nOutput\n  --out DIR               new report directory outside protected inputs\n                           output parent directory must already exist\n                           never overwritten\n  --quiet, -q             suppress successful human output\n  --json                  one machine summary on stdout\n  --color MODE            auto, always, or never\n\nExample\n  ctrl-shift assess . --source @legacy/a --source @legacy/b \\\n    --target @design/target --out ../assessment-report\n\nRead-only draft review only. No application files are changed.\n");
        } else if command == Some("infer") && self.width < 60 {
            result.push_str("Compare two local snapshots and save a draft contract.\nNo application files are changed.\n\nUsage\n  ctrl-shift infer\n    --from DIR\n    --to DIR\n    --out FILE\n    [options]\n\nInputs\n  --from DIR\n    old snapshot\n  --to DIR\n    new snapshot\n  --compiler FILE\n    TypeScript 5.9.3 compiler\n    or set SHIFT_TYPESCRIPT_PATH\n\nRuntime\n  --node FILE\n    trusted Node 22+ executable\n  --worker FILE\n    trusted-operator override; not a sandbox\n  --timeout-ms N\n    default 30000\n  --max-output-bytes N\n    lower cap; maximum 33554432\n\nOutput\n  --out FILE\n    new external path\n    output parent directory must already exist\n    never overwritten\n  --quiet, -q\n    suppress successful human output\n  --json\n    one machine summary\n  --color MODE\n    auto, always, or never\n\nExample\n  Assumes SHIFT_TYPESCRIPT_PATH is set.\n  ctrl-shift infer \\\n    --from ./old-ui \\\n    --to ./new-ui \\\n    --out ./contract.json\n\nmacOS/Unix checkout command.\nLinux unvalidated; Windows unsupported.\n");
        } else if command == Some("infer") {
            result.push_str("Compare two local snapshots and save a draft, non-executable contract.\nNo application files are changed.\n\nUsage\n  ctrl-shift infer --from DIR --to DIR --out FILE [options]\n\nInputs\n  --from DIR              old snapshot\n  --to DIR                new snapshot\n  --compiler FILE         TypeScript 5.9.3 compiler\n                           or set SHIFT_TYPESCRIPT_PATH\n\nRuntime\n  --node FILE             trusted Node 22+ executable\n  --worker FILE           trusted-operator worker override (not a sandbox)\n  --timeout-ms N          deadline; default 30000\n  --max-output-bytes N    lower stdout cap; maximum 33554432\n\nOutput\n  --out FILE              new path outside both snapshots\n                           output parent directory must already exist\n                           never overwritten\n  --quiet, -q             suppress successful human output\n  --json                  one machine summary on stdout\n  --color MODE            auto, always, or never\n\nExample\n  SHIFT_TYPESCRIPT_PATH=/absolute/path/to/typescript/lib/typescript.js \\\n    ctrl-shift infer --from ./old-ui --to ./new-ui --out ./contract.json\n\nmacOS/Unix source-checkout command. Linux unvalidated; Windows unsupported.\n");
        } else if self.width < 60 {
            result.push_str("Compare design systems and prepare\nread-only draft review artifacts.\nNo application files are changed.\n\nCommands\n  ctrl-shift infer\n    compare two package snapshots\n  ctrl-shift assess\n    inventory one consumer repository\n\nRun `ctrl-shift infer --help` or\n`ctrl-shift assess --help`.\n");
        } else {
            result.push_str("Compare design systems and prepare read-only draft review artifacts.\nNo application files are changed.\n\nCommands\n  ctrl-shift infer    compare two package snapshots\n  ctrl-shift assess   inventory one consumer repository\n\nRun `ctrl-shift infer --help` or `ctrl-shift assess --help`.\n");
        }
        for heading in [
            "Usage",
            "Commands",
            "Required",
            "TypeScript",
            "Inputs",
            "Runtime",
            "Output",
            "Example",
        ] {
            result = result.replace(
                &format!("\n{heading}\n"),
                &format!("\n{}\n", self.style(Stream::Out, Tone::Bold, heading)),
            );
        }
        result = result.replace(
            "ctrl-shift infer",
            &self.style(Stream::Out, Tone::Accent, "ctrl-shift infer"),
        );
        if self.branded {
            result = result.replace(
                "ctrl-shift assess",
                &self.style(Stream::Out, Tone::Accent, "ctrl-shift assess"),
            );
            result = result.replace("ctrl-shift", "rhubase");
        }
        result
    }
    pub fn run_mark(&self, command: &str) {
        if !self.globals.quiet && !self.globals.json && self.err_tty {
            let mark = if self.branded {
                "[rhu] + [base]"
            } else {
                "[ctrl] + [shift]"
            };
            let _ = writeln!(
                io::stderr(),
                "{}  {}\n",
                self.style(Stream::Err, Tone::Accent, mark),
                self.style(Stream::Err, Tone::Bold, command)
            );
        }
    }
    pub fn stage(&self, text: &str, complete: bool) {
        if !self.globals.quiet && !self.globals.json && self.err_tty {
            let symbol = if complete && self.unicode {
                "✓"
            } else if complete {
                "+"
            } else if self.unicode {
                "◆"
            } else {
                "*"
            };
            let tone = if complete {
                Tone::Complete
            } else {
                Tone::Accent
            };
            let _ = writeln!(
                io::stderr(),
                "  {} {}",
                self.style(Stream::Err, tone, symbol),
                sanitize(text)
            );
        }
    }
    pub fn summary(&self, value: &Summary<'_>) -> io::Result<()> {
        if self.globals.quiet || self.globals.json {
            return Ok(());
        }
        let mut out = Vec::new();
        writeln!(
            out,
            "\n{}",
            self.style(
                Stream::Out,
                Tone::Bold,
                if self.branded {
                    "RhuBase · draft contract saved"
                } else {
                    "Draft contract saved"
                },
            )
        )?;
        writeln!(
            out,
            "  Old snapshot       {} {}",
            sanitize_bounded(value.old_name, 256),
            sanitize_bounded(value.old_version, 256)
        )?;
        writeln!(
            out,
            "  New snapshot       {} {}",
            sanitize_bounded(value.new_name, 256),
            sanitize_bounded(value.new_version, 256)
        )?;
        writeln!(out, "  Changes found      {}", value.changes)?;
        let mappings = format!("  Mappings to review {}", value.proposals);
        let unresolved = format!("  Unresolved items   {}", value.unresolved);
        writeln!(
            out,
            "{}",
            if value.proposals > 0 {
                self.style(Stream::Out, Tone::Review, &mappings)
            } else {
                mappings
            }
        )?;
        writeln!(
            out,
            "{}",
            if value.unresolved > 0 {
                self.style(Stream::Out, Tone::Review, &unresolved)
            } else {
                unresolved
            }
        )?;
        writeln!(out, "  Contract status    {}", sanitize(value.status))?;
        writeln!(
            out,
            "  File\n    {}",
            sanitize(&value.path.display().to_string())
        )?;
        let mapping_label = if value.proposals == 1 {
            "mapping proposal"
        } else {
            "mapping proposals"
        };
        let unresolved_label = if value.unresolved == 1 {
            "unresolved item"
        } else {
            "unresolved items"
        };
        if value.proposals > 0 && value.unresolved > 0 {
            writeln!(
                out,
                "\nNext: review {} {} and {} {}.",
                value.proposals, mapping_label, value.unresolved, unresolved_label
            )?;
        } else if value.proposals > 0 {
            writeln!(out, "\nNext: review {} {}.", value.proposals, mapping_label)?;
        } else if value.unresolved > 0 {
            writeln!(
                out,
                "\nNext: review {} {}.",
                value.unresolved, unresolved_label
            )?;
        } else {
            writeln!(
                out,
                "\nNext: inspect the draft contract before using it to plan migration work."
            )?;
        }
        writeln!(
            out,
            "Read-only: no migration was run. Input snapshots are unchanged."
        )?;
        write_output(&mut io::stdout(), &out)
    }
    pub fn assessment_summary(&self, value: &AssessmentSummary<'_>) -> io::Result<()> {
        if self.globals.quiet || self.globals.json {
            return Ok(());
        }
        let mut out = Vec::new();
        writeln!(
            out,
            "\n{}",
            self.style(
                Stream::Out,
                Tone::Bold,
                if self.branded {
                    "RhuBase · draft assessment saved"
                } else {
                    "Draft assessment saved"
                },
            )
        )?;
        writeln!(
            out,
            "  Repository         {}",
            sanitize_bounded(value.repository, 256)
        )?;
        writeln!(out, "  Source systems     {}", value.sources)?;
        writeln!(
            out,
            "  Target system      {}",
            sanitize_bounded(value.target, 256)
        )?;
        writeln!(out, "  Affected usages    {}", value.usages)?;
        writeln!(out, "  Mapping groups     {}", value.groups)?;
        let decisions = format!("  Decisions to review {}", value.decisions);
        writeln!(
            out,
            "{}",
            if value.decisions > 0 {
                self.style(Stream::Out, Tone::Review, &decisions)
            } else {
                decisions
            }
        )?;
        writeln!(
            out,
            "  Directory\n    {}",
            sanitize(&value.path.display().to_string())
        )?;
        writeln!(
            out,
            "\nNext: review assessment.md and assign owners to the decision queue."
        )?;
        writeln!(
            out,
            "Read-only: no migration was run. Repository inputs are unchanged."
        )?;
        write_output(&mut io::stdout(), &out)
    }
    pub fn write_json<T: Serialize>(&self, value: &T) -> io::Result<()> {
        let mut out = Vec::new();
        let encoded = serde_json::to_string(value)?;
        for character in encoded.chars() {
            if matches!(character, '\u{007f}'..='\u{009f}' | '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            {
                write!(out, "\\u{:04x}", character as u32)?;
            } else {
                write!(out, "{character}")?;
            }
        }
        out.write_all(b"\n")?;
        write_output(&mut io::stdout(), &out)
    }
    pub fn write_text(&self, text: &str) -> io::Result<()> {
        write_output(&mut io::stdout(), text.as_bytes())
    }
    pub fn error_text(&self, error: &AppError) -> String {
        let message = sanitize_bounded(&message(error), 2048);
        if error.exit == 130 {
            return "Interrupted. No contract was written.\n".into();
        }
        let mut text = format!(
            "{} {}\n",
            self.style(Stream::Err, Tone::Failure, "Error:"),
            message
        );
        if let Some(mut hint) = hint(error) {
            if self.branded {
                hint = hint
                    .replace("ctrl-shift", "rhubase")
                    .replace("Ctrl + Shift", "RhuBase");
            }
            text.push('\n');
            text.push_str(&hint);
            text.push('\n');
        }
        text
    }
    pub fn json(&self) -> bool {
        self.globals.json
    }
    pub fn program_name(&self) -> &'static str {
        if self.branded {
            "rhubase"
        } else {
            "ctrl-shift"
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonCounts {
    pub changes: usize,
    pub proposals_needing_review: usize,
    pub unresolved: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonSuccess<'a> {
    pub schema_version: u32,
    pub kind: &'static str,
    pub command: &'static str,
    pub status: &'static str,
    pub contract_path: &'a str,
    pub counts: JsonCounts,
    pub inputs_changed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonErrorBody<'a> {
    pub code: &'a str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonError<'a> {
    pub schema_version: u32,
    pub kind: &'static str,
    pub error: JsonErrorBody<'a>,
    pub exit_code: i32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonHelp<'a> {
    pub schema_version: u32,
    pub kind: &'static str,
    pub command: Option<&'a str>,
    pub text: &'a str,
}
#[derive(Serialize)]
pub struct JsonVersion<'a> {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub kind: &'static str,
    pub version: &'a str,
}

pub fn version() -> &'static str {
    VERSION
}
pub fn sanitize(value: &str) -> String {
    let mut out = String::new();
    for c in value.chars() {
        match c {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\x1b' => out.push_str("\\x1b"),
            c if c.is_control()
                || (('\u{7f}'..='\u{9f}').contains(&c))
                || matches!(c,'\u{061c}'|'\u{200e}'|'\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}') =>
            {
                out.push_str(&format!("\\u{{{:x}}}", c as u32))
            }
            c => out.push(c),
        }
    }
    out
}
pub fn error_code(error: &AppError) -> &'static str {
    match error.exit {
        2 => "usage",
        124 => "timeout",
        130 => "interrupted",
        _ => "inference-failed",
    }
}
pub fn bound_text(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}
pub fn sanitize_bounded(value: &str, limit: usize) -> String {
    let mut out = String::new();
    for character in value.chars() {
        let piece = sanitize(&character.to_string());
        if out.chars().count() + piece.chars().count() > limit {
            break;
        }
        out.push_str(&piece)
    }
    out
}
pub fn message(error: &AppError) -> String {
    if error.message == "output already exists" {
        "the output file already exists.".into()
    } else {
        error.message.clone()
    }
}
pub fn hint(error: &AppError) -> Option<String> {
    if error.message.contains("resolution-failed") {
        Some("Check the repository package.json and each `--source`/`--target` selector. Use installed or workspace package names, or explicit local paths; registry downloads and version selectors are unsupported.".into())
    } else if error.message.contains("compiler") || error.message.contains("--compiler") {
        Some("Pass `--compiler FILE` or set `SHIFT_TYPESCRIPT_PATH`.\nRun `ctrl-shift infer --help` for an example.".into())
    } else if error.message.contains("missing required option") {
        Some("Run `ctrl-shift infer --help` for the shortest valid command.".into())
    } else if error.message.contains("output already exists") {
        Some("Choose a new `--out` path. Ctrl + Shift never overwrites a contract.".into())
    } else if error.exit == 124 {
        Some(
            "No contract was written. Retry with `--timeout-ms N` after checking the snapshots."
                .into(),
        )
    } else if let Some(flag) = error
        .message
        .strip_prefix("unknown option `")
        .and_then(|v| v.strip_suffix('`'))
    {
        let flag = sanitize(flag);
        let candidates = KNOWN
            .iter()
            .filter(|known| distance(&flag, known) <= 2)
            .collect::<Vec<_>>();
        if candidates.len() == 1 {
            Some(format!(
                "Did you mean `{}`?\nRun `ctrl-shift infer --help` to see valid options.",
                candidates[0]
            ))
        } else {
            Some("Run `ctrl-shift infer --help` to see valid options.".into())
        }
    } else {
        None
    }
}
fn distance(a: &str, b: &str) -> usize {
    let mut row = (0..=b.len()).collect::<Vec<_>>();
    for (i, ca) in a.bytes().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, cb) in b.bytes().enumerate() {
            let old = row[j + 1];
            row[j + 1] = (row[j + 1] + 1)
                .min(row[j] + 1)
                .min(prev + usize::from(ca != cb));
            prev = old
        }
    }
    row[b.len()]
}
fn write_output(writer: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
    match writer.write_all(bytes) {
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(()),
        result => result,
    }
}
fn terminal_width(tty: bool) -> Option<usize> {
    if tty {
        let mut size: nix::libc::winsize = unsafe { std::mem::zeroed() };
        let result =
            unsafe { nix::libc::ioctl(nix::libc::STDOUT_FILENO, nix::libc::TIOCGWINSZ, &mut size) };
        if result == 0 && size.ws_col > 0 {
            return Some(size.ws_col as usize);
        }
    }
    env::var("COLUMNS")
        .ok()?
        .parse()
        .ok()
        .filter(|width| *width > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sanitizes_controls() {
        assert_eq!(sanitize("a\x1b\n\u{202e}"), "a\\x1b\\n\\u{202e}")
    }
    #[test]
    fn suggests_unique_flag() {
        let e = AppError::usage("unknown option `--form`");
        assert!(hint(&e).unwrap().contains("--from"));
    }
}
