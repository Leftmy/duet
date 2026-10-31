use super::events::{self, arr, s, HistoryState};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
#[derive(Default)]
pub struct Claude {
    message: String,
    stream: HashMap<u64, (String, String)>,
    pending: Vec<(String, String)>,
}
impl Claude {
    pub fn push(&mut self, msg: &Value, state: &HistoryState) -> Result<Vec<Value>, String> {
        let mut out = vec![];
        let kind = s(msg, "type");
        match kind{
 "stream_event" if msg["parent_tool_use_id"].is_null()=>{let e=&msg["event"];let index=e["index"].as_u64().unwrap_or(0);match s(e,"type"){
 "message_start"=>{self.message=s(&e["message"],"id").into();self.stream.clear();out.push(json!({"type":"step"}));},
 "content_block_start"=>{let b=&e["content_block"];let k=s(b,"type");if k=="text"||k=="thinking"{let id=format!("{}:{index}",self.message);self.stream.insert(index,(id.clone(),k.into()));self.pending.push((id.clone(),k.into()));out.push(json!({"type":k,"id":id,"text":b.get(if k=="text"{"text"}else{"thinking"}).and_then(Value::as_str).unwrap_or(""),"mode":"delta"}));}else if k=="tool_use"{self.stream.insert(index,(s(b,"id").into(),k.into()));out.push(json!({"type":"tool","id":b["id"],"name":b["name"],"input":{}}));if matches!(s(b,"name"),"Agent"|"Task"){state.set("agent",s(b,"id"),&json!({"running":true,"background":true}))?;out.push(json!({"type":"agent","id":b["id"]}));}}},
 "content_block_delta"=>{if let Some((id,_))=self.stream.get(&index){let d=&e["delta"];match s(d,"type"){"text_delta"=>out.push(json!({"type":"text","id":id,"text":d["text"],"mode":"delta"})),"thinking_delta"=>out.push(json!({"type":"thinking","id":id,"text":d["thinking"],"mode":"delta"})),"input_json_delta"=>out.push(json!({"type":"tool.delta","id":id,"json":d["partial_json"]})),_=>{}}}},
 "content_block_stop"=>{if let Some((id,k))=self.stream.get(&index){if k=="thinking"{out.push(json!({"type":"thinking","id":id,"text":"","mode":"end"}))}}},_=>{}}},
 "assistant"|"user"=>{let parent=s(msg,"parent_tool_use_id");let agent=if parent.is_empty(){None}else{Some(state.agent_of(parent,"").unwrap_or(parent.into()))};
 let mut receipts=HashMap::new();if kind=="user"&&agent.is_none(){for b in arr(&msg["message"]["content"]){let id=s(b,"tool_use_id");let a=state.get("agent",id);let text=events::result_text(&b["content"]);if a["background"]==true&&b["is_error"]!=true&&["background","launched","async","agentid"].iter().any(|n|text.chars().take(400).collect::<String>().to_lowercase().contains(n)){receipts.insert(id.to_owned(),a);}}}
 out=events::claude_history(msg,state,agent.as_deref())?;
 out.retain(|e|s(e,"type")!="user"&&!(s(e,"type")=="agent"&&e["status"].is_string()&&receipts.contains_key(s(e,"id"))));for(id,mut value)in receipts{value["running"]=json!(true);state.set("agent",&id,&value)?;}
 if kind=="assistant"&&agent.is_none(){for e in &mut out{let k=s(e,"type");if (k=="text"||k=="thinking")&&e["mode"]=="final"{if let Some(i)=self.pending.iter().position(|(_,t)|t==k){e["id"]=json!(self.pending.remove(i).0);}}}}
 if kind=="assistant"{if !msg["error"].is_null(){let code=msg["error"].as_str().unwrap_or(s(&msg["error"],"type"));out.push(json!({"type":"notice","code":match code{"rate_limit"=>"reduce.errRateLimit","authentication_failed"=>"reduce.errAuth","billing_error"=>"reduce.errBilling","overloaded"=>"reduce.errOverloaded",_=>"reduce.errGeneric"},"params":{"code":code},"tone":"error","at":"open"}));}}},
 "result"=>{self.pending.clear();self.stream.clear();let error=msg["is_error"]==true;let mut ev=json!({"type":"turn.end","durationMs":msg["duration_ms"],"isError":error,"text":msg["result"].as_str().unwrap_or(""),"costUsd":msg["total_cost_usd"].as_f64().unwrap_or(0.)});if error{ev["error"]=json!(msg["result"].as_str().filter(|s|!s.is_empty()).map(str::to_owned).unwrap_or_else(||arr(&msg["errors"]).iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n")).chars().take(600).collect::<String>());}out.push(ev)},
 "system"=>{match s(msg,"subtype"){
 "init"=>out.push(json!({"type":"session","sessionId":msg["session_id"],"model":msg["model"]})),
 "status"=>out.push(json!({"type":"status","activity":if msg["status"]=="compacting"{json!("compacting")}else{Value::Null},"permissionMode":msg["permissionMode"]})),
 "api_retry"=>out.push(json!({"type":"status","activity":"retrying","attempt":msg["attempt"],"max":msg["max_retries"]})),
 "compact_boundary"=>{out.push(json!({"type":"notice","code":"reduce.compacted","tone":"info","at":"open"}));out.push(json!({"type":"status","activity":null}));},
 "task_started"=>{let tool=s(msg,"tool_use_id");let task=s(msg,"task_id");if !state.get("agent",tool).is_null(){state.set("native",task,&json!(tool))?;}let agent=state.agent_of(tool,task);if let Some(id)=&agent{let mut a=state.get("agent",id);if a["running"]==false{out.push(json!({"type":"agent","id":id,"status":"running"}));}a["running"]=json!(true);if msg["is_backgrounded"]==true{a["background"]=json!(true)}state.set("agent",id,&a)?;}out.push(json!({"type":"task","op":"start","id":task,"description":msg.get("description").or(msg.get("subagent_type")),"taskType":msg.get("task_type").or(msg.get("subagent_type")),"background":msg["is_backgrounded"]==true,"toolUseId":agent.as_deref().unwrap_or(tool)}));},
 "task_updated"=>{let p=&msg["patch"];let mut e=json!({"type":"task","op":"update","id":msg["task_id"]});for(from,to)in[("status","status"),("description","description"),("is_backgrounded","background"),("error","error"),("end_time","endedAt")]{if let Some(v)=p.get(from){e[to]=v.clone()}}out.push(e)},
 "task_progress"=>out.push(json!({"type":"task","op":"progress","id":msg["task_id"],"toolUses":msg["usage"]["tool_uses"],"lastTool":msg.get("summary").or(msg.get("last_tool_name"))})),
 "task_notification"=>{let a=state.agent_of(s(msg,"tool_use_id"),s(msg,"task_id"));if let Some(a)=&a{let mut v=state.get("agent",a);v["running"]=json!(false);state.set("agent",a,&v)?;}out.push(json!({"type":"task","op":"end","id":msg["task_id"],"status":msg["status"],"summary":msg["summary"],"outputFile":msg["output_file"],"toolUses":msg["usage"]["tool_uses"],"toolUseId":a.map(|v|json!(v)).unwrap_or(msg["tool_use_id"].clone())}));},
 "background_tasks_changed"=>out.push(json!({"type":"task","op":"background","tasks":arr(&msg["tasks"]).iter().filter(|v|v["ambient"]!=true).map(|v|json!({"id":v["task_id"],"description":v["description"],"taskType":v["task_type"]})).collect::<Vec<_>>()})),_=>{}}},
 "rate_limit_event"=>{let i=&msg["rate_limit_info"];let mut windows=i["unifiedWindows"].clone();if windows.is_null()&&!s(i,"rateLimitType").is_empty(){windows=json!({s(i,"rateLimitType"):i});}let mut e=json!({"type":"limits"});for(from,to)in[("five_hour","session"),("seven_day","weekly")]{let w=&windows[from];if let Some(u)=w["utilization"].as_f64(){e[to]=json!({"pct":(u*100.).clamp(0.,100.),"resetsAt":w["resetsAt"].as_i64().map(|n|n*1000)});}}if i["status"]=="rejected"{e["rejected"]=json!(true)}out.push(e)},_=>{}}
        Ok(out)
    }
}
pub fn tool_call(name: &str, p: &Value) -> Value {
    let mut input = if p.is_object() { p.clone() } else { json!({}) };
    let mut field = |to: &str, keys: &[&str]| {
        if let Some(v) = keys.iter().filter_map(|k| p.get(k)).find(|v| !v.is_null()) {
            input[to] = v.clone()
        }
    };
    let name = match name {
        "run_command" | "run_shell_command" => {
            field("command", &["CommandLine", "command"]);
            field("description", &["Description", "description"]);
            "Bash"
        }
        "view_file" | "read_file" | "read_many_files" => {
            field(
                "file_path",
                &["AbsolutePath", "TargetFile", "file_path", "path"],
            );
            "Read"
        }
        "list_dir" | "list_directory" => {
            field("path", &["DirectoryPath", "dir_path", "path"]);
            "LS"
        }
        "write_to_file" | "write_file" => {
            field("file_path", &["TargetFile", "file_path", "path"]);
            field("content", &["CodeContent", "content"]);
            "Write"
        }
        "replace_file_content" | "replace" => {
            field("file_path", &["TargetFile", "file_path", "path"]);
            field("old_string", &["TargetContent", "old_string"]);
            field("new_string", &["ReplacementContent", "new_string"]);
            "Edit"
        }
        "multi_replace_file_content" => {
            field("file_path", &["TargetFile"]);
            input["edits"]=json!(arr(&p["ReplacementChunks"]).iter().map(|c|json!({"old_string":c["TargetContent"],"new_string":c["ReplacementContent"]})).collect::<Vec<_>>());
            "MultiEdit"
        }
        "grep_search" | "search_file_content" => {
            field("pattern", &["Query", "SearchPattern", "pattern", "query"]);
            field("path", &["SearchPath", "dir_path", "path"]);
            "Grep"
        }
        "find_by_name" | "glob" => {
            field("pattern", &["Pattern", "pattern"]);
            field("path", &["SearchDirectory", "dir_path", "path"]);
            "Glob"
        }
        "search_web" | "google_web_search" => {
            field("query", &["query", "Query"]);
            "WebSearch"
        }
        "read_url_content" | "web_fetch" => {
            field("url", &["Url", "url", "prompt"]);
            "WebFetch"
        }
        _ => name,
    };
    json!({"name":name,"input":input})
}
pub struct Google {
    pub prefix: String,
    pub texts: BTreeMap<String, String>,
    tools: HashSet<String>,
    finished: HashSet<String>,
    agents: HashSet<String>,
    segment: u64,
    started: bool,
    error: Option<String>,
}
impl Google {
    pub fn new(prefix: String) -> Self {
        Self {
            prefix,
            texts: BTreeMap::new(),
            tools: HashSet::new(),
            finished: HashSet::new(),
            agents: HashSet::new(),
            segment: 0,
            started: false,
            error: None,
        }
    }
    pub fn push(&mut self, msg: &Value, provider: &str) -> Vec<Value> {
        let mut out = vec![];
        let agy = provider == "antigravity";
        let kind = msg["event"].as_str().or(msg["type"].as_str()).unwrap_or("");
        if kind == "step_update" {
            let b = &msg["step_update"];
            let id = format!("{}:{}", self.prefix, b["step_index"]);
            if b["step_type"] != "user_input" && !self.started {
                self.started = true;
                out.push(json!({"type":"step"}));
            }
            if b["step_type"] == "agent_response" {
                if let Some(delta) = b["text_delta"].as_str() {
                    self.texts.entry(id.clone()).or_default().push_str(delta);
                    out.push(json!({"type":"text","id":id,"text":delta,"mode":"delta"}));
                }
                if b["state"] == "DONE" {
                    if let Some(t) = self.texts.get(&id) {
                        out.push(json!({"type":"text","id":id,"text":t,"mode":"final"}))
                    }
                }
            }
            if b["step_type"] == "tool" {
                let info = &b["tool_info"];
                let name = info["name"]
                    .as_str()
                    .or(b["tool_name"].as_str())
                    .unwrap_or("");
                if !name.is_empty() {
                    if !self.tools.contains(&id) || b["state"] == "DONE" {
                        let mut e = tool_call(name, &info["parameters"]);
                        e["type"] = json!("tool");
                        e["id"] = json!(id);
                        e["final"] = json!(true);
                        out.push(e);
                    }
                    self.tools.insert(id.clone());
                    if b["state"] == "DONE" && self.finished.insert(id.clone()) {
                        out.push(json!({"type":"tool.result","id":id,"status":if info["error"].is_null(){"done"}else{"error"},"result":events::result_text(info["error"].get("message").unwrap_or(&info["output"]))}));
                    }
                }
            }
            for a in arr(&b["subagent_info"]["subagents"]) {
                let id = format!(
                    "{}:agent:{}",
                    self.prefix,
                    a.get("conversation_id").unwrap_or(&b["step_index"])
                );
                if self.agents.insert(id.clone()) {
                    out.push(json!({"type":"agent","id":id,"name":a.get("role").or(a.get("type_name")),"agentType":a["type_name"],"prompt":a["role"],"provider":provider}));
                }
            }
        } else if kind == "message" && msg["role"] == "assistant" {
            if !self.started {
                self.started = true;
                out.push(json!({"type":"step"}));
            }
            let id = format!("{}:text:{}", self.prefix, self.segment);
            let text = s(msg, "content");
            if msg["delta"] == true {
                self.texts.entry(id.clone()).or_default().push_str(text)
            } else {
                self.texts.insert(id.clone(), text.into());
            }
            out.push(json!({"type":"text","id":id,"text":text,"mode":if msg["delta"]==true{"delta"}else{"final"}}));
        } else if kind == "tool_use" {
            if !self.started {
                self.started = true;
                out.push(json!({"type":"step"}));
            }
            self.segment += 1;
            let raw = msg["tool_id"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or(self.segment.to_string());
            let id = format!("{}:{raw}", self.prefix);
            let name = s(msg, "tool_name");
            let p = &msg["parameters"];
            if name == "invoke_agent" {
                let aid = format!("{}:agent:{raw}", self.prefix);
                self.agents.insert(aid.clone());
                out.push(json!({"type":"agent","id":aid,"name":p.get("agent_name").or(p.get("name")),"agentType":p.get("agent_name").or(p.get("name")),"prompt":p.get("prompt").or(p.get("task")),"provider":provider}));
            }
            let mut e = tool_call(name, p);
            e["type"] = json!("tool");
            e["id"] = json!(id);
            e["final"] = json!(true);
            self.tools.insert(id);
            out.push(e);
        } else if kind == "tool_result" {
            let id = format!("{}:{}", self.prefix, s(msg, "tool_id"));
            if self.finished.insert(id.clone()) {
                let error = msg["status"] == "error" || !msg["error"].is_null();
                let result =
                    events::result_text(msg["error"].get("message").unwrap_or(&msg["output"]));
                out.push(json!({"type":"tool.result","id":id,"status":if error{"error"}else{"done"},"result":result}));
                let aid = format!("{}:agent:{}", self.prefix, s(msg, "tool_id"));
                if self.agents.contains(&aid) {
                    out.push(json!({"type":"agent","id":aid,"status":if error{"error"}else{"done"},"result":result}));
                }
            }
        } else if kind == "error" {
            let text = msg["message"]
                .as_str()
                .or(msg["error"]["message"].as_str())
                .unwrap_or("CLI error");
            if msg["severity"] != "warning" {
                self.error = Some(text.into())
            }
            out.push(json!({"type":"notice","tone":if msg["severity"]=="warning"{"warn"}else{"error"},"at":"feed","text":text}));
        } else if kind == "result" {
            let r = if agy { &msg["result"] } else { msg };
            let success = s(r, "status").eq_ignore_ascii_case("success");
            let text = r["response"]
                .as_str()
                .or(r["result"]["response"].as_str())
                .unwrap_or("");
            let error = r["error"]
                .as_str()
                .or(r["error"]["message"].as_str())
                .or(self.error.as_deref())
                .unwrap_or("CLI turn did not complete");
            let streamed = self.texts.values().cloned().collect::<Vec<_>>().join("");
            if streamed.is_empty() && !text.is_empty() {
                out.push(json!({"type":"text","id":format!("{}:answer",self.prefix),"text":text,"mode":"final"}));
            } else {
                for (id, text) in &self.texts {
                    out.push(json!({"type":"text","id":id,"text":text,"mode":"final"}));
                }
            }
            for id in self.tools.difference(&self.finished) {
                out.push(json!({"type":"tool.result","id":id,"status":"error","result":error}));
            }
            for id in &self.agents {
                out.push(
                    json!({"type":"agent","id":id,"status":if success{"done"}else{"stopped"}}),
                );
            }
            let mut end = json!({"type":"turn.end","isError":!success,"text":if text.is_empty(){streamed.as_str()}else{text}});
            if !success {
                end["error"] = json!(error)
            }
            out.push(end);
        }
        out
    }
}
