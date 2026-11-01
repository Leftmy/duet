//! Read only OS process accounting for Duet and its descendants. No command lines or credentials.
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    time::Instant,
};
#[derive(Default)]
pub struct Resources {
    previous: HashMap<u32, (u64, Instant)>,
    pub last: Value,
}
struct Row {
    pid: u32,
    parent: u32,
    rss: u64,
    cpu: u64,
}
impl Resources {
    pub fn sample(&mut self) {
        let rows = rows();
        let mut ours = HashSet::from([std::process::id()]);
        loop {
            let before = ours.len();
            for r in &rows {
                if ours.contains(&r.parent) {
                    ours.insert(r.pid);
                }
            }
            if ours.len() == before {
                break;
            }
        }
        let now = Instant::now();
        let mut rss = 0;
        let mut cpu = 0.;
        let mut processes = Vec::new();
        for r in rows.iter().filter(|r| ours.contains(&r.pid)) {
            rss += r.rss;
            let pct = self
                .previous
                .get(&r.pid)
                .map(|(old, at)| {
                    r.cpu.saturating_sub(*old) as f64
                        / 10_000_000.
                        / now.duration_since(*at).as_secs_f64().max(0.01)
                        * 100.
                })
                .unwrap_or(0.);
            cpu += pct;
            self.previous.insert(r.pid, (r.cpu, now));
            processes.push(json!({"pid":r.pid,"rssBytes":r.rss,"cpuPct":pct}));
        }
        self.previous.retain(|id, _| ours.contains(id));
        self.last = json!({"rssBytes":rss,"cpuPct":cpu,"processes":processes,"sampledAt":super::storage::now(),"includesDescendants":true});
    }
}
#[cfg(target_os = "linux")]
fn rows() -> Vec<Row> {
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as u64;
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(1) as u64;
    std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .filter_map(|e| {
            let e = e.ok()?;
            let pid = e.file_name().to_str()?.parse().ok()?;
            let text = std::fs::read_to_string(e.path().join("stat")).ok()?;
            let (_, tail) = text.rsplit_once(')')?;
            let v: Vec<_> = tail.split_whitespace().collect();
            Some(Row {
                pid,
                parent: v.get(1)?.parse().ok()?,
                rss: v.get(21)?.parse::<u64>().ok()?.saturating_mul(page),
                cpu: (v.get(11)?.parse::<u64>().ok()? + v.get(12)?.parse::<u64>().ok()?)
                    .saturating_mul(10_000_000)
                    / hz,
            })
        })
        .collect()
}
#[cfg(windows)]
fn rows() -> Vec<Row> {
    use std::ffi::c_void;
    #[repr(C)]
    struct Entry {
        size: u32,
        usage: u32,
        pid: u32,
        heap: usize,
        module: u32,
        threads: u32,
        parent: u32,
        priority: i32,
        flags: u32,
        name: [u16; 260],
    }
    #[repr(C)]
    #[derive(Default)]
    struct Counters {
        size: u32,
        faults: u32,
        peak: usize,
        working: usize,
        pp: usize,
        p: usize,
        pnp: usize,
        np: usize,
        page: usize,
        peak_page: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
        fn Process32FirstW(h: *mut c_void, e: *mut Entry) -> i32;
        fn Process32NextW(h: *mut c_void, e: *mut Entry) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(h: *mut c_void) -> i32;
        fn GetProcessTimes(
            h: *mut c_void,
            c: *mut u64,
            e: *mut u64,
            k: *mut u64,
            u: *mut u64,
        ) -> i32;
    }
    #[link(name = "psapi")]
    unsafe extern "system" {
        fn GetProcessMemoryInfo(h: *mut c_void, c: *mut Counters, n: u32) -> i32;
    }
    let mut out = Vec::new();
    unsafe {
        let h = CreateToolhelp32Snapshot(2, 0);
        if h as isize == -1 {
            return out;
        }
        let mut e: Entry = std::mem::zeroed();
        e.size = std::mem::size_of::<Entry>() as u32;
        let mut ok = Process32FirstW(h, &mut e);
        while ok != 0 {
            out.push(Row {
                pid: e.pid,
                parent: e.parent,
                rss: 0,
                cpu: 0,
            });
            ok = Process32NextW(h, &mut e);
        }
        CloseHandle(h);
        // Enumerate once, but query memory/CPU only for our process tree.
        let mut ours = HashSet::from([std::process::id()]);
        loop {
            let n = ours.len();
            for r in &out {
                if ours.contains(&r.parent) {
                    ours.insert(r.pid);
                }
            }
            if ours.len() == n {
                break;
            }
        }
        for r in out.iter_mut().filter(|r| ours.contains(&r.pid)) {
            let p = OpenProcess(0x0400 | 0x0010, 0, r.pid);
            if p.is_null() {
                continue;
            }
            let mut c = Counters::default();
            c.size = std::mem::size_of::<Counters>() as u32;
            let n = c.size;
            GetProcessMemoryInfo(p, &mut c, n);
            r.rss = c.working as u64;
            let (mut created, mut exit, mut kernel, mut user) = (0, 0, 0, 0);
            if GetProcessTimes(p, &mut created, &mut exit, &mut kernel, &mut user) != 0 {
                r.cpu = kernel + user
            }
            CloseHandle(p);
        }
    }
    out
}
#[cfg(not(any(windows, target_os = "linux")))]
fn rows() -> Vec<Row> {
    Vec::new()
}
