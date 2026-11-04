//! Kimi Code integration: one owned server, independent session routes and native MCP capabilities.
use super::*;
use crate::core::{
    kimi::{self, Backend, MANAGED},
    kimi_events::Translator,
};
impl Agents {
    pub(super) fn kimi_backend(self: &Arc<Self>) -> Result<Arc<Backend>, String> {
        let mut slot = self.kimi_backend.lock().unwrap();
        if let Some(b) = slot.as_ref().filter(|b| b.alive()) {
            return Ok(b.clone());
        }
        let weak = Arc::downgrade(self);
        let exit = weak.clone();
        let backend = Backend::start(
            &self.storage,
            Arc::new(move |event| {
                if let Some(owner) = weak.upgrade() {
                    owner.kimi_wire(event)
                }
            }),
            Arc::new(move |error| {
                if let Some(owner) = exit.upgrade() {
                    let runs: Vec<_> = owner
                        .kimi_routes
                        .lock()
                        .unwrap()
                        .values()
                        .filter_map(Weak::upgrade)
                        .collect();
                    for run in runs {
                        owner.failed(&run, error.clone());
                    }
                }
            }),
        )?;
        *slot = Some(backend.clone());
        Ok(backend)
    }
    pub(super) fn kimi_ensure(self: &Arc<Self>, run: &Arc<Run>) -> Result<Arc<Client>, String> {
        let t = run.thread.upgrade().ok_or("Chat closed")?;
        let cfg = t.config.lock().unwrap().clone();
        let backend = self.kimi_backend()?;
        let model = backend.model(s(&cfg, "model"))?;
        let cwd = cfg["cwd"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| self.storage.home.to_string_lossy().into_owned());
        let mcp = if cfg["contextCompressor"] == true {
            json!({})
        } else {
            json!({"duet":{"transport":"http","url":self.kimi_mcp_url(run)?,"toolTimeoutMs":3600000}})
        };
        let previous = t.session.lock().unwrap().clone();
        let sid = if previous.is_empty() {
            let created=backend.debug(None,None,"sessionManager","create",json!({"workDir":cwd,"additionalDirs":arr(&cfg["dirs"]),"ensureMainAgent":true,"mcpServers":mcp}))?;
            s(&created, "id").to_owned()
        } else {
            backend.debug(
                None,
                None,
                "sessionManager",
                "resume",
                json!([previous,{"mcpServers":mcp}]),
            )?;
            previous
        };
        if !sid.starts_with("session_") {
            return Err("Kimi returned an invalid session id".into());
        }
        self.history.register_kimi(&sid, &cwd, "Kimi chat")?;
        let _ = self
            .history
            .journal_patch("kimi", &sid, &json!({"imported":true}));
        backend.session(&sid,"/profile",Some(&json!({"agent_config":{"model":model,"permission_mode":kimi_permission(&cfg),"plan_mode":cfg["permissionMode"]=="plan"}})))?;
        let profile = backend.debug(
            Some(&sid),
            Some("main"),
            "agentProfileService",
            "data",
            json!([]),
        )?;
        let mut instructions = s(&profile, "systemPrompt").to_owned();
        if let Some(start) = instructions.find("<duet_instructions>") {
            if let Some(end) = instructions[start..].find("</duet_instructions>") {
                instructions.replace_range(start..start + end + "</duet_instructions>".len(), "");
            }
        }
        instructions.push_str("\n\n<duet_instructions>");
        if let Some(extra) = cfg["instructions"].as_str() {
            instructions.push_str("\n\n");
            instructions.push_str(extra);
        }
        instructions.push_str(&format!("\n\nDuet session run_id: {}. MCP tools named desk-agents__* communicate with Duet teammates; desk-context__* manage this chat's selective context. Use independent tasks and event cursors.",t.id));
        instructions.push_str("\n</duet_instructions>");
        backend.debug(
            Some(&sid),
            Some("main"),
            "agentProfileService",
            "update",
            json!({"systemPrompt":instructions}),
        )?;
        if cfg["contextCompressor"] == true || roles_agent::read_only(&cfg) {
            let tools = backend.api(
                "GET",
                &format!("/api/v1/tools?session_id={}", kimi::path(&sid)),
                None,
            )?;
            let allowed = if cfg["contextCompressor"] == true {
                Vec::<Value>::new()
            } else {
                arr(&tools["tools"])
                    .iter()
                    .filter(|tool| {
                        matches!(
                            s(tool, "name"),
                            "Read"
                                | "Grep"
                                | "Glob"
                                | "WebFetch"
                                | "WebSearch"
                                | "Search"
                                | "AskUserQuestion"
                                | "ExitPlanMode"
                                | "TodoWrite"
                        ) || s(tool, "name").starts_with("mcp__duet__")
                            || !roles_agent::read_only(&cfg)
                    })
                    .map(|t| t["name"].clone())
                    .collect()
            };
            backend.debug(
                Some(&sid),
                Some("main"),
                "agentProfileService",
                "update",
                json!({"activeToolNames":allowed}),
            )?;
        }
        *t.session.lock().unwrap() = sid.clone();
        *run.kimi.lock().unwrap() = Translator::default();
        self.kimi_routes
            .lock()
            .unwrap()
            .insert(sid.clone(), Arc::downgrade(run));
        *run.client.lock().unwrap() = Some(backend.process.clone());
        self.emit_event(run, json!({"type":"session","sessionId":sid,"model":model}));
        backend.subscribe(&sid)?;
        Ok(backend.process.clone())
    }
    pub(super) fn kimi_send(
        self: &Arc<Self>,
        run: &Arc<Run>,
        msg: &Value,
        cfg: &Value,
        instructions: &Value,
    ) -> Result<(), String> {
        let t = run.thread.upgrade().ok_or("Chat closed")?;
        let sid = t.session.lock().unwrap().clone();
        let backend = self.kimi_backend()?;
        let model = backend.model(s(cfg, "model"))?;
        let mut content = Vec::new();
        if let Some(extra) = instructions.as_str().filter(|x| !x.is_empty()) {
            content.push(json!({"type":"text","text":format!("<system-reminder>\n{extra}\n</system-reminder>")}));
        }
        for image in arr(&msg["images"]) {
            content.push(json!({"type":if s(image,"mediaType").starts_with("video/"){"video"}else{"image"},"source":{"kind":"base64","media_type":image["mediaType"],"data":image["data"]}}));
        }
        if !s(msg, "text").is_empty() {
            content.push(json!({"type":"text","text":msg["text"]}));
        }
        if content.is_empty() {
            return Err("Message is empty".into());
        }
        let mut request = json!({"content":content,"model":model,"permission_mode":kimi_permission(cfg),"plan_mode":cfg["permissionMode"]=="plan","metadata":{"duet_message_id":msg["uuid"]}});
        if !s(msg, "uuid").is_empty() {
            request["prompt_id"] = msg["uuid"].clone();
        }
        if let Some(effort) = backend.thinking(&model, s(cfg, "effort"))? {
            request["thinking"] = json!(effort);
        }
        self.history.journal_append("kimi",&sid,&json!({"type":"user","uuid":msg["uuid"],"text":msg.get("_contextOriginalText").unwrap_or(&msg["text"]),"images":msg["images"],"timestamp":storage::now()}))?;
        let result = backend.session(&sid, "/prompts", Some(&request))?;
        if result["status"] == "queued" && msg["priority"] == "next" {
            backend.session(
                &sid,
                "/prompts::steer",
                Some(&json!({"prompt_ids":[result["prompt_id"]]})),
            )?;
        }

        Ok(())
    }
    fn kimi_wire(self: &Arc<Self>, frame: Value) {
        if matches!(s(&frame, "type"), "duet.reconnected" | "duet.disconnected") {
            let disconnected = frame["type"] == "duet.disconnected";
            (self.emit)(
                "desk:kimi-update",
                json!({"kind":if disconnected{"disconnected"}else{"reconnected"}}),
            );
            let runs: Vec<_> = self
                .kimi_routes
                .lock()
                .unwrap()
                .values()
                .filter_map(Weak::upgrade)
                .collect();
            for run in runs {
                if run.running.load(Ordering::Acquire) {
                    self.emit_event(&run,json!({"type":"status","activity":if disconnected{json!("retrying")}else{Value::Null},"attempt":1}));
                }
            }
            return;
        }
        let sid = s(&frame, "session_id");
        let run = self
            .kimi_routes
            .lock()
            .unwrap()
            .get(sid)
            .and_then(Weak::upgrade);
        if frame["type"]
            .as_str()
            .is_some_and(|t| t.starts_with("event.") || t == "session.meta.updated")
        {
            (self.emit)("desk:kimi-update", json!({"kind":frame["type"]}));
        }
        let Some(run) = run.filter(Self::current) else {
            return;
        };
        if frame["type"] == "interaction" {
            let id = s(&frame, "interaction_id").to_owned();
            if frame["status"] == "ended" {
                let source = format!("kimi:{id}");
                let mut approvals = self.approvals.lock().unwrap();
                let keys: Vec<_> = approvals
                    .iter()
                    .filter(|(_, a)| a.source == source)
                    .map(|(k, _)| k.clone())
                    .collect();
                for key in keys {
                    if let Some(a) = approvals.remove(&key) {
                        let _ = a
                            .tx
                            .send(json!({"decision":"deny","message":"Kimi interaction ended"}));
                    }
                }
                return;
            }
            if frame["status"] != "pending" {
                return;
            }
            if !run
                .requests
                .lock()
                .unwrap()
                .contains_key(&format!("kimi:{id}"))
            {
                let request = collaboration::Request::new(&run, vec![format!("kimi:{id}")]);
                let owner = self.clone();
                let _ = self.spawn(move |_| owner.kimi_interaction(&run, &frame, request));
            }
            return;
        }
        let events = run.kimi.lock().unwrap().feed(&frame);
        for event in events {
            if event["type"] == "turn.end" && event["agent"].is_null() {
                let turn = arr(&frame["payload"]["ops"])
                    .iter()
                    .rev()
                    .find(|op| op["op"] == "turn.upsert")
                    .map(|op| op["turn"].clone())
                    .unwrap_or(Value::Null);
                if let Some(t) = run.thread.upgrade() {
                    let model = t.config.lock().unwrap()["model"]
                        .as_str()
                        .unwrap_or("kimi-code")
                        .to_owned();
                    let u = &turn["usage"];
                    let _=self.record_turn(&run,&json!({"session_id":sid,"duration_ms":turn["durationMs"],"num_turns":1,"is_error":event["isError"],"total_cost_usd":u["cost"],"modelUsage":{model:{"inputTokens":u["inputTokens"],"outputTokens":u["outputTokens"],"cacheReadInputTokens":u["cachedTokens"],"costUSD":u["cost"]}}}));
                }
            }
            self.emit_event(&run, event);
        }
        if frame["type"] == "agent" && frame["agent_id"] == "main" {
            self.emit_event(&run,json!({"type":"kimi.state","state":{"settings":{"model":frame["model"],"thinking":frame["thinking"],"permission_mode":frame["permission_mode"],"plan_mode":frame["plan_mode"],"swarm_mode":frame["swarm_mode"],"tower_mode":frame["tower_mode"]}}}));
        }
        if frame["type"] == "goal" {
            self.emit_event(
                &run,
                json!({"type":"kimi.state","state":{"goal":frame["goal"]}}),
            );
        }
        if frame["type"] == "usage" && frame["agent_id"] == "main" {
            if let Some(t) = run.thread.upgrade() {
                if t.config.lock().unwrap()["contextCompressor"] == true {
                    t.config.lock().unwrap()["_contextUsage"] =
                        json!({"input":frame["context_tokens"]});
                }
            }
        }
    }
    fn kimi_interaction(
        self: &Arc<Self>,
        run: &Arc<Run>,
        frame: &Value,
        request_guard: collaboration::Request,
    ) {
        let Some(t) = run.thread.upgrade() else {
            return;
        };
        let id = s(frame, "interaction_id");
        let source = format!("kimi:{id}");
        let cancelled = &request_guard.cancelled;
        let question = frame["kind"] == "question";
        let request = &frame["request"];
        let mut input = request["tool_input_display"].clone();
        let tool = if question {
            "AskUserQuestion"
        } else if request["tool_input_display"]["kind"] == "plan_review" {
            "ExitPlanMode"
        } else {
            s(request, "tool_name")
        };
        if question {
            input = json!({"questions":arr(&request["questions"]).iter().map(|q|json!({"id":q["id"],"question":q["question"],"header":q["header"],"multiSelect":q["multi_select"],"allowOther":q["allow_other"],"options":q["options"]})).collect::<Vec<_>>()});
        }
        if tool == "ExitPlanMode" {
            input["plan"] = request["tool_input_display"]["plan"].clone();
            input["_kimiOptions"] = request["tool_input_display"]["options"].clone();
        }
        if tool == "Bash" {
            input["command"] = request["tool_input_display"]
                .get("command")
                .or(request.get("action"))
                .cloned()
                .unwrap_or(Value::Null);
        }
        let response=self.ask(run,source.clone(),json!({"reqId":uuid::Uuid::new_v4().to_string(),"toolName":tool,"toolUseID":s(frame,"tool_call_id"),"input":input,"description":request["action"]}));
        if !cancelled.load(Ordering::Acquire) && Self::current(run) {
            let allow = matches!(s(&response, "decision"), "allow" | "always");
            let mut answer = json!({"kind":if question{"question"}else{"approval"}});
            if question {
                if allow {
                    let mut answers = json!({});
                    for q in arr(&request["questions"]) {
                        let values = arr(&response["updatedInput"]["answerValues"][s(q, "id")]);
                        let other = response["updatedInput"]["answers"][s(q, "question")]
                            .as_str()
                            .unwrap_or("");
                        let mut options = Vec::new();
                        let mut extras = Vec::new();
                        for v in values {
                            if let Some(option) =
                                arr(&q["options"]).iter().find(|o| o["label"] == *v)
                            {
                                options.push(option["id"].clone());
                            } else if let Some(v) = v.as_str() {
                                extras.push(v.to_owned())
                            }
                        }
                        let value = if values.is_empty() {
                            json!({"kind":"other","text":other})
                        } else if !extras.is_empty() && !options.is_empty() {
                            json!({"kind":"multi_with_other","option_ids":options,"other_text":extras.join("\n")})
                        } else if !extras.is_empty() {
                            json!({"kind":"other","text":extras.join("\n")})
                        } else if q["multi_select"] == true {
                            json!({"kind":"multi","option_ids":options})
                        } else {
                            json!({"kind":"single","option_id":options.first()})
                        };
                        answers[s(q, "id")] = value;
                    }
                    answer["answers"] = answers;
                } else {
                    answer["dismissed"] = json!(true)
                }
            } else {
                answer["decision"] = json!(if allow { "approved" } else { "rejected" });
                if response["decision"] == "always" {
                    answer["scope"] = json!("session");
                }
                if let Some(feedback) = response["message"].as_str() {
                    answer["feedback"] = json!(feedback);
                }
                if let Some(label) = response["updatedInput"]["selected_label"].as_str() {
                    answer["selected_label"] = json!(label);
                }
            }
            if let Ok(backend) = self.kimi_backend() {
                let sid = t.session.lock().unwrap().clone();
                let _ = backend.session(
                    &sid,
                    &format!("/interactions/{}:respond", kimi::path(id)),
                    Some(&answer),
                );
            }
        }
        drop(request_guard);
    }
    pub(super) fn kimi_probe(self: &Arc<Self>) -> CoreResult {
        let b = self.kimi_backend()?;
        let _ = self.kimi_action(&json!({"action":"sessions"}));
        let auth = b.api("GET", "/api/v1/auth", None)?;
        let catalog = b.models().unwrap_or(json!([]));
        let logged = auth["managed_provider"]["status"] == "authenticated";
        let models=arr(&catalog).iter().map(|m|json!({"value":m["model"],"displayName":m.get("display_name").unwrap_or(&m["model"]),"description":"Kimi Code subscription","supportedEffortLevels":m["support_efforts"],"contextWindow":m["max_context_size"]})).collect::<Vec<_>>();
        let meta = b.api("GET", "/api/v1/meta", None)?;
        Ok(
            json!({"available":true,"loggedIn":logged,"version":meta["server_version"],"account":{"subscriptionType":"Kimi Code"},"models":models,"commands":[{"name":"status","description":"Kimi controls"},{"name":"compact","description":"Compact Kimi context"},{"name":"model","description":"Model and thinking"},{"name":"permissions","description":"Permissions and plan"},{"name":"mcp","description":"MCP servers"},{"name":"skills","description":"Skills"},{"name":"goal","description":"Goal"},{"name":"swarm","description":"Swarm mode"},{"name":"btw","description":"Read-only side conversation"},{"name":"tasks","description":"Background tasks"},{"name":"plugins","description":"Plugins"},{"name":"login","description":"Subscription login"},{"name":"help","description":"Kimi help"}],"usage":if logged{self.kimi_usage().unwrap_or(Value::Null)}else{Value::Null}}),
        )
    }
    pub(super) fn kimi_usage(self: &Arc<Self>) -> CoreResult {
        let b = self.kimi_backend()?;
        let value = b.api("GET", "/api/v1/oauth/usage", None)?;
        if value["kind"] != "ok" {
            return Err(s(&value, "message").into());
        }
        let q = &value["quota"];
        let usage = &q["usages"];
        let win = |v: &Value, label: &str| json!({"pct":v["usedRatio"].as_f64().unwrap_or(0.)*100.,"resetsAt":events::timestamp(&v["resetAt"]),"label":label});
        let info = b
            .api("GET", "/api/v1/oauth/userinfo", None)
            .unwrap_or(Value::Null);
        Ok(
            json!({"plan":"Kimi Code","email":info.get("email"),"session":win(&usage["limit5h"],"5 h"),"weekly":win(&usage["monthTotal"],"Month"),"groups":[{"name":"Kimi Code monthly","weekly":win(&usage["monthCode"],"Month")}],"extraUsage":q["extraUsage"]}),
        )
    }
    pub(in crate::core) fn kimi_import(self: &Arc<Self>, sid: &str) -> Result<(), String> {
        if self
            .history
            .journal_meta("kimi", sid)
            .is_ok_and(|v| v["imported"] == true)
        {
            return Ok(());
        }
        let b = self.kimi_backend()?;
        let meta = b.session(sid, "", None)?;
        let cwd = meta["metadata"]["cwd"].as_str().unwrap_or("");
        self.history.register_kimi(sid, cwd, s(&meta, "title"))?;
        let mut messages = Vec::new();
        let mut before = String::new();
        let mut bytes = 0usize;
        for _ in 0..1000 {
            let suffix = format!(
                "/messages?page_size=100{}",
                if before.is_empty() {
                    String::new()
                } else {
                    format!("&before_id={}", kimi::path(&before))
                }
            );
            let page = b.session(sid, &suffix, None)?;
            let items = arr(&page["items"]);
            if items.is_empty() {
                break;
            }
            bytes += serde_json::to_vec(items).map_err(|e| e.to_string())?.len();
            if bytes > 32 * 1024 * 1024 || messages.len() + items.len() > 10000 {
                return Err("Kimi session import exceeds 32 MiB or 10000 messages; use the paged transcript view".into());
            }
            messages.extend_from_slice(items);
            let next = s(items.last().unwrap(), "id").to_owned();
            if page["has_more"] != true || next == before {
                break;
            }
            before = next;
        }
        let mut imported = vec![json!({"type":"session","sessionId":sid})];
        for message in messages.iter().rev() {
            let role = s(message, "role");
            let id = s(message, "id");
            let content = arr(&message["content"]);
            if role == "user" {
                let text = content
                    .iter()
                    .filter(|c| c["type"] == "text")
                    .map(|c| s(c, "text"))
                    .collect::<Vec<_>>()
                    .join("\n");
                imported.push(json!({"type":"user","uuid":id,"text":text,"timestamp":events::timestamp(&message["created_at"])}));
            }
            for (index, part) in content.iter().enumerate() {
                let ev = match s(part, "type") {
                    "text" if role == "assistant" => {
                        json!({"type":"text","id":format!("{id}:{index}"),"text":part["text"],"mode":"final"})
                    }
                    "thinking" => {
                        json!({"type":"thinking","id":format!("{id}:{index}"),"text":part["thinking"],"mode":"final"})
                    }
                    "tool_use" => {
                        json!({"type":"tool","id":part["tool_call_id"],"name":part["tool_name"],"input":part["input"],"final":true})
                    }
                    "tool_result" => {
                        json!({"type":"tool.result","id":part["tool_call_id"],"status":if part["is_error"]==true{"error"}else{"done"},"result":events::result_text(&part["output"])})
                    }
                    _ => continue,
                };
                imported.push(ev);
            }
        }
        let mut journal = Vec::new();
        for event in imported {
            serde_json::to_writer(&mut journal, &event).map_err(|e| e.to_string())?;
            journal.push(b'\n');
        }
        storage::atomic_write(
            &self.storage.data.join("kimi").join(format!("{sid}.jsonl")),
            &journal,
        )?;
        self.history
            .journal_patch("kimi", sid, &json!({"imported":true}))?;
        Ok(())
    }
}
fn kimi_permission(cfg: &Value) -> &'static str {
    if cfg["contextCompressor"] == true || roles_agent::read_only(cfg) {
        return "manual";
    }
    match s(cfg, "permissionMode") {
        "bypassPermissions" => "yolo",
        "auto" => "auto",
        _ => "manual",
    }
}

#[path = "kimi_control.rs"]
mod kimi_control;
