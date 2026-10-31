use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

pub const MAX_OUTPUT: usize = 32 * 1024 * 1024;
pub struct ProcessJob {
    #[cfg(windows)]
    handle: usize,
}
impl ProcessJob {
    pub fn bind(pid: u32) -> Result<Self, String> {
        #[cfg(windows)]
        unsafe {
            use windows::Win32::{
                Foundation::CloseHandle,
                System::{JobObjects::*, Threading::*},
            };
            let job = CreateJobObjectW(None, None).map_err(|e| e.to_string())?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Err(error) = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            ) {
                let _ = CloseHandle(job);
                return Err(error.to_string());
            }
            let process = match OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                pid,
            ) {
                Ok(p) => p,
                Err(e) => {
                    let _ = CloseHandle(job);
                    return Err(e.to_string());
                }
            };
            let assigned = AssignProcessToJobObject(job, process);
            let _ = CloseHandle(process);
            if let Err(error) = assigned {
                let _ = CloseHandle(job);
                return Err(error.to_string());
            }
            Ok(Self {
                handle: job.0 as usize,
            })
        }
        #[cfg(not(windows))]
        {
            let _ = pid;
            Ok(Self {})
        }
    }
}
impl Drop for ProcessJob {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(
                self.handle as *mut _,
            ));
        }
    }
}
#[derive(Clone, Debug)]
pub struct Program {
    pub bin: PathBuf,
    pub prefix: Vec<String>,
    pub env: Vec<(String, String)>,
    pub unset: Vec<String>,
}
impl Program {
    pub fn new(bin: impl Into<PathBuf>) -> Self {
        Self {
            bin: bin.into(),
            prefix: Vec::new(),
            env: Vec::new(),
            unset: Vec::new(),
        }
    }
    pub fn command(&self) -> Command {
        let mut cmd = Command::new(&self.bin);
        cmd.args(&self.prefix).envs(self.env.iter().cloned());
        for key in &self.unset {
            cmd.env_remove(key);
        }
        hidden(&mut cmd);
        cmd
    }
}
pub fn hidden(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
}
pub fn terminate(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    #[cfg(windows)]
    {
        let mut kill = Command::new("taskkill.exe");
        hidden(&mut kill);
        let _ = kill
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGTERM);
    }
    let _ = child.kill();
    let _ = child.wait();
}
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: i32,
}
impl Output {
    pub fn text(self) -> Result<String, String> {
        if self.code == 0 {
            Ok(String::from_utf8_lossy(&self.stdout).into_owned())
        } else {
            let message = if self.stderr.is_empty() {
                &self.stdout
            } else {
                &self.stderr
            };
            Err(String::from_utf8_lossy(message)
                .chars()
                .rev()
                .take(3000)
                .collect::<String>()
                .chars()
                .rev()
                .collect())
        }
    }
    pub fn checked(self) -> Result<Vec<u8>, String> {
        if self.code == 0 {
            Ok(self.stdout)
        } else {
            self.text().map(String::into_bytes)
        }
    }
}
pub fn run(
    program: &Program,
    args: &[String],
    cwd: Option<&Path>,
    input: Option<Vec<u8>>,
    timeout: Duration,
    cap: usize,
) -> Result<Output, String> {
    let mut cmd = program.command();
    cmd.args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{}: {e}", program.bin.display()))?;
    let job = match ProcessJob::bind(child.id()) {
        Ok(job) => job,
        Err(error) => {
            terminate(&mut child);
            return Err(format!("Cannot own command process: {error}"));
        }
    };
    let count = Arc::new(AtomicUsize::new(0));
    let overflow = Arc::new(AtomicBool::new(false));
    let read =
        |mut pipe: Box<dyn Read + Send>, count: Arc<AtomicUsize>, overflow: Arc<AtomicBool>| {
            thread::spawn(move || {
                let mut out = Vec::new();
                let mut buffer = [0u8; 8192];
                loop {
                    let n = match pipe.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    let before = count.fetch_add(n, Ordering::Relaxed);
                    if before.saturating_add(n) > cap {
                        overflow.store(true, Ordering::Release);
                    } else {
                        out.extend_from_slice(&buffer[..n]);
                    }
                }
                out
            })
        };
    let stdout = read(
        Box::new(child.stdout.take().unwrap()),
        count.clone(),
        overflow.clone(),
    );
    let stderr = read(
        Box::new(child.stderr.take().unwrap()),
        count,
        overflow.clone(),
    );
    let writer = input.map(|bytes| {
        let mut stdin = child.stdin.take().unwrap();
        thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
        })
    });
    let started = Instant::now();
    let mut failure = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Err(e) => {
                failure = Some(e.to_string());
                break None;
            }
            _ => {}
        }
        if overflow.load(Ordering::Acquire) {
            failure = Some(format!("Command output exceeds {cap} bytes"));
            terminate(&mut child);
            break None;
        }
        if started.elapsed() > timeout {
            failure = Some("Command timed out".into());
            terminate(&mut child);
            break None;
        }
        thread::sleep(Duration::from_millis(10));
    };
    if status.is_none() {
        terminate(&mut child);
    }
    drop(job);
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGTERM);
    }
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    let out = stdout.join().unwrap_or_default();
    let errors = stderr.join().unwrap_or_default();
    if overflow.load(Ordering::Acquire) {
        return Err(format!("Command output exceeds {cap} bytes"));
    }
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(Output {
        stdout: out,
        stderr: errors,
        code: status.and_then(|s| s.code()).unwrap_or(-1),
    })
}
pub fn text(bin: &str, args: &[&str], cwd: Option<&Path>, seconds: u64) -> Result<String, String> {
    let program = resolve(bin).ok_or_else(|| format!("{bin} was not found"))?;
    run(
        &program,
        &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        cwd,
        None,
        Duration::from_secs(seconds),
        MAX_OUTPUT,
    )?
    .text()
}
pub fn which(name: &str) -> Option<PathBuf> {
    let path = Path::new(name);
    if path.components().count() > 1 && path.is_file() {
        return Some(path.to_owned());
    }
    let extensions: Vec<&str> = if cfg!(windows) {
        vec!["", ".exe", ".cmd", ".bat"]
    } else {
        vec![""]
    };
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        for suffix in &extensions {
            let path = dir.join(format!("{name}{suffix}"));
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}
/// Resolve npm shims to their JS entry point, avoiding a shell around arbitrary prompts/paths.
pub fn resolve(name: &str) -> Option<Program> {
    let path = which(name)?;
    if cfg!(windows)
        && path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
    {
        let text = fs::read_to_string(&path).ok()?;
        let parent = path.parent()?;
        for part in text.split('"') {
            if [".js", ".mjs", ".cjs"]
                .iter()
                .any(|extension| part.to_ascii_lowercase().ends_with(extension))
                && part.contains("%dp0%")
            {
                let script = PathBuf::from(part.replace("%dp0%", &parent.to_string_lossy()));
                if !script.is_file() {
                    continue;
                }
                let node = if parent.join("node.exe").is_file() {
                    parent.join("node.exe")
                } else {
                    which("node.exe")?
                };
                let mut program = Program::new(node);
                program.prefix.push(script.to_string_lossy().into_owned());
                return Some(program);
            }
        }
        return None;
    }
    Some(Program::new(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captures_unicode_without_a_shell_and_enforces_timeout() {
        let program = if cfg!(windows) {
            Program::new("powershell.exe")
        } else {
            Program::new("/bin/sh")
        };
        let args: Vec<String> = if cfg!(windows) {
            vec![
                "-NoProfile",
                "-Command",
                "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Write-Output 'Привет'",
            ]
        } else {
            vec!["-c", "printf 'Привет'"]
        }
        .into_iter()
        .map(str::to_owned)
        .collect();
        assert!(
            run(&program, &args, None, None, Duration::from_secs(10), 4096)
                .unwrap()
                .text()
                .unwrap()
                .contains("Привет")
        );
        let args: Vec<String> = if cfg!(windows) {
            vec!["-NoProfile", "-Command", "Start-Sleep -Seconds 5"]
        } else {
            vec!["-c", "sleep 5"]
        }
        .into_iter()
        .map(str::to_owned)
        .collect();
        assert!(run(
            &program,
            &args,
            None,
            None,
            Duration::from_millis(100),
            4096
        )
        .err()
        .unwrap()
        .contains("timed out"));
    }
}
