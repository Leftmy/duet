//! Native task supervision shared by all providers and the desktop inbox.
use super::*;
use crate::core::dispatch::{Lease, Limits, Pending};
impl Agents {
    fn dispatch_log(
        &self,
        t: &Arc<Thread>,
        ticket: &str,
        provider: &str,
        messages: &[Value],
    ) -> Result<(), String> {
        if t.hidden {
            return Ok(());
        }
        let durable: Vec<Value> = messages
            .iter()
            .filter(|p| p["_idleOnly"] != true && p["_contextContinue"] != true)
            .cloned()
            .collect();
        if durable.is_empty() {
            return Ok(());
        }
        self.queue_log.put(
            ticket,
            &t.id,
            provider,
            t.config.lock().unwrap()["role"]
                .as_str()
                .unwrap_or("executor"),
            &durable,
        )
    }
    pub(super) fn dispatch_control(&self, t: &Arc<Thread>, provider: &str) -> Result<(), String> {
        let _admission = self.team_admission.lock().unwrap();
        let cwd = t.config.lock().unwrap()["cwd"].clone();
        let lease = self.dispatch_lease(t, &json!({"provider":provider,"cwd":cwd}));
        let limits = Limits::read(&self.storage.ui());
        let memory = self.resources.lock().unwrap().last["rssBytes"]
            .as_u64()
            .unwrap_or(0);
        let mut q = self.dispatch.lock().unwrap();
        if let Some(reason) = q.reason(&lease, limits, memory) {
            return Err(format!("Model operation is waiting for capacity ({reason}); retry after the active turn finishes"));
        }
        q.active.insert(t.id.clone(), lease);
        Ok(())
    }
    pub(super) fn dispatch_waiting(&self, t: &Arc<Thread>) {
        let mut q = self.dispatch.lock().unwrap();
        if let Some(lease) = q.active.remove(&t.id) {
            q.waiting.insert(t.id.clone(), lease);
        }
        drop(q);
        self.dispatch_pump();
    }
    pub(super) fn dispatch_resume(&self, t: &Arc<Thread>, run: &Arc<Run>) -> bool {
        if !Self::current(run) || run.stopping.load(Ordering::Acquire) {
            return false;
        }
        {
            let mut q = self.dispatch.lock().unwrap();
            if let Some(lease) = q.waiting.remove(&t.id) {
                q.resumes.push_back(lease);
            } else {
                return true;
            }
        }
        self.dispatch_pump();
        loop {
            if !Self::current(run)
                || run.stopping.load(Ordering::Acquire)
                || t.mailbox_paused.load(Ordering::Acquire)
            {
                let mut q = self.dispatch.lock().unwrap();
                q.resumes.retain(|x| x.id != t.id);
                q.active.remove(&t.id);
                return false;
            }
            if self.dispatch.lock().unwrap().active.contains_key(&t.id) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
            self.dispatch_pump();
        }
    }
    fn dispatch_lease(&self, t: &Arc<Thread>, p: &Value) -> Lease {
        let cfg = t.config.lock().unwrap().clone();
        let cwd = p["cwd"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| cfg["cwd"].as_str().filter(|s| !s.is_empty()))
            .map(str::to_owned)
            .unwrap_or_else(|| self.storage.home.to_string_lossy().into_owned());
        let (project, _) = crate::core::workspaces::identity(Path::new(&cwd));
        Lease {
            id: t.id.clone(),
            project,
            team: self.family_root(t).id.clone(),
            provider: p["provider"].as_str().unwrap_or("claude").into(),
        }
    }
    pub(super) fn dispatch_event(&self, t: &Arc<Thread>, phase: &str, reason: &str) {
        let ev =
            json!({"type":"dispatch","phase":phase,"reason":reason,"timestamp":storage::now()});
        self.team_record(t, ev.clone());
        if let Some(sub) = &t.sub {
            (self.emit)(
                "agent:event",
                json!({"threadId":self.family_root(t).id,"ev":{"type":"agent","id":sub.tool,"runId":t.id,"status":if phase=="cancelled"{"stopped"}else{"running"},"progress":if phase=="queued"{format!("Queued: {reason}")}else{String::new()}}}),
            );
        }
        (self.emit)("agent:event", json!({"threadId":t.id,"ev":ev}));
        (self.emit)(
            "desk:workbench-update",
            json!({"threadId":t.id,"phase":phase}),
        );
    }
    pub(super) fn dispatch_admit(&self, t: &Arc<Thread>, p: &Value) -> Result<bool, String> {
        let _admission = self.team_admission.lock().unwrap();
        if self.closing.load(Ordering::Acquire) {
            return Err("Application is closing".into());
        }
        if p["_dispatchGranted"] == true && t.mailbox_paused.load(Ordering::Acquire) {
            return Err("Queued turn was cancelled".into());
        }
        let running = t.run.lock().unwrap().as_ref().is_some_and(|r| {
            r.running.load(Ordering::Acquire) || r.sending.load(Ordering::Acquire)
        });
        if running {
            return Ok(false);
        }
        let lease = self.dispatch_lease(t, p);
        let limits = Limits::read(&self.storage.ui());
        let memory = self.resources.lock().unwrap().last["rssBytes"]
            .as_u64()
            .unwrap_or(0);
        let mut q = self.dispatch.lock().unwrap();
        if q.active.contains_key(&t.id) {
            drop(q);
            if p["_dispatchGranted"] == true {
                self.dispatch_event(t, "running", "");
            }
            return Ok(false);
        }
        let bytes = p.to_string().len();
        if q.pending.iter().map(|x| x.bytes).sum::<usize>() + bytes > 64 * 1024 * 1024 {
            return Err("Queued input memory budget reached; retry after delivery".into());
        }
        if let Some(job) = q.pending.iter_mut().find(|x| x.lease.id == t.id) {
            if job.messages.len() >= 32
                || job
                    .messages
                    .iter()
                    .map(|v| v.to_string().len())
                    .sum::<usize>()
                    + p.to_string().len()
                    > 16 * 1024 * 1024
            {
                return Err("Queued chat input is full".into());
            }
            if !p["uuid"].is_string() || !job.messages.iter().any(|m| m["uuid"] == p["uuid"]) {
                let mut input = p.clone();
                input["_dispatchTicket"] = json!(job.ticket);
                input["_queuedMessage"] = json!(uuid::Uuid::new_v4().to_string());
                job.messages.push(input);
                if let Err(e) =
                    self.dispatch_log(t, &job.ticket, &job.lease.provider, &job.messages)
                {
                    job.messages.pop();
                    return Err(e);
                }
                job.bytes += bytes;
            }
            return Ok(true);
        }
        let reason = q.reason(&lease, limits, memory).or_else(|| {
            if !q.pending.is_empty() {
                Some("queue")
            } else {
                None
            }
        });
        if let Some(reason) = reason {
            if q.pending.len() >= 256 || p.to_string().len() > 16 * 1024 * 1024 {
                return Err("Dispatch queue is full or input exceeds 16 MiB".into());
            }
            let ticket = uuid::Uuid::new_v4().to_string();
            let mut input = p.clone();
            input["_dispatchTicket"] = json!(ticket);
            input["_queuedMessage"] = json!(uuid::Uuid::new_v4().to_string());
            let messages = vec![input];
            self.dispatch_log(t, &ticket, &lease.provider, &messages)?;
            q.pending.push_back(Pending {
                lease,
                messages,
                at: storage::now(),
                reason: reason.into(),
                bytes,
                ticket,
            });
            drop(q);
            {
                let mut cfg = t.config.lock().unwrap();
                for key in ["cwd", "model", "role", "resume"] {
                    if let Some(v) = p.get(key) {
                        cfg[key] = v.clone()
                    }
                }
            }
            self.dispatch_event(t, "queued", reason);
            self.dispatch_pump();
            return Ok(true);
        }
        q.active.insert(t.id.clone(), lease);
        drop(q);
        self.dispatch_event(t, "running", "");
        Ok(false)
    }
    pub(super) fn dispatch_finish(&self, t: &Arc<Thread>) {
        let busy = t.run.lock().unwrap().as_ref().is_some_and(|r| {
            r.running.load(Ordering::Acquire)
                || r.sending.load(Ordering::Acquire)
                || self.context_native_busy(t, r)
        });
        if !busy && self.dispatch.lock().unwrap().active.remove(&t.id).is_some() {
            self.dispatch_pump();
            (self.emit)("desk:workbench-update", json!({"threadId":t.id}));
        }
    }
    pub(super) fn dispatch_cancel(&self, t: &Arc<Thread>) -> bool {
        let _gate = t.context_gate.lock().unwrap();
        t.mailbox_paused.store(true, Ordering::Release);
        {
            let mut q = self.dispatch.lock().unwrap();
            q.waiting.remove(&t.id);
            q.resumes.retain(|x| x.id != t.id);
        }
        if let Err(error) = self.queue_log.cancel_owner(&t.id) {
            (self.emit)("desk:workbench-update", json!({"error":error}));
        }
        let job = self.dispatch.lock().unwrap().cancel(&t.id);
        if let Some(job) = job {
            t.mailbox_paused.store(true, Ordering::Release);
            for p in job.messages {
                if p["uuid"].is_string() {
                    (self.emit)(
                        "agent:event",
                        json!({"threadId":t.id,"ev":{"type":"message.receipt","id":p["uuid"],"status":"cancelled"}}),
                    );
                }
            }
            *t.result.lock().unwrap() = json!({"stopped":true,"turnSequence":t.turn_sequence.load(Ordering::Acquire),"text":"Queued turn cancelled"});
            t.wake.notify_all();
            if let Some(sub) = &t.sub {
                if let Some(parent) = self.find(&sub.parent) {
                    let r = parent.run.lock().unwrap().clone();
                    if let Some(r) = r {
                        r.background
                            .lock()
                            .unwrap()
                            .remove(&format!("agent:{}", sub.tool));
                    }
                }
            }
            self.dispatch_event(t, "cancelled", "");
            (self.emit)(
                "agent:event",
                json!({"threadId":t.id,"ev":{"type":"turn.end","stopped":true,"text":"Queued turn cancelled"}}),
            );
            self.collaboration.wake();
            self.dispatch_pump();
            return true;
        }
        false
    }
    pub(super) fn dispatch_pump(&self) {
        if self.closing.load(Ordering::Acquire)
            || self.dispatch_pumping.swap(true, Ordering::AcqRel)
        {
            return;
        }
        let Some(owner) = self.weak.upgrade() else {
            self.dispatch_pumping.store(false, Ordering::Release);
            return;
        };
        if owner.spawn(move|owner|{
            loop{
                let limits=Limits::read(&owner.storage.ui());let memory=owner.resources.lock().unwrap().last["rssBytes"].as_u64().unwrap_or(0);
                {let mut q=owner.dispatch.lock().unwrap();let index=q.resumes.iter().position(|x|q.capacity(x,limits).is_none());if let Some(i)=index{let lease=q.resumes.remove(i).unwrap();q.active.insert(lease.id.clone(),lease);continue}}
                let job=owner.dispatch.lock().unwrap().next(limits,memory);let Some(job)=job else{break};
                let lease=job.lease.clone();let ticket=job.ticket.clone();let queued_at=job.at;
                let id=job.lease.id;let Some(t)=owner.find(&id)else{owner.dispatch.lock().unwrap().active.remove(&id);continue};
                if t.closed.load(Ordering::Acquire)||t.mailbox_paused.load(Ordering::Acquire){owner.dispatch.lock().unwrap().active.remove(&id);continue}
                let mut messages:std::collections::VecDeque<Value>=job.messages.into();
                while let Some(mut p)=messages.pop_front(){
                    let busy=t.run.lock().unwrap().as_ref().is_some_and(|r|r.running.load(Ordering::Acquire));
                    if busy&&(p["_idleOnly"]==true||matches!(lease.provider.as_str(),"antigravity"|"gemini")){
                        messages.push_front(p);let messages:Vec<Value>=messages.into();let bytes=messages.iter().map(|p|p.to_string().len()).sum();
                        owner.dispatch.lock().unwrap().pending.push_front(Pending{lease:lease.clone(),messages,at:queued_at,reason:"turn".into(),bytes,ticket:ticket.clone()});break
                    }
                    p["_dispatchGranted"]=json!(true);
                    if let Err(error)=owner.send_thread(t.clone(),&p){
                        if t.closed.load(Ordering::Acquire)||t.mailbox_paused.load(Ordering::Acquire){owner.dispatch.lock().unwrap().active.remove(&id);break}
                        if error=="Agent is still running; queue the message"{
                            messages.push_front(p);let messages:Vec<Value>=messages.into();let bytes=messages.iter().map(|p|p.to_string().len()).sum();
                            owner.dispatch.lock().unwrap().pending.push_front(Pending{lease:lease.clone(),messages,at:queued_at,reason:"turn".into(),bytes,ticket:ticket.clone()});break
                        }
                        if p["uuid"].is_string(){(owner.emit)("agent:event",json!({"threadId":id,"ev":{"type":"message.receipt","id":p["uuid"],"status":"failed","error":error}}));}
                        if let Ok(run)=owner.active(&id){owner.failed(&run,error);}else{(owner.emit)("agent:event",json!({"threadId":id,"ev":{"type":"turn.end","isError":true,"error":error}}));}
                        owner.dispatch.lock().unwrap().active.remove(&id);break
                    }
                }
            }
            owner.dispatch_pumping.store(false,Ordering::Release);
            let limits=Limits::read(&owner.storage.ui());let memory=owner.resources.lock().unwrap().last["rssBytes"].as_u64().unwrap_or(0);
            let ready={let q=owner.dispatch.lock().unwrap();q.pending.iter().any(|x|q.reason(&x.lease,limits,memory).is_none())||q.resumes.iter().any(|x|q.capacity(x,limits).is_none())};if ready{owner.dispatch_pump();}
        }).is_err(){self.dispatch_pumping.store(false,Ordering::Release)}
    }
    pub(crate) fn workbench_tick(&self) {
        self.resources.lock().unwrap().sample();
        let limit = Limits::read(&self.storage.ui()).memory_mb;
        if limit > 0
            && self.resources.lock().unwrap().last["rssBytes"]
                .as_u64()
                .unwrap_or(0)
                > limit * 1024 * 1024
        {
            let threads: Vec<_> = self.threads.lock().unwrap().values().cloned().collect();
            for t in threads {
                let r = t.run.lock().unwrap().clone();
                if let Some(r) = r {
                    if !r.running.load(Ordering::Acquire)
                        && !r.sending.load(Ordering::Acquire)
                        && !self.context_native_busy(&t, &r)
                        && r.requests.lock().unwrap().is_empty()
                    {
                        self.stop_run(&r);
                    }
                }
            }
        }
        let all: Vec<_> = self.threads.lock().unwrap().values().cloned().collect();
        for t in all {
            self.dispatch_finish(&t);
        }
        self.dispatch_pump();
    }
    pub(crate) fn workbench(self: &Arc<Self>, p: &Value) -> CoreResult {
        match p["action"].as_str().unwrap_or("inspect") {
            "inspect" => {
                {
                    let mut r = self.resources.lock().unwrap();
                    if storage::now().saturating_sub(r.last["sampledAt"].as_u64().unwrap_or(0))
                        > 5000
                    {
                        r.sample();
                    }
                }
                let rows: Vec<_> = self.threads.lock().unwrap().values().cloned().collect();
                let mut tasks = Vec::new();
                for t in rows {
                    if t.hidden {
                        continue;
                    }
                    let cfg = t.config.lock().unwrap().clone();
                    let r = t.run.lock().unwrap().clone();
                    let pending = self
                        .dispatch
                        .lock()
                        .unwrap()
                        .pending
                        .iter()
                        .find(|x| x.lease.id == t.id)
                        .map(|x| json!({"at":x.at,"reason":x.reason,"messages":x.messages.len()}));
                    let approvals: Vec<_> = self
                        .approvals
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|(_, a)| a.thread == t.id)
                        .map(|(id, _)| json!(id))
                        .collect();
                    tasks.push(json!({"id":t.id,"parent":t.sub.as_ref().map(|s|&s.parent),"root":self.family_root(&t).id,"provider":*t.provider.lock().unwrap(),"sessionId":*t.session.lock().unwrap(),"cwd":cfg["cwd"],"model":cfg["model"],"role":cfg["role"].as_str().unwrap_or("executor"),"queued":pending,"waitingApproval":self.dispatch.lock().unwrap().waiting.contains_key(&t.id),"working":self.dispatch.lock().unwrap().active.contains_key(&t.id)||r.as_ref().is_some_and(|r|r.running.load(Ordering::Acquire)||r.sending.load(Ordering::Acquire)),"approvals":approvals,"error":t.result.lock().unwrap()["error"],"lastActivity":r.as_ref().map(|r|r.last.load(Ordering::Relaxed)),"pid":r.as_ref().and_then(|r|r.client.lock().unwrap().as_ref().and_then(|c|c.pid()))}));
                }
                tasks.sort_by_key(|r| r["id"].as_str().unwrap_or("").to_owned());
                let q = self.dispatch.lock().unwrap();
                let busy: HashSet<String> = q
                    .active
                    .keys()
                    .chain(q.waiting.keys())
                    .cloned()
                    .chain(q.pending.iter().map(|p| p.lease.id.clone()))
                    .chain(q.resumes.iter().map(|p| p.id.clone()))
                    .collect();
                Ok(
                    json!({"tasks":tasks,"active":q.active.len(),"queued":q.pending.len(),"paused":q.paused,"limits":Limits::read(&self.storage.ui()).json(),"resources":self.resources.lock().unwrap().last,"recovery":self.queue_log.list(&busy)?}),
                )
            }
            "limits" => {
                let limits = Limits::read(&json!({"dispatchLimits":p["limits"]}));
                self.storage
                    .set_ui(&json!({"dispatchLimits":limits.json()}))?;
                self.dispatch_pump();
                Ok(limits.json())
            }
            "pause" => {
                self.dispatch.lock().unwrap().paused = true;
                Ok(json!(true))
            }
            "resume" => {
                self.dispatch.lock().unwrap().paused = false;
                self.dispatch_pump();
                Ok(json!(true))
            }
            "cancel" => {
                let t = self.find(s(p, "threadId")).ok_or("Unknown chat")?;
                let cancelled = self.dispatch_cancel(&t);
                if cancelled && t.sub.is_some() {
                    self.notify_completion(&t, None);
                }
                Ok(json!(cancelled))
            }
            "role" => self.workbench_role(p),
            "recovery" => {
                let id = s(p, "threadId");
                let mut result = self.queue_log.get(s(p, "ticket"), id)?;
                let t = self.thread(id, s(&result, "provider"))?;
                {
                    let mut cfg = t.config.lock().unwrap();
                    if cfg["cwd"].is_null() {
                        cfg["role"] = result["role"].clone();
                        cfg["_isolatedBase"] = result["messages"][0]["_isolatedBase"].clone();
                    } else {
                        result["role"] = json!(cfg["role"].as_str().unwrap_or("executor"));
                        result["provider"] = json!(*t.provider.lock().unwrap());
                    }
                }
                Ok(result)
            }
            "dismissRecovery" => {
                self.queue_log.delete(s(p, "ticket"))?;
                Ok(json!(true))
            }
            "conflicts" => self.workbench_conflicts(p),
            _ => Err("Unknown workbench action".into()),
        }
    }
}
