use super::{
    process::{self, ProcessJob},
    storage::Storage,
    CoreResult, Emit,
};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
struct Term {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    job: Mutex<Option<ProcessJob>>,
    alive: AtomicBool,
    shell: String,
    #[cfg(unix)]
    pid: Option<u32>,
}
impl Term {
    fn kill(&self) {
        if !self.alive.swap(false, Ordering::AcqRel) {
            return;
        }
        let _ = self.killer.lock().unwrap().kill();
        self.job.lock().unwrap().take();
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}
pub struct Terminals {
    terms: Arc<Mutex<HashMap<String, Arc<Term>>>>,
    emit: Emit,
}
impl Terminals {
    pub fn new(emit: Emit) -> Self {
        Self {
            terms: Arc::new(Mutex::new(HashMap::new())),
            emit,
        }
    }
    pub fn invoke(&self, channel: &str, args: &[Value], storage: &Storage) -> CoreResult {
        let arg = |n: usize| args.get(n).unwrap_or(&Value::Null);
        if channel == "term:create" {
            let spec = arg(0);
            let id = spec["id"].as_str().ok_or("Terminal id is required")?;
            if id.len() > 256 {
                return Err("Terminal id is too long".into());
            }
            let mut terms = self.terms.lock().map_err(|e| e.to_string())?;
            if let Some(term) = terms.get(id) {
                return Ok(json!({"id":id,"shell":term.shell}));
            }
            if terms.len() >= 32 {
                return Err("Terminal limit reached".into());
            }
            let shell = if cfg!(windows) {
                process::which("pwsh.exe")
                    .unwrap_or_else(|| "powershell.exe".into())
                    .to_string_lossy()
                    .into_owned()
            } else {
                std::env::var("SHELL").unwrap_or_else(|_| {
                    if std::path::Path::new("/bin/bash").exists() {
                        "/bin/bash".into()
                    } else {
                        "/bin/sh".into()
                    }
                })
            };
            let size = PtySize {
                rows: spec["rows"].as_u64().unwrap_or(30).clamp(1, 1000) as u16,
                cols: spec["cols"].as_u64().unwrap_or(100).clamp(2, 2000) as u16,
                pixel_width: 0,
                pixel_height: 0,
            };
            let pair = native_pty_system()
                .openpty(size)
                .map_err(|e| e.to_string())?;
            let mut command = CommandBuilder::new(&shell);
            let cwd = spec["cwd"]
                .as_str()
                .filter(|p| std::path::Path::new(p).is_dir())
                .map(std::path::PathBuf::from)
                .unwrap_or(storage.home.clone());
            command.cwd(cwd);
            command.env("TERM_PROGRAM", "duet");
            command.env("TERM", "xterm-256color");
            let mut child = pair
                .slave
                .spawn_command(command)
                .map_err(|e| e.to_string())?;
            drop(pair.slave);
            let pid = child.process_id();
            let job = if let Some(pid) = pid {
                match ProcessJob::bind(pid) {
                    Ok(job) => Some(job),
                    Err(e) => {
                        let _ = child.kill();
                        return Err(e);
                    }
                }
            } else {
                None
            };
            let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
            let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
            let term = Arc::new(Term {
                master: Mutex::new(pair.master),
                writer: Mutex::new(writer),
                killer: Mutex::new(child.clone_killer()),
                job: Mutex::new(job),
                alive: AtomicBool::new(true),
                shell: shell.clone(),
                #[cfg(unix)]
                pid,
            });
            terms.insert(id.to_owned(), term.clone());
            drop(terms);
            let emit = self.emit.clone();
            let reader_id = id.to_owned();
            std::thread::spawn(move || {
                let mut chunk = [0u8; 8192];
                let mut pending = Vec::new();
                loop {
                    let n = match reader.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    pending.extend_from_slice(&chunk[..n]);
                    loop {
                        match std::str::from_utf8(&pending) {
                            Ok(text) => {
                                emit("term:data", json!({"id":reader_id,"data":text}));
                                pending.clear();
                                break;
                            }
                            Err(error) => {
                                let valid = error.valid_up_to();
                                if valid > 0 {
                                    let text = String::from_utf8_lossy(&pending[..valid]);
                                    emit("term:data", json!({"id":reader_id,"data":text}));
                                    pending.drain(..valid);
                                }
                                if let Some(invalid) = error.error_len() {
                                    pending.drain(..invalid);
                                    emit("term:data", json!({"id":reader_id,"data":"�"}));
                                } else {
                                    break;
                                }
                            }
                        }
                    }
                }
                if !pending.is_empty() {
                    emit(
                        "term:data",
                        json!({"id":reader_id,"data":String::from_utf8_lossy(&pending)}),
                    );
                }
            });
            let emit = self.emit.clone();
            let terms = Arc::downgrade(&self.terms);
            let exit_id = id.to_owned();
            std::thread::spawn(move || {
                let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
                term.alive.store(false, Ordering::Release);
                term.job.lock().unwrap().take();
                if let Some(terms) = terms.upgrade() {
                    let mut terms = terms.lock().unwrap();
                    if terms.get(&exit_id).is_some_and(|t| Arc::ptr_eq(t, &term)) {
                        terms.remove(&exit_id);
                    }
                }
                emit("term:exit", json!({"id":exit_id,"exitCode":code}));
            });
            return Ok(json!({"id":id,"shell":shell}));
        }
        let id = arg(0).as_str().ok_or("Terminal id is required")?;
        let term = self
            .terms
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned();
        if let Some(term) = term {
            match channel {
                "term:write" => {
                    let data = arg(1).as_str().ok_or("Terminal input must be text")?;
                    if data.len() > 1024 * 1024 {
                        return Err("Terminal input is too large".into());
                    }
                    let mut writer = term.writer.lock().map_err(|e| e.to_string())?;
                    writer
                        .write_all(data.as_bytes())
                        .and_then(|_| writer.flush())
                        .map_err(|e| e.to_string())?;
                }
                "term:resize" => {
                    term.master
                        .lock()
                        .map_err(|e| e.to_string())?
                        .resize(PtySize {
                            cols: arg(1).as_u64().unwrap_or(80).clamp(2, 2000) as u16,
                            rows: arg(2).as_u64().unwrap_or(24).clamp(1, 1000) as u16,
                            pixel_width: 0,
                            pixel_height: 0,
                        })
                        .map_err(|e| e.to_string())?;
                }
                "term:kill" => {
                    self.terms.lock().unwrap().remove(id);
                    term.kill();
                }
                _ => return Err("Unknown terminal command".into()),
            }
        }
        Ok(Value::Null)
    }
    pub fn shutdown(&self) {
        let terms = std::mem::take(&mut *self.terms.lock().unwrap());
        for term in terms.values() {
            term.kill();
        }
    }
}
impl Drop for Terminals {
    fn drop(&mut self) {
        self.shutdown();
    }
}
