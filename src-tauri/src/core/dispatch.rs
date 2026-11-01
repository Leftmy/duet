//! Fair admission for model turns. No provider is started while a request is queued.
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
#[derive(Clone, Debug)]
pub struct Lease {
    pub id: String,
    pub project: String,
    pub team: String,
    pub provider: String,
    pub workspace: String,
    pub writer: bool,
}
pub struct Pending {
    pub lease: Lease,
    pub messages: Vec<Value>,
    pub at: u64,
    pub reason: String,
    pub bytes: usize,
    pub ticket: String,
}
#[derive(Clone, Copy)]
pub struct Limits {
    pub total: usize,
    pub project: usize,
    pub team: usize,
    pub provider: usize,
    pub memory_mb: u64,
}
impl Limits {
    pub fn read(ui: &Value) -> Self {
        let n = |key: &str, default| {
            ui["dispatchLimits"][key]
                .as_u64()
                .unwrap_or(default)
                .clamp(1, 64) as usize
        };
        Self {
            total: n("total", 4),
            project: n("project", 3),
            team: n("team", 4),
            provider: n("provider", 4),
            memory_mb: ui["dispatchLimits"]["memoryMb"]
                .as_u64()
                .unwrap_or(0)
                .min(262144),
        }
    }
    pub fn json(self) -> Value {
        json!({"total":self.total,"project":self.project,"team":self.team,"provider":self.provider,"memoryMb":self.memory_mb})
    }
}
#[derive(Default)]
pub struct Dispatcher {
    pub active: HashMap<String, Lease>,
    pub pending: VecDeque<Pending>,
    pub waiting: HashMap<String, Lease>,
    pub resumes: VecDeque<Lease>,
    pub paused: bool,
}
impl Dispatcher {
    pub fn reason(&self, lease: &Lease, limits: Limits, memory: u64) -> Option<&'static str> {
        if self.paused {
            return Some("paused");
        }
        if limits.memory_mb > 0 && memory > limits.memory_mb * 1024 * 1024 {
            return Some("memory");
        }
        self.capacity(lease, limits)
    }
    pub fn capacity(&self, lease: &Lease, limits: Limits) -> Option<&'static str> {
        if self.active.contains_key(&lease.id) {
            return Some("turn");
        }
        if lease.writer
            && self
                .active
                .values()
                .chain(self.waiting.values())
                .chain(self.resumes.iter())
                .any(|x| x.writer && x.workspace == lease.workspace && x.id != lease.id)
        {
            return Some("workspace");
        }
        if self.active.len() >= limits.total {
            return Some("total");
        }
        if self
            .active
            .values()
            .filter(|x| x.project == lease.project)
            .count()
            >= limits.project
        {
            return Some("project");
        }
        if self
            .active
            .values()
            .filter(|x| x.team == lease.team)
            .count()
            >= limits.team
        {
            return Some("team");
        }
        if self
            .active
            .values()
            .filter(|x| x.provider == lease.provider)
            .count()
            >= limits.provider
        {
            return Some("provider");
        }
        None
    }
    pub fn queued(&self, id: &str) -> bool {
        self.pending.iter().any(|x| x.lease.id == id)
    }
    pub fn cancel(&mut self, id: &str) -> Option<Pending> {
        let i = self.pending.iter().position(|x| x.lease.id == id)?;
        self.pending.remove(i)
    }
    pub fn next(&mut self, limits: Limits, memory: u64) -> Option<Pending> {
        let i = self
            .pending
            .iter()
            .position(|x| self.reason(&x.lease, limits, memory).is_none())?;
        let job = self.pending.remove(i)?;
        self.active.insert(job.lease.id.clone(), job.lease.clone());
        Some(job)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn lease(id: &str, p: &str, t: &str) -> Lease {
        Lease {
            id: id.into(),
            project: p.into(),
            team: t.into(),
            provider: "claude".into(),
            workspace: id.into(),
            writer: true,
        }
    }
    #[test]
    fn admission_is_bounded_fair_and_does_not_block_other_projects() {
        let limits = Limits {
            total: 3,
            project: 1,
            team: 2,
            provider: 3,
            memory_mb: 0,
        };
        let mut q = Dispatcher::default();
        q.active.insert("a".into(), lease("a", "p", "t"));
        for (id, p) in [("b", "p"), ("c", "other"), ("d", "third")] {
            q.pending.push_back(Pending {
                lease: lease(id, p, "t"),
                messages: vec![json!({"uuid":id})],
                at: 1,
                reason: "project".into(),
                bytes: 0,
                ticket: id.into(),
            });
        }
        assert_eq!(q.next(limits, 0).unwrap().lease.id, "c");
        assert!(q.next(limits, 0).is_none());
        q.active.remove("a");
        assert_eq!(q.next(limits, 0).unwrap().lease.id, "b");
        assert!(q.cancel("d").is_some());
        assert!(!q.queued("d"));
    }
    #[test]
    fn memory_and_pause_defer_without_killing_leases() {
        let mut q = Dispatcher::default();
        let mut l = Limits::read(&json!({}));
        l.memory_mb = 128;
        let a = lease("a", "p", "t");
        assert_eq!(q.reason(&a, l, 129 * 1024 * 1024), Some("memory"));
        q.paused = true;
        assert_eq!(q.reason(&a, l, 0), Some("paused"));
        q.active.insert(a.id.clone(), a);
        assert_eq!(q.active.len(), 1);
    }
    #[test]
    fn an_approval_wait_keeps_workspace_ownership_but_releases_compute_capacity() {
        let mut q = Dispatcher::default();
        let l = Limits {
            total: 4,
            project: 4,
            team: 4,
            provider: 4,
            memory_mb: 0,
        };
        let a = lease("a", "p", "t");
        let mut b = lease("b", "p", "t");
        b.workspace = a.workspace.clone();
        q.waiting.insert(a.id.clone(), a.clone());
        assert_eq!(q.capacity(&b, l), Some("workspace"));
        b.writer = false;
        assert!(q.capacity(&b, l).is_none());
        assert!(q.capacity(&a, l).is_none());
    }
}
