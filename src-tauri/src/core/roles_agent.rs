//! Roles are enforced by native provider permissions and by the dynamic-tool boundary.
use super::*;
pub(super) fn role_key(t: &Thread) -> String {
    let scope = t.context_scope.lock().unwrap().clone();
    if scope.is_empty() {
        t.id.clone()
    } else {
        format!("scope:{scope}")
    }
}
pub(super) fn read_only(cfg: &Value) -> bool {
    matches!(cfg["role"].as_str(), Some("reviewer" | "researcher"))
}
impl Agents {
    pub(super) fn workbench_role(self: &Arc<Self>, p: &Value) -> CoreResult {
        let role = s(p, "role");
        if !["executor", "reviewer", "researcher"].contains(&role) {
            return Err("Unknown agent role".into());
        }
        let t = self
            .find(s(p, "threadId"))
            .ok_or("Chat is not initialized")?;
        if t.hidden {
            return Err("Background service roles cannot be changed".into());
        }
        let _gate = t.context_gate.lock().unwrap();
        let _ownership = self.team_admission.lock().unwrap();
        if {
            let q = self.dispatch.lock().unwrap();
            q.queued(&t.id) || q.active.contains_key(&t.id)
        } || t.run.lock().unwrap().as_ref().is_some_and(|r| {
            r.running.load(Ordering::Acquire)
                || r.sending.load(Ordering::Acquire)
                || self.context_native_busy(&t, r)
        }) {
            return Err("Wait for the agent to finish before changing its role".into());
        }
        let cwd = s(&t.config.lock().unwrap(), "cwd").to_owned();
        let (_, workspace) = crate::core::workspaces::identity(Path::new(&cwd));
        let mut transfers = Vec::new();
        if role == "executor" {
            for other in self.family(&t) {
                if other.id == t.id {
                    continue;
                }
                let cfg = other.config.lock().unwrap().clone();
                if read_only(&cfg) {
                    continue;
                }
                let (_, own) = crate::core::workspaces::identity(Path::new(s(&cfg, "cwd")));
                if own != workspace {
                    continue;
                }
                if other.run.lock().unwrap().as_ref().is_some_and(|r| {
                    r.running.load(Ordering::Acquire)
                        || r.sending.load(Ordering::Acquire)
                        || self.context_native_busy(&other, r)
                }) || {
                    let q = self.dispatch.lock().unwrap();
                    q.queued(&other.id) || q.active.contains_key(&other.id)
                } {
                    return Err("The current executor is busy; finish its turn before transferring ownership".into());
                }
                transfers.push(other);
            }
        }
        for other in transfers {
            let run = other.run.lock().unwrap().clone();
            if let Some(run) = run {
                self.stop_run(&run)
            }
            other.config.lock().unwrap()["role"] = json!("reviewer");
            other.config.lock().unwrap()["permissionMode"] = json!("plan");
            self.queue_log.set_role(
                &role_key(&other),
                &other.provider.lock().unwrap(),
                &other.session.lock().unwrap(),
                "reviewer",
            )?;
            self.team_record(&other, json!({"type":"role.changed","role":"reviewer"}));
            (self.emit)(
                "agent:event",
                json!({"threadId":other.id,"ev":{"type":"role","role":"reviewer"}}),
            );
        }
        let run = t.run.lock().unwrap().clone();
        if let Some(run) = run {
            self.stop_run(&run)
        }
        {
            let mut cfg = t.config.lock().unwrap();
            cfg["role"] = json!(role);
            if role != "executor" {
                cfg["permissionMode"] = json!("plan")
            } else {
                cfg["permissionMode"] = json!("default")
            }
        }
        self.queue_log.set_role(
            &role_key(&t),
            &t.provider.lock().unwrap(),
            &t.session.lock().unwrap(),
            role,
        )?;
        self.team_record(&t, json!({"type":"role.changed","role":role}));
        (self.emit)(
            "agent:event",
            json!({"threadId":t.id,"ev":{"type":"role","role":role}}),
        );
        (self.emit)(
            "desk:workbench-update",
            json!({"threadId":t.id,"role":role}),
        );
        Ok(json!({"role":role}))
    }
    pub(super) fn workbench_conflicts(&self, _p: &Value) -> CoreResult {
        let all: Vec<_> = self
            .threads
            .lock()
            .unwrap()
            .values()
            .filter(|t| !t.hidden)
            .cloned()
            .collect();
        let tasks: Vec<_> = all
            .into_iter()
            .filter_map(|t| {
                let cfg = t.config.lock().unwrap().clone();
                let cwd = s(&cfg, "cwd");
                if cwd.is_empty() {
                    None
                } else {
                    Some(json!({"id":t.id,"cwd":cwd}))
                }
            })
            .collect();
        let mut workspaces = self
            .workspaces
            .try_lock()
            .map_err(|_| "A conflict preview is already running")?;
        workspaces.forecast(&tasks, &self.storage.data.join("native/preview-index"))
    }
}
