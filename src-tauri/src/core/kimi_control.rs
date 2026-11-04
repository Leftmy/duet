use super::*;
impl Agents {
    pub(in crate::core) fn kimi_action(self: &Arc<Self>, p: &Value) -> CoreResult {
        let action = s(p, "action");
        let b = self.kimi_backend()?;
        match action {
            "auth" => return b.api("GET", "/api/v1/auth", None),
            "login" => return b.api(
                "POST",
                "/api/v1/oauth/login",
                Some(
                    &json!({"provider":MANAGED,"region":p["region"].as_str().unwrap_or("global")}),
                ),
            ),
            "login/poll" => {
                let v = b.api("GET", "/api/v1/oauth/login", None)?;
                if v["status"] == "authenticated" {
                    *self.probe.lock().unwrap() = None;
                }
                return Ok(v);
            }
            "login/cancel" => return b.api("DELETE", "/api/v1/oauth/login", None),
            "logout" => {
                let v = b.api(
                    "POST",
                    "/api/v1/oauth/logout",
                    Some(&json!({"provider":MANAGED})),
                )?;
                *self.probe.lock().unwrap() = None;
                return Ok(v);
            }
            "models" => return b.models(),
            "usage" => return self.kimi_usage(),
            "plugins" => return b.api("GET", "/api/v1/plugins", None),
            "plugins/marketplace" => return b.api("GET", "/api/v1/plugins/marketplace", None),
            "plugins/install" => return b.api("POST", "/api/v1/plugins", Some(&p["input"])),
            "plugins/enable" | "plugins/disable" | "plugins/remove" => {
                let command = action.split('/').nth(1).unwrap();
                return b.api(
                    "POST",
                    &format!("/api/v1/plugins/{}:{command}", kimi::path(s(p, "id"))),
                    Some(&json!({})),
                );
            }
            "mcp" => return b.api("GET", "/api/v2/mcp/servers", None),
            "mcp/add" => return b.api("POST", "/api/v2/mcp/servers", Some(&p["input"])),
            "mcp/remove" => {
                return b.api(
                    "DELETE",
                    &format!("/api/v2/mcp/servers/{}{}", kimi::path(s(p, "name")), ""),
                    None,
                )
            }
            "mcp/test" => return b.api("POST", "/api/v2/mcp/servers:test", Some(&p["input"])),
            "mcp/auth" => return b.api("POST", "/api/v2/mcp/auth:begin", Some(&p["input"])),
            "mcp/auth/complete" | "mcp/auth/cancel" | "mcp/auth/reset" => {
                return b.api(
                    "POST",
                    &format!("/api/v2/mcp/auth:{}", action.rsplit('/').next().unwrap()),
                    Some(&p["input"]),
                )
            }
            "mcp/update" => {
                return b.api(
                    "PUT",
                    &format!("/api/v2/mcp/servers/{}", kimi::path(s(p, "name"))),
                    Some(&p["input"]),
                )
            }
            "mcp/reconnect" => {
                return b.api(
                    "POST",
                    &format!("/api/v1/mcp/servers/{}:restart", kimi::path(s(p, "name"))),
                    Some(&json!({})),
                )
            }
            "hooks/update" => {
                return b.api(
                    "PATCH",
                    "/api/v1/config",
                    Some(&json!({"hooks":p["hooks"]})),
                )
            }
            "sessions/restore" => {
                return b.session(s(p, "sessionId"), ":restore", Some(&json!({})))
            }
            "hooks" => {
                let config = b.api("GET", "/api/v1/config", None)?;
                return Ok(json!({"hooks":config["hooks"]}));
            }
            "configure" => return self.kimi_configure(p),
            "sessions" => {
                let list = b.api(
                    "GET",
                    "/api/v1/sessions?page_size=100&exclude_empty=true",
                    None,
                )?;
                for entry in arr(&list["items"]) {
                    let id = s(entry, "id");
                    let _ = self.history.register_kimi(
                        id,
                        entry["metadata"]["cwd"].as_str().unwrap_or(""),
                        s(entry, "title"),
                    );
                }
                return Ok(list);
            }
            _ => {}
        }
        let t = if let Some(t) = self.find(s(p, "threadId")) {
            t
        } else if !s(p, "sessionId").is_empty() {
            let t = self.thread(s(p, "threadId"), "kimi")?;
            *t.session.lock().unwrap() = s(p, "sessionId").into();
            {
                let mut cfg = t.config.lock().unwrap();
                for key in ["cwd", "model", "effort", "permissionMode", "role"] {
                    if let Some(value) = p["config"].get(key) {
                        if !value.is_null() {
                            cfg[key] = value.clone();
                        }
                    }
                }
            }
            t
        } else {
            return Err("Send the first message to initialize the Kimi session".into());
        };
        if *t.provider.lock().unwrap() != "kimi" {
            return Err("This chat is not using Kimi".into());
        }
        let sid = t.session.lock().unwrap().clone();
        if sid.is_empty() {
            return Err("Send the first message to initialize the Kimi session".into());
        }
        if matches!(
            action,
            "compact"
                | "skills/activate"
                | "btw"
                | "swarm"
                | "tower"
                | "goal/set"
                | "goal/pause"
                | "goal/resume"
                | "goal/cancel"
                | "native/message"
                | "native/stop"
        ) {
            self.kimi_import(&sid)?;
            let run = self.start(&t);
            self.ensure(&run)?;
        }
        match action {
            "state" => b.session(&sid, "/snapshot", None),
            "tower" => {
                if roles_agent::read_only(&t.config.lock().unwrap()) {
                    return Err("Tower mode requires an executor role".into());
                }
                b.session(&sid,"/profile",Some(&json!({"agent_config":{"tower_mode":p["enabled"]==true,"tower_base":p["base"].as_str().unwrap_or("main")}})))
            }
            "goal" => b.session(&sid, "/goal", None),
            "goal/set" => {
                if !s(p, "objective").is_empty() {
                    b.session(
                        &sid,
                        "/profile",
                        Some(&json!({"agent_config":{"goal_objective":p["objective"]}})),
                    )
                } else {
                    Err("Goal objective is required".into())
                }
            }
            "goal/pause" | "goal/resume" | "goal/cancel" => b.session(
                &sid,
                "/profile",
                Some(&json!({"agent_config":{"goal_control":action.split('/').nth(1)}})),
            ),
            "swarm" => b.session(
                &sid,
                "/profile",
                Some(&json!({"agent_config":{"swarm_mode":p["enabled"]==true}})),
            ),
            "compact" => {
                let run = self.active(&t.id)?;
                if run.running.load(Ordering::Acquire) {
                    return Err("Wait for the current turn before compacting".into());
                }
                self.dispatch_control(&t, "kimi")?;
                run.running.store(true, Ordering::Release);
                run.manual_compact.store(true, Ordering::Release);
                let result = b.session(
                    &sid,
                    ":compact",
                    Some(
                        &p.get("instruction")
                            .map(|v| json!({"instruction":v}))
                            .unwrap_or(json!({})),
                    ),
                );
                if result.is_err() {
                    run.running.store(false, Ordering::Release);
                    run.manual_compact.store(false, Ordering::Release);
                    self.dispatch_finish(&t);
                }
                if result.is_ok() {
                    let owner = self.clone();
                    let run = run.clone();
                    let sid = sid.clone();
                    let backend = b.clone();
                    self.emit_event(&run, json!({"type":"status","activity":"compacting"}));
                    self.spawn(move |_|{let started=Instant::now();loop{if !Self::current(&run)||!run.manual_compact.load(Ordering::Acquire){return}std::thread::sleep(Duration::from_millis(400));match backend.debug(Some(&sid),Some("main"),"agentFullCompactionService","compacting",json!([])){Ok(v)if !v.is_null()&&started.elapsed()<Duration::from_secs(1800)=>continue,Ok(v)=>{run.manual_compact.store(false,Ordering::Release);self::Agents::emit_event(&owner,&run,json!({"type":"notice","text":if v.is_null(){"Kimi context operation finished"}else{"Kimi compaction exceeded the wait limit"},"tone":"info","at":"open"}));owner.emit_event(&run,json!({"type":"turn.end","text":"","isError":!v.is_null()}));return;},Err(error)=>{run.manual_compact.store(false,Ordering::Release);owner.failed(&run,error);return;}}}})?;
                }
                result
            }
            "btw" => {
                let run = self.active(&t.id)?;
                if run.running.load(Ordering::Acquire) { /* A side conversation has an independent provider turn. */
                }
                let child = b.session(&sid, ":btw", Some(&json!({})))?;
                if !s(p, "text").is_empty() {
                    b.session(&sid,"/prompts",Some(&json!({"agent_id":child["agent_id"],"content":[{"type":"text","text":p["text"]}]})))?;
                }
                Ok(child)
            }
            "skills" => b.session(&sid, "/skills", None),
            "skills/activate" => {
                let run = self.active(&t.id)?;
                if run.running.load(Ordering::Acquire) {
                    return Err("Wait for the current turn before activating a skill".into());
                }
                self.dispatch_control(&t, "kimi")?;
                run.running.store(true, Ordering::Release);
                let result = b.session(
                    &sid,
                    &format!("/skills/{}:activate", kimi::path(s(p, "name"))),
                    Some(&json!({"args":p["args"].as_str().unwrap_or("")})),
                );
                if result.is_err() {
                    run.running.store(false, Ordering::Release);
                    self.dispatch_finish(&t);
                }
                result
            }
            "tools" => b.api(
                "GET",
                &format!("/api/v1/tools?session_id={}", kimi::path(&sid)),
                None,
            ),
            "task/details" => b.session(
                &sid,
                &format!("/tasks/{}", kimi::path(s(p, "taskId"))),
                None,
            ),
            "tasks" => b.session(&sid, "/tasks", None),
            "task/stop" => b.session(
                &sid,
                &format!("/tasks/{}:stop", kimi::path(s(p, "taskId"))),
                Some(&json!({})),
            ),
            "file-history" => {
                let turn = p["turn"]
                    .as_u64()
                    .unwrap_or(self.active(&t.id)?.kimi.lock().unwrap().last_turn);
                b.session(&sid, &format!("/file-history/changes?turn_id={turn}"), None)
            }
            "file/diff" => {
                let turn = p["turn"]
                    .as_u64()
                    .unwrap_or(self.active(&t.id)?.kimi.lock().unwrap().last_turn);
                let suffix = format!(
                    "/file-history/content?turn_id={turn}&path={}",
                    kimi::path(s(p, "path"))
                );
                let before = b.session(&sid, &format!("{suffix}&phase=start"), None)?;
                let after = b.session(&sid, &format!("{suffix}&phase=end"), None)?;
                Ok(json!({"path":p["path"],"turn":turn,"before":before,"after":after}))
            }
            "transcript" => {
                let agent = p["agentId"].as_str().unwrap_or("main");
                b.session(
                    &sid,
                    &format!(
                        "/transcript?agent_id={}&page_size=20{}",
                        kimi::path(agent),
                        p["beforeTurn"]
                            .as_str()
                            .map(|v| format!("&before_turn={}", kimi::path(v)))
                            .unwrap_or_default()
                    ),
                    None,
                )
            }
            "agents" => b.debug(
                Some(&sid),
                None,
                "sessionAgentProfileCatalog",
                "list",
                json!([]),
            ),
            "reload" => b.session(&sid, ":reload", Some(&json!({}))),
            "native/message" => {
                let agent = s(p, "agentId");
                if !self
                    .active(&t.id)?
                    .kimi
                    .lock()
                    .unwrap()
                    .agents
                    .contains(agent)
                {
                    return Err("Unknown Kimi subagent".into());
                }
                b.session(&sid,"/prompts",Some(&json!({"agent_id":agent,"content":[{"type":"text","text":p["text"]}],"metadata":{"duet_user_message":true}})))
            }
            "native/stop" => {
                let agent = s(p, "agentId");
                if !self
                    .active(&t.id)?
                    .kimi
                    .lock()
                    .unwrap()
                    .agents
                    .contains(agent)
                {
                    return Err("Unknown Kimi subagent".into());
                }
                b.debug(
                    Some(&sid),
                    Some(agent),
                    "agentLoopService",
                    "cancel",
                    json!([]),
                )
            }
            _ => Err("Unknown Kimi action".into()),
        }
    }
    pub(in crate::core) fn kimi_configure(self: &Arc<Self>, p: &Value) -> CoreResult {
        let t = self
            .find(s(p, "threadId"))
            .ok_or("Chat is not initialized")?;
        if roles_agent::read_only(&t.config.lock().unwrap())
            && p["permissionMode"]
                .as_str()
                .is_some_and(|mode| mode != "plan")
        {
            return Err("Change the agent role before enabling writes".into());
        }
        let b = self.kimi_backend()?;
        let mut update = json!({});
        if let Some(model) = p["model"].as_str() {
            update["model"] = json!(b.model(model)?);
        }
        if let Some(effort) = p["effort"].as_str() {
            let model = b.model(
                p["model"]
                    .as_str()
                    .unwrap_or(s(&t.config.lock().unwrap(), "model")),
            )?;
            if let Some(effort) = b.thinking(&model, effort)? {
                update["thinking"] = json!(effort);
            }
        }
        if p["permissionMode"].is_string() {
            let mut cfg = t.config.lock().unwrap().clone();
            cfg["permissionMode"] = p["permissionMode"].clone();
            update["permission_mode"] = json!(kimi_permission(&cfg));
            update["plan_mode"] = json!(cfg["permissionMode"] == "plan");
        }
        let sid = t.session.lock().unwrap().clone();
        if !sid.is_empty() {
            b.session(&sid, "/profile", Some(&json!({"agent_config":update})))?;
        }
        {
            let mut cfg = t.config.lock().unwrap();
            for key in ["model", "effort", "permissionMode"] {
                if let Some(value) = p.get(key) {
                    cfg[key] = value.clone();
                }
            }
        }
        Ok(json!(true))
    }
}
