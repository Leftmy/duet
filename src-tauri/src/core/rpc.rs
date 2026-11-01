//! Bounded JSON-lines transport for native CLI protocols. Reader never waits for a user approval.
use super::{
    process::{ProcessJob, Program},
    wire_json,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
pub type Handler = Arc<dyn Fn(Arc<Client>, Value) + Send + Sync>;
pub struct Client {
    input: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    job: Mutex<Option<ProcessJob>>,
    pending: Mutex<HashMap<String, mpsc::SyncSender<Result<Value, String>>>>,
    pub closed: AtomicBool,
    seq: AtomicU64,
    pub stderr: Mutex<String>,
}
fn key(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        s.into()
    } else {
        v.to_string()
    }
}
pub fn line(reader: &mut impl BufRead, cap: usize) -> Result<Option<Vec<u8>>, String> {
    let mut out = Vec::new();
    loop {
        let buf = reader.fill_buf().map_err(|e| e.to_string())?;
        if buf.is_empty() {
            return if out.is_empty() {
                Ok(None)
            } else {
                Ok(Some(out))
            };
        }
        let n = buf
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(buf.len());
        if out.len() + n > cap {
            return Err(format!("CLI frame exceeds {cap} bytes"));
        }
        out.extend_from_slice(&buf[..n]);
        let done = buf[n - 1] == b'\n';
        reader.consume(n);
        if done {
            return Ok(Some(out));
        }
    }
}
impl Client {
    pub fn pid(&self)->Option<u32>{self.child.lock().unwrap().as_ref().map(|c|c.id())}
    pub fn spawn(
        program: &Program,
        args: &[String],
        cwd: &Path,
        handler: Handler,
        on_exit: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<Arc<Self>, String> {
        let mut child = program
            .command()
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("{}: {e}", program.bin.display()))?;
        let job = match ProcessJob::bind(child.id()) {
            Ok(v) => v,
            Err(e) => {
                super::process::terminate(&mut child);
                return Err(e);
            }
        };
        let out = child.stdout.take().unwrap();
        let err = child.stderr.take().unwrap();
        let c = Arc::new(Self {
            input: Mutex::new(child.stdin.take()),
            child: Mutex::new(Some(child)),
            job: Mutex::new(Some(job)),
            pending: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            seq: AtomicU64::new(0),
            stderr: Mutex::new(String::new()),
        });
        let weak = Arc::downgrade(&c);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(out);
            let failure = loop {
                match line(&mut reader, 32 * 1024 * 1024) {
                    Ok(Some(line)) => {
                        let Some(c) = weak.upgrade() else {
                            break "CLI owner closed".into();
                        };
                        if let Ok(msg) = wire_json::parse(&line) {
                            let response = if msg["type"] == "control_response" {
                                Some((
                                    &msg["response"]["request_id"],
                                    if msg["response"]["subtype"] == "error" {
                                        Err(msg["response"]["error"]
                                            .as_str()
                                            .unwrap_or("CLI request failed")
                                            .to_owned())
                                    } else {
                                        Ok(msg["response"]["response"].clone())
                                    },
                                ))
                            } else if !msg["id"].is_null() && msg["method"].is_null() {
                                Some((
                                    &msg["id"],
                                    if msg["error"].is_null() {
                                        Ok(msg["result"].clone())
                                    } else {
                                        Err(msg["error"]["message"]
                                            .as_str()
                                            .unwrap_or("RPC request failed")
                                            .to_owned())
                                    },
                                ))
                            } else {
                                None
                            };
                            if let Some((id, result)) = response {
                                if let Some(tx) = c.pending.lock().unwrap().remove(&key(id)) {
                                    let _ = tx.send(result);
                                }
                            } else {
                                handler(c, msg)
                            }
                        }
                    }
                    Ok(None) => break "CLI exited".into(),
                    Err(e) => break e,
                }
            };
            if let Some(c) = weak.upgrade() {
                let unexpected = !c.closed.swap(true, Ordering::AcqRel);
                for (_, p) in c.pending.lock().unwrap().drain() {
                    let _ = p.send(Err(failure.clone()));
                }
                let tail = c.stderr.lock().unwrap().clone();
                c.close_process();
                if unexpected {
                    on_exit(format!(
                        "{failure}{}",
                        if tail.is_empty() {
                            String::new()
                        } else {
                            format!(": {tail}")
                        }
                    ));
                }
            }
        });
        let weak = Arc::downgrade(&c);
        std::thread::spawn(move || {
            let mut err = err;
            let mut b = [0u8; 4096];
            while let Ok(n) = err.read(&mut b) {
                if n == 0 {
                    break;
                }
                let Some(c) = weak.upgrade() else { break };
                let mut tail = c.stderr.lock().unwrap();
                tail.push_str(&String::from_utf8_lossy(&b[..n]));
                if tail.len() > 4096 {
                    let mut start = tail.len() - 4096;
                    while !tail.is_char_boundary(start) {
                        start += 1
                    }
                    tail.drain(..start);
                }
            }
        });
        Ok(c)
    }
    pub fn write(&self, value: &Value) -> Result<(), String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("CLI is closed".into());
        }
        let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        if bytes.len() > 32 * 1024 * 1024 {
            return Err("CLI input is too large".into());
        }
        let mut g = self.input.lock().unwrap();
        let pipe = g.as_mut().ok_or("CLI input is closed")?;
        pipe.write_all(&bytes)
            .and_then(|_| pipe.write_all(b"\n"))
            .and_then(|_| pipe.flush())
            .map_err(|e| e.to_string())
    }
    pub fn finish_input(&self, bytes: &[u8]) -> Result<(), String> {
        let mut input = self.input.lock().unwrap();
        let mut pipe = input.take().ok_or("CLI input closed")?;
        pipe.write_all(bytes).map_err(|e| e.to_string())
    }
    fn call(&self, id: String, msg: Value, timeout: Duration) -> Result<Value, String> {
        let (tx, rx) = mpsc::sync_channel(1);
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.len() >= 256 {
                return Err("Too many pending CLI requests".into());
            }
            pending.insert(id.clone(), tx);
        }
        let result = self.write(&msg).and_then(|_| {
            rx.recv_timeout(timeout)
                .map_err(|_| "CLI request timed out".to_owned())?
        });
        self.pending.lock().unwrap().remove(&id);
        result
    }
    pub fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        self.call(
            id.to_string(),
            json!({"id":id,"method":method,"params":params}),
            Duration::from_secs(120),
        )
    }
    /// Write in protocol order without retaining a waiter for the response.
    pub fn send_request(&self, method: &str, params: Value) -> Result<(), String> {
        let id = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        self.write(&json!({"id":id,"method":method,"params":params}))
    }
    pub fn control(&self, request: Value) -> Result<Value, String> {
        let id = format!("duet-{}", self.seq.fetch_add(1, Ordering::Relaxed));
        self.call(
            id.clone(),
            json!({"type":"control_request","request_id":id,"request":request}),
            Duration::from_secs(120),
        )
    }
    pub fn respond(&self, id: Value, result: Result<Value, String>) {
        let _ = self.write(&match result {
            Ok(result) => json!({"id":id,"result":result}),
            Err(error) => json!({"id":id,"error":{"code":-32000,"message":error}}),
        });
    }
    pub fn control_response(&self, id: Value, result: Result<Value, String>) {
        let _=self.write(&json!({"type":"control_response","response":match result{Ok(response)=>json!({"subtype":"success","request_id":id,"response":response}),Err(error)=>json!({"subtype":"error","request_id":id,"error":error})}}));
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        for (_, p) in self.pending.lock().unwrap().drain() {
            let _ = p.send(Err("CLI closed".into()));
        }
        self.close_process()
    }
    fn close_process(&self) {
        // A stuck CLI can leave a writer holding input while its pipe is full.
        // Terminate our process tree first so that write returns BrokenPipe.
        if let Some(mut child) = self.child.lock().unwrap().take() {
            super::process::terminate(&mut child);
        }
        self.job.lock().unwrap().take();
        self.input.lock().unwrap().take();
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.close_process();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closing_a_cli_that_does_not_read_stdin_unblocks_pending_writes() {
        let (program, args) = if cfg!(windows) {
            (
                Program::new("powershell.exe"),
                vec![
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-Command".into(),
                    "Start-Sleep -Seconds 30".into(),
                ],
            )
        } else {
            (
                Program::new("/bin/sh"),
                vec!["-c".into(), "sleep 30".into()],
            )
        };
        let client = Client::spawn(
            &program,
            &args,
            &std::env::temp_dir(),
            Arc::new(|_, _| {}),
            Arc::new(|_| {}),
        )
        .unwrap();
        let writer_client = client.clone();
        let writer = std::thread::spawn(move || {
            writer_client.write(&json!({"payload":"x".repeat(4*1024*1024)}))
        });
        let start = std::time::Instant::now();
        while client.input.try_lock().is_ok() {
            assert!(start.elapsed() < Duration::from_secs(3));
            std::thread::yield_now();
        }
        let closing = client.clone();
        let (tx, rx) = mpsc::channel();
        let closer = std::thread::spawn(move || {
            closing.close();
            tx.send(()).unwrap();
        });
        rx.recv_timeout(Duration::from_secs(5))
            .expect("Close must not wait for a blocked stdin writer");
        assert!(writer.join().unwrap().is_err());
        closer.join().unwrap();
        assert!(client.closed.load(Ordering::Acquire));
    }
}
