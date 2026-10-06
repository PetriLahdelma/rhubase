use crate::error::{AppError, Result};
use nix::{
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use std::{
    io::{Read, Write},
    os::unix::process::CommandExt,
    path::Path,
    process::{Command, ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

pub struct ProcessOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
pub struct WorkerSpec<'a> {
    pub node: &'a Path,
    pub worker: &'a Path,
    pub timeout_ms: u64,
    pub stdout_cap: usize,
    pub stderr_cap: usize,
    pub path_env: &'a str,
}
struct ReadResult {
    bytes: Vec<u8>,
    exceeded: bool,
    error: Option<String>,
}

fn reader<R: Read + Send + 'static>(
    mut input: R,
    cap: usize,
    failed: Arc<AtomicBool>,
) -> thread::JoinHandle<ReadResult> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut exceeded = false;
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            match input.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let available = cap.saturating_sub(bytes.len());
                    let keep = count.min(available);
                    bytes.extend_from_slice(&buffer[..keep]);
                    if count > available {
                        exceeded = true;
                        failed.store(true, Ordering::SeqCst);
                    }
                }
                Err(error) => {
                    failed.store(true, Ordering::SeqCst);
                    return ReadResult {
                        bytes,
                        exceeded,
                        error: Some(error.to_string()),
                    };
                }
            }
        }
        ReadResult {
            bytes,
            exceeded,
            error: None,
        }
    })
}

fn kill_group(pid: u32, leader_observed_exited: bool) -> Result<()> {
    match killpg(Pid::from_raw(pid as i32), Signal::SIGKILL) {
        Ok(()) | Err(nix::errno::Errno::ESRCH) => Ok(()),
        // Darwin reports EPERM when the observed group contains only the unreaped zombie leader.
        Err(nix::errno::Errno::EPERM) if leader_observed_exited => Ok(()),
        Err(error) => Err(AppError::new(format!(
            "cannot kill worker process group: {error}"
        ))),
    }
}

#[cfg(target_os = "macos")]
fn leader_exited(pid: u32) -> Result<bool> {
    loop {
        // SAFETY: zero is a valid initial state for siginfo_t, and `info` remains writable for waitid.
        let mut info: nix::libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: the PID belongs to the unreaped child; WNOWAIT observes it without releasing PID ownership.
        let result = unsafe {
            nix::libc::waitid(
                nix::libc::P_PID,
                pid,
                &mut info,
                nix::libc::WEXITED | nix::libc::WNOHANG | nix::libc::WNOWAIT,
            )
        };
        if result == 0 {
            // SAFETY: waitid initialized siginfo_t on success; si_pid is the documented accessor.
            return Ok(unsafe { info.si_pid() } > 0);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(AppError::new(format!("cannot observe worker: {error}")));
        }
    }
}
#[cfg(not(target_os = "macos"))]
fn leader_exited(pid: u32) -> Result<bool> {
    use nix::sys::wait::{Id, WaitPidFlag, WaitStatus, waitid};
    let status = waitid(
        Id::Pid(Pid::from_raw(pid as i32)),
        WaitPidFlag::WEXITED | WaitPidFlag::WNOHANG | WaitPidFlag::WNOWAIT,
    )
    .map_err(|e| AppError::new(format!("cannot observe worker: {e}")))?;
    Ok(!matches!(status, WaitStatus::StillAlive))
}

pub fn run_worker(
    spec: &WorkerSpec<'_>,
    request: Vec<u8>,
    cancelled: &Arc<AtomicBool>,
) -> Result<ProcessOutput> {
    let mut command = Command::new(spec.node);
    command
        .arg(spec.worker)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .env("PATH", spec.path_env)
        .process_group(0);
    let mut child = command
        .spawn()
        .map_err(|e| AppError::new(format!("cannot start Node worker: {e}")))?;
    let pid = child.id();
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::new("worker stdin unavailable"))?;
    let (write_tx, write_rx) = mpsc::channel();
    let writer = thread::spawn(move || {
        let result = stdin.write_all(&request).and_then(|_| stdin.flush());
        drop(stdin);
        let _ = write_tx.send(result.map_err(|e| e.to_string()));
    });
    let stream_failed = Arc::new(AtomicBool::new(false));
    let stdout = reader(
        child
            .stdout
            .take()
            .ok_or_else(|| AppError::new("worker stdout unavailable"))?,
        spec.stdout_cap,
        Arc::clone(&stream_failed),
    );
    let stderr = reader(
        child
            .stderr
            .take()
            .ok_or_else(|| AppError::new("worker stderr unavailable"))?,
        spec.stderr_cap,
        Arc::clone(&stream_failed),
    );
    enum Stop {
        Done,
        Timeout,
        Interrupted,
        Stream,
        Observe(AppError),
    }
    let deadline = Instant::now() + Duration::from_millis(spec.timeout_ms);
    let stop;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            stop = Stop::Interrupted;
            break;
        }
        if stream_failed.load(Ordering::SeqCst) {
            stop = Stop::Stream;
            break;
        }
        if Instant::now() >= deadline {
            stop = Stop::Timeout;
            break;
        }
        match leader_exited(pid) {
            Ok(true) => {
                stop = Stop::Done;
                break;
            }
            Ok(false) => {}
            Err(error) => {
                stop = Stop::Observe(error);
                break;
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
    let kill_error = kill_group(pid, matches!(stop, Stop::Done)).err();
    let status = child
        .wait()
        .map_err(|e| AppError::new(format!("cannot wait for worker: {e}")))?;
    writer
        .join()
        .map_err(|_| AppError::new("stdin writer panicked"))?;
    if let Ok(Err(message)) = write_rx.try_recv() {
        return Err(AppError::new(format!("worker stdin failed: {message}")));
    }
    let stdout = stdout
        .join()
        .map_err(|_| AppError::new("stdout reader panicked"))?;
    let stderr = stderr
        .join()
        .map_err(|_| AppError::new("stderr reader panicked"))?;
    if let Some(error) = stdout.error.or(stderr.error) {
        return Err(AppError::new(format!("worker pipe failed: {error}")));
    }
    if let Some(error) = kill_error {
        return Err(error);
    }
    if stdout.exceeded {
        return Err(AppError::new("worker stdout exceeded limit"));
    }
    if stderr.exceeded {
        return Err(AppError::new("worker stderr exceeded 1 MiB"));
    }
    match stop {
        Stop::Timeout => return Err(AppError::timeout("worker timed out")),
        Stop::Interrupted => return Err(AppError::interrupted("interrupted")),
        Stop::Observe(error) => return Err(error),
        Stop::Stream | Stop::Done => {}
    }
    Ok(ProcessOutput {
        status,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
    })
}
