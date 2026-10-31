use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::OnceLock;

pub fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
pub fn arr(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn result_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(values) => values
            .iter()
            .filter_map(|v| match s(v, "type") {
                "text" => Some(s(v, "text").to_owned()),
                "image" => Some("[image]".into()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => serde_json::to_string_pretty(value).unwrap_or_default(),
    }
}
pub fn timestamp(value: &Value) -> Option<i64> {
    value
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
        .or(value.as_i64())
}
pub fn strip_ansi(text: &str) -> String {
    static ANSI: OnceLock<regex::Regex> = OnceLock::new();
    ANSI.get_or_init(|| regex::Regex::new("\\x1b\\[[0-9;?]*[ -/]*[@-~]").unwrap())
        .replace_all(text, "")
        .into_owned()
}
pub fn user_text(content: &Value) -> Option<Value> {
    const META: &[&str] = &[
        "<local-command",
        "Caveat:",
        "<system-reminder>",
        "<bash-input>",
        "<bash-stdout>",
        "<bash-stderr>",
    ];
    let mut text = String::new();
    let mut images = Vec::new();
    if let Some(raw) = content.as_str() {
        text = raw.to_owned();
    } else if let Some(blocks) = content.as_array() {
        for (index, block) in blocks.iter().enumerate() {
            match s(block,"type"){
        "text"=>{let value=s(block,"text");if blocks.len()>1&&META.iter().any(|p|value.trim_start().starts_with(p)){continue;}if !text.is_empty(){text.push('\n');}text.push_str(value);},
        "image" if s(&block["source"],"type")=="base64"=>images.push(json!({"id":format!("image-{index}"),"mediaType":block["source"]["media_type"],"data":block["source"]["data"]})),_=>{}}
        }
        if text.is_empty() && images.is_empty() {
            return None;
        }
    } else {
        return None;
    }
    let text = text.trim();
    if META.iter().any(|p| text.starts_with(p)) {
        return None;
    }
    let tagged = |tag: &str| -> Option<String> {
        let start = text.find(&format!("<{tag}>"))? + tag.len() + 2;
        let end = text[start..].find(&format!("</{tag}>"))? + start;
        Some(text[start..end].trim().to_owned())
    };
    if let Some(command) = tagged("command-name") {
        let command = if command.starts_with('/') {
            command
        } else {
            format!("/{command}")
        };
        return Some(
            json!({"text":format!("{}{}",command,tagged("command-args").filter(|s|!s.is_empty()).map(|a|format!(" {a}")).unwrap_or_default()),"images":images}),
        );
    }
    Some(json!({"text":text,"images":images}))
}
pub fn readable_user(text: &str) -> String {
    static REPLY: OnceLock<regex::Regex> = OnceLock::new();
    REPLY
        .get_or_init(|| {
            regex::Regex::new(
                "(?s)<send_user_message_question_reply>(.*?)</send_user_message_question_reply>",
            )
            .unwrap()
        })
        .replace_all(text, |caps: &regex::Captures| {
            serde_json::from_str::<Value>(&caps[1])
                .ok()
                .and_then(|v| {
                    v.as_array().map(|rows| {
                        rows.iter()
                            .map(|r| {
                                format!("{}\n{}", s(r, "question").trim(), s(r, "answer").trim())
                            })
                            .collect::<Vec<_>>()
                            .join("\n\n")
                    })
                })
                .unwrap_or(caps[0].to_owned())
        })
        .into_owned()
}
pub struct HistoryState<'a> {
    pub db: &'a Connection,
    pub source: &'a str,
}
impl HistoryState<'_> {
    pub fn get(&self, space: &str, key: &str) -> Value {
        self.db
            .query_row(
                "SELECT value FROM history_state WHERE source=?1 AND space=?2 AND key=?3",
                params![self.source, space, key],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null)
    }
    pub fn set(&self, space: &str, key: &str, value: &Value) -> Result<(), String> {
        if value.is_null() {
            self.db
                .execute(
                    "DELETE FROM history_state WHERE source=?1 AND space=?2 AND key=?3",
                    params![self.source, space, key],
                )
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        self.db.execute("INSERT INTO history_state(source,space,key,name,value)VALUES(?1,?2,?3,?4,?5)ON CONFLICT(source,space,key)DO UPDATE SET name=excluded.name,value=excluded.value",params![self.source,space,key,value["name"].as_str().unwrap_or(""),value.to_string()]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn named(&self, name: &str) -> Option<String> {
        self.db.query_row("SELECT key FROM history_state WHERE source=?1 AND space='agent' AND(name=?2 OR key=?2) LIMIT 1",params![self.source,name],|r|r.get(0)).optional().ok().flatten()
    }
    pub fn agent_of(&self, tool: &str, task: &str) -> Option<String> {
        if !self.get("agent", tool).is_null() {
            Some(tool.to_owned())
        } else {
            self.get("send", tool)
                .as_str()
                .map(str::to_owned)
                .or_else(|| self.get("native", task).as_str().map(str::to_owned))
        }
    }
}
fn tool_results(content: &Value, agent: Option<&str>) -> Vec<Value> {
    arr(content).iter().filter(|b|s(b,"type")=="tool_result").map(|block|{let images=arr(&block["content"]).iter().filter(|c|s(c,"type")=="image"&&s(&c["source"],"type")=="base64").map(|c|json!({"mediaType":c["source"]["media_type"],"data":c["source"]["data"]})).collect::<Vec<_>>();let mut ev=json!({"type":"tool.result","id":block["tool_use_id"],"status":if block["is_error"]==true{"error"}else{"done"},"result":result_text(&block["content"])});if !images.is_empty(){ev["images"]=json!(images);}if let Some(agent)=agent{ev["agent"]=json!(agent);}ev}).collect()
}
fn assistant(content: &Value, uuid: &str, agent: Option<&str>) -> Vec<Value> {
    arr(content).iter().enumerate().filter_map(|(index,block)|{let id=format!("{uuid}:{index}");let mut ev=match s(block,"type"){
    "text" if !s(block,"text").trim().is_empty()=>json!({"type":"text","id":id,"text":block["text"],"mode":"final"}),
    "thinking"=>json!({"type":"thinking","id":id,"text":block.get("thinking").cloned().unwrap_or(json!("")),"mode":"final"}),
    "tool_use" if agent.is_none()||s(block,"name")!="SubagentHandback"=>json!({"type":"tool","id":block["id"],"name":block["name"],"input":block.get("input").cloned().unwrap_or(json!({})),"final":true}),_=>return None};if let Some(agent)=agent{ev["agent"]=json!(agent);}Some(ev)}).collect()
}
fn agent_input(input: &Value) -> Value {
    let mut result = json!({});
    let name = s(input, "name");
    let name = if name.is_empty() {
        s(input, "description")
    } else {
        name
    };
    if !name.is_empty() {
        result["name"] = json!(name);
    }
    for (from, to) in [
        ("subagent_type", "agentType"),
        ("model", "model"),
        ("prompt", "prompt"),
    ] {
        if let Some(value) = input
            .get(from)
            .filter(|v| !v.is_null() && v.as_str() != Some(""))
        {
            result[to] = value.clone();
        }
    }
    if let Some(background) = input.get("run_in_background").filter(|v| !v.is_null()) {
        result["background"] = json!(background != false);
    }
    result
}
pub fn claude_history(
    record: &Value,
    state: &HistoryState,
    subagent: Option<&str>,
) -> Result<Vec<Value>, String> {
    let uuid = record["uuid"].as_str().unwrap_or("record");
    let content = &record["message"]["content"];
    let mut out = Vec::new();
    if let Some(agent) = subagent {
        if s(record, "type") == "assistant" {
            out.extend(assistant(content, uuid, Some(agent)));
            for block in arr(content) {
                if s(block, "name") == "SubagentHandback" {
                    let text = block["input"]
                        .get("message")
                        .or(block["input"].get("report"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    out.push(json!({"type":"agent","id":agent,"result":text}));
                    out.push(json!({"type":"agent.msg","agent":agent,"id":format!("{agent}:report"),"dir":"from","text":text,"label":"report"}));
                }
            }
            if let Some(first) = arr(content).iter().find(|b| s(b, "type") == "tool_use") {
                out.push(json!({"type":"tool.sub","id":agent,"name":first["name"],"input":first["input"]}));
            }
        } else if s(record, "type") == "user" {
            if arr(content).iter().any(|b| s(b, "type") == "tool_result") {
                out.extend(tool_results(content, Some(agent)));
            } else if let Some(user) = user_text(content) {
                if !s(&user, "text").is_empty() {
                    out.push(json!({"type":"agent.msg","agent":agent,"dir":"to","text":user["text"],"label":"message","dedupe":true}));
                }
            }
        }
    } else {
        if record["isSidechain"] == true || record["parent_tool_use_id"].is_string() {
            return Ok(out);
        }
        if s(record, "type") == "assistant" {
            out.extend(assistant(content, uuid, None));
            if record["uuid"].is_string() {
                out.push(json!({"type":"mark","uuid":uuid,"assistant":true}));
            }
            for block in arr(content).iter().filter(|b| s(b, "type") == "tool_use") {
                let id = s(block, "id");
                match s(block, "name") {
                    "Agent" | "Task" => {
                        let fields = agent_input(&block["input"]);
                        let mut saved = state.get("agent", id);
                        if saved.is_null() {
                            saved = json!({"running":true,"background":true});
                        }
                        super::storage::merge(&mut saved, &fields);
                        state.set("agent", id, &saved)?;
                        let mut ev = json!({"type":"agent","id":id});
                        super::storage::merge(&mut ev, &fields);
                        out.push(ev);
                    }
                    "SendMessage" => {
                        let to = block["input"]
                            .get("to")
                            .or(block["input"].get("recipient"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let target = state
                            .get("native", to)
                            .as_str()
                            .map(str::to_owned)
                            .or_else(|| state.named(to)).or_else(||state.db.query_row("SELECT key FROM history_state WHERE source=?1 AND space='agent' AND json_extract(value,'$.running')=1 LIMIT 1",[state.source],|r|r.get(0)).optional().ok().flatten());
                        if let Some(target) = target {
                            state.set("send", id, &json!(target))?;
                            let text = block["input"]
                                .get("message")
                                .or(block["input"].get("content"))
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            if !text.is_empty() {
                                out.push(json!({"type":"agent.msg","agent":target,"id":format!("{id}:msg"),"dir":"to","text":text,"label":"message"}));
                            }
                        }
                    }
                    _ => {}
                }
            }
        } else if s(record, "type") == "user" {
            if arr(content).iter().any(|b| s(b, "type") == "tool_result") {
                out.extend(tool_results(content, None));
                for block in arr(content)
                    .iter()
                    .filter(|b| s(b, "type") == "tool_result")
                {
                    let id = s(block, "tool_use_id");
                    let text = result_text(&block["content"]);
                    let send = state.get("send", id);
                    if let Some(target) = send.as_str() {
                        if block["is_error"] != true
                            && (text.contains("resumedAgentId") || text.contains("Resuming agent"))
                        {
                            let mut saved = state.get("agent", target);
                            saved["running"] = json!(true);
                            state.set("agent", target, &saved)?;
                            out.push(json!({"type":"agent","id":target,"status":"running"}));
                        }
                        continue;
                    }
                    let mut saved = state.get("agent", id);
                    if saved.is_null() {
                        continue;
                    }
                    if let Some(start) = text.find("agentId:") {
                        let native = text[start + 8..]
                            .trim_start()
                            .chars()
                            .take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                            .collect::<String>();
                        if !native.is_empty() {
                            state.set("native", &native, &json!(id))?;
                        }
                    }
                    if saved["running"] == false {
                        continue;
                    }
                    let failed = block["is_error"] == true;
                    if failed && text.contains("<tool_use_error>") {
                        state.set("agent", id, &Value::Null)?;
                        out.push(json!({"type":"agent.drop","id":id}));
                        continue;
                    }
                    let receipt = !failed
                        && (text.trim_start().starts_with("Async agent launched")
                            || text.to_lowercase().contains("agentid:"));
                    saved["running"] = json!(false);
                    state.set("agent", id, &saved)?;
                    let mut ev =
                        json!({"type":"agent","id":id,"status":if failed{"error"}else{"done"}});
                    if !receipt {
                        ev["result"] = json!(text);
                    }
                    out.push(ev);
                }
                if record["uuid"].is_string() {
                    out.push(json!({"type":"mark","uuid":uuid,"assistant":false}));
                }
            } else if let Some(mut user) = user_text(content) {
                let text = s(&user, "text");
                if text.starts_with("<task-notification>") {
                    let tag = |name: &str| {
                        let start = text.find(&format!("<{name}>"))? + name.len() + 2;
                        let end = text[start..].find(&format!("</{name}>"))? + start;
                        Some(text[start..end].trim())
                    };
                    let failed = matches!(tag("status"), Some("failed" | "killed" | "stopped"));
                    if let Some(agent) = state.agent_of(
                        tag("tool-use-id").unwrap_or(""),
                        tag("task-id").unwrap_or(""),
                    ) {
                        let mut saved = state.get("agent", &agent);
                        let running = saved["running"] == true;
                        saved["running"] = json!(false);
                        state.set("agent", &agent, &saved)?;
                        if running {
                            out.push(json!({"type":"agent","id":agent,"status":if failed{"error"}else{"done"}}));
                        }
                        out.push(json!({"type":"agent.mark","id":agent,"status":if failed{"error"}else{"done"}}));
                    } else {
                        let mut ev = json!({"type":"notice","tone":if failed{"warn"}else{"info"},"at":"feed"});
                        if let Some(summary) = tag("summary") {
                            ev["text"] = json!(summary);
                        } else {
                            ev["code"] = json!("reduce.bgTaskDone");
                        }
                        out.push(ev);
                    }
                } else if text.starts_with("[Request interrupted") {
                    out.push(json!({"type":"notice","code":"reduce.interrupted","tone":"warn","at":"if-open"}));
                } else {
                    let summary = record["isCompactSummary"] == true
                        || text.starts_with(
                            "This session is being continued from a previous conversation",
                        );
                    user["type"] = json!("user");
                    if record["uuid"].is_string() {
                        user["uuid"] = json!(uuid);
                    }
                    if summary {
                        user["summary"] = json!(true);
                    }
                    out.push(user);
                }
            }
        }
    }
    if let Some(ts) = timestamp(&record["timestamp"]) {
        for event in &mut out {
            event["timestamp"] = json!(ts);
        }
    }
    Ok(out)
}

pub fn data_image(url: &str, id: &str) -> Option<Value> {
    let rest = url.strip_prefix("data:")?;
    let (mime, data) = rest.split_once(";base64,")?;
    Some(json!({"id":id,"mediaType":mime,"data":data}))
}
pub fn codex_user(content: &Value) -> Value {
    let text = arr(content)
        .iter()
        .filter(|c| matches!(s(c, "type"), "text" | "input_text"))
        .map(|c| s(c, "text"))
        .collect::<Vec<_>>()
        .join("\n");
    let images = arr(content)
        .iter()
        .enumerate()
        .filter_map(|(i, c)| {
            if matches!(s(c, "type"), "image" | "input_image") {
                data_image(
                    c.get("url")
                        .or(c.get("image_url"))
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    &format!("image-{i}"),
                )
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    json!({"text":readable_user(&text),"images":images})
}
pub fn patch_id(id: &str, n: usize) -> String {
    if n == 0 {
        id.to_owned()
    } else {
        format!("{id}#{n}")
    }
}
fn web_results(item: &Value) -> String {
    arr(&item["results"])
        .iter()
        .filter(|r| {
            url::Url::parse(s(r, "url")).is_ok_and(|u| matches!(u.scheme(), "http" | "https"))
        })
        .take(100)
        .map(|r| {
            let url = s(r, "url").replace('>', "%3E");
            let title = s(r, "title").replace('[', "\\[").replace(']', "\\]");
            format!(
                "[{}](<{}>)",
                if title.is_empty() { &url } else { &title },
                url
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}
fn review_text(raw: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return raw.into();
    };
    let Some(findings) = value["findings"].as_array() else {
        return raw.into();
    };
    let mut sections = Vec::new();
    for finding in findings {
        let location = &finding["code_location"];
        let file = s(location, "absolute_file_path");
        let start = location["line_range"]["start"].as_u64().unwrap_or(1);
        let link = file
            .replace('%', "%25")
            .replace('#', "%23")
            .replace('>', "%3E");
        sections.push(format!(
            "### {}\n\n{}\n\n[{}:{}](<{}:{}>)",
            s(finding, "title"),
            s(finding, "body"),
            file.replace(']', "\\]"),
            start,
            link,
            start
        ));
    }
    if let Some(explanation) = value["overall_explanation"].as_str() {
        sections.push(explanation.into())
    }
    if sections.is_empty() {
        "Review completed.".into()
    } else {
        sections.join("\n\n")
    }
}
pub fn codex_item(item: &Value, end: bool, agent: Option<&str>) -> Vec<Value> {
    let id = s(item, "id");
    let mut out = Vec::new();
    match s(item,"type"){
        "userMessage"=>{if let Some(id)=item["clientId"].as_str(){out.push(json!({"type":"message.receipt","id":id,"status":"consumed"}));}},
        "agentMessage"=>{out.push(json!({"type":"text","id":id,"text":if end{s(item,"text")}else{""},"mode":if end{"final"}else{"delta"}}));if end&&agent.is_none()&&!arr(&item["questions"]).is_empty(){out.push(json!({"type":"codex.state","state":{"questions":{"id":id,"items":item["questions"]}}}));}},
        "reasoning"=>{let parts=if arr(&item["summary"]).is_empty(){&item["content"]}else{&item["summary"]};let text=arr(parts).iter().filter_map(|v|v.as_str().or_else(||v.get("text").and_then(Value::as_str))).collect::<Vec<_>>().join("\n\n");out.push(json!({"type":"thinking","id":id,"text":if end{&text}else{""},"mode":if end{"final"}else{"delta"}}));},
        "commandExecution"=>{let commands=arr(&item["commandActions"]).iter().filter_map(|c|c["command"].as_str()).collect::<Vec<_>>().join(" && ");let command=if commands.is_empty(){s(item,"command")}else{&commands};let mut input=json!({"command":command});if command!=s(item,"command"){input["description"]=item["command"].clone();}out.push(json!({"type":"tool","id":id,"name":"Bash","input":input,"final":true}));if end{let mut text=strip_ansi(s(item,"aggregatedOutput")).trim_end().to_owned();if let Some(code)=item["exitCode"].as_i64().filter(|n|*n!=0){text.push_str(&format!("{}(exit code {code})",if text.is_empty(){""}else{"\n"}));}out.push(json!({"type":"tool.result","id":id,"status":if s(item,"status")=="completed"{"done"}else{"error"},"result":text}));}},
        "fileChange"=>{for(n,change)in arr(&item["changes"]).iter().enumerate(){let mut input=json!({"file_path":change["path"],"kind":change["kind"].get("type").and_then(Value::as_str).unwrap_or("update"),"diff":change.get("diff").and_then(Value::as_str).unwrap_or("")});if let Some(path)=change["kind"].get("move_path"){input["move_path"]=path.clone();}out.push(json!({"type":"tool","id":patch_id(id,n),"name":"Patch","input":input,"final":true}));if end{out.push(json!({"type":"tool.result","id":patch_id(id,n),"status":if s(item,"status")=="completed"{"done"}else{"error"},"result":""}));}}},
        "mcpToolCall"|"dynamicToolCall"=>{let dynamic=s(item,"type")=="dynamicToolCall";let namespace=if dynamic{item.get("namespace").and_then(Value::as_str).unwrap_or("desk")}else{s(item,"server")};out.push(json!({"type":"tool","id":id,"name":format!("mcp__{namespace}__{}",s(item,"tool")),"input":item.get("arguments").cloned().unwrap_or(json!({})),"final":true}));if end{let error=!item["error"].is_null()||item["success"]==false||s(item,"status")=="failed";let content=if dynamic{&item["contentItems"]}else{&item["result"]["content"]};let mut result=arr(content).iter().filter(|c|matches!(s(c,"type"),"text"|"inputText")).map(|c|s(c,"text")).collect::<Vec<_>>().join("\n");if error{result=result_text(item["error"].get("message").unwrap_or(&item["error"]));}else if result.is_empty()&&!item["result"]["structuredContent"].is_null(){result=result_text(&item["result"]["structuredContent"]);}let images=arr(content).iter().filter_map(|c|{if s(c,"type")=="inputImage"{data_image(s(c,"imageUrl"),"")}else if s(c,"type")=="image"{Some(json!({"mediaType":c["mimeType"].as_str().unwrap_or("image/png"),"data":c["data"]}))}else{None}}).collect::<Vec<_>>();let mut ev=json!({"type":"tool.result","id":id,"status":if error{"error"}else{"done"},"result":result});if !images.is_empty(){ev["images"]=json!(images);}out.push(ev);}},
        "webSearch"=>{let action=&item["action"];let(name,input)=if s(action,"type")=="openPage"{("WebFetch",json!({"url":action["url"].as_str().unwrap_or("")}))}else{("WebSearch",json!({"query":item["query"].as_str().filter(|s|!s.is_empty()).or(action["query"].as_str()).map(str::to_owned).unwrap_or_else(||arr(&action["queries"]).iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "))}))};out.push(json!({"type":"tool","id":id,"name":name,"input":input,"final":true}));if end{out.push(json!({"type":"tool.result","id":id,"status":"done","result":web_results(item)}));}},
        "imageView"|"imageGeneration"=>{let view=s(item,"type")=="imageView";out.push(json!({"type":"tool","id":id,"name":if view{"Read"}else{"ImageGeneration"},"input":if view{json!({"file_path":item["path"]})}else{json!({"prompt":item["revisedPrompt"].as_str().unwrap_or("")})},"final":true}));if end{out.push(json!({"type":"tool.result","id":id,"status":if s(item,"status")=="failed"{"error"}else{"done"},"result":if view{""}else{s(item,"savedPath")}}));}},
        "collabAgentToolCall"=>{let spawn=s(item,"tool")=="spawnAgent";let prompt=s(item,"prompt");if spawn{let mut input=json!({"description":prompt.lines().next().unwrap_or("").chars().take(80).collect::<String>(),"prompt":prompt});if let Some(model)=item.get("model"){input["model"]=model.clone();}out.push(json!({"type":"tool","id":id,"name":"Agent","input":input,"final":true}));if agent.is_none(){let mut ev=json!({"type":"agent","id":id,"prompt":prompt,"background":true});if let Some(model)=item.get("model"){ev["model"]=model.clone();}out.push(ev);}}else{out.push(json!({"type":"tool","id":id,"name":format!("Agent.{}",s(item,"tool")),"input":{"prompt":prompt,"targets":item.get("receiverThreadIds").cloned().unwrap_or(json!([]))},"final":true}));}if end{let message=item["agentsStates"].as_object().and_then(|m|m.values().next()).map(|v|s(v,"message")).unwrap_or("");out.push(json!({"type":"tool.result","id":id,"status":if s(item,"status")=="failed"{"error"}else{"done"},"result":if spawn{message}else{""}}));if spawn&&agent.is_none()&&s(item,"status")=="failed"{out.push(json!({"type":"agent","id":id,"status":"error","result":message}));}}},
        "subAgentActivity" if end&&agent.is_none()=>{let id=format!("agent-{}",s(item,"agentThreadId"));match s(item,"kind"){
            "started"=>{let name=s(item,"agentPath").split('/').filter(|s|!s.is_empty()).last().unwrap_or("agent").replace('_'," ");out.push(json!({"type":"tool","id":id,"name":"Agent","input":{"description":name},"final":true}));out.push(json!({"type":"tool.result","id":id,"status":"done","result":""}));out.push(json!({"type":"agent","id":id,"name":name,"background":true}));},
            "interacted"=>out.push(json!({"type":"agent","id":id,"status":"running"})),"completed"=>{out.push(json!({"type":"agent","id":id,"status":"done"}));out.push(json!({"type":"agent.mark","id":id,"status":"done"}));},_=>{}}},
        "contextCompaction" if end=>out.push(json!({"type":"notice","code":"reduce.compacted","tone":"info","at":"open"})),
        "enteredReviewMode" if end&&!s(item,"review").is_empty()=>out.push(json!({"type":"notice","text":item["review"],"tone":"info","at":"open"})),
        "exitedReviewMode" if end&&!s(item,"review").is_empty()=>out.push(json!({"type":"text","id":id,"text":review_text(s(item,"review")),"mode":"final"})),
        "hookPrompt" if end=>out.push(json!({"type":"notice","text":arr(&item["fragments"]).iter().map(|f|s(f,"text")).collect::<Vec<_>>().join("\n"),"tone":"info","at":"feed"})),
        "plan"=>out.push(json!({"type":"text","id":id,"text":item["text"],"mode":if end{"final"}else{"delta"}})),
        "sleep"=>{out.push(json!({"type":"tool","id":id,"name":"Sleep","input":item,"final":true}));if end{out.push(json!({"type":"tool.result","id":id,"status":"done","result":""}));}},
        "functionCallOutput" if end=>out.push(json!({"type":"tool.result","id":id,"status":"done","result":result_text(&item["output"])})),
        "extension" if s(item,"kind")=="web.search"=>{out.push(json!({"type":"tool","id":id,"name":"WebSearch","input":{"query":item.get("query").or(item["action"].get("query")).and_then(Value::as_str).unwrap_or("")},"final":true}));if end{let text=arr(&item["results"]).iter().filter(|r|r["url"].is_string()).map(|r|format!("{} — {}",r.get("title").and_then(Value::as_str).unwrap_or(s(r,"url")),s(r,"url"))).collect::<Vec<_>>().join("\n");out.push(json!({"type":"tool.result","id":id,"status":"done","result":text}));}},_=>{}
    }
    if let Some(agent) = agent {
        for ev in &mut out {
            if matches!(
                s(ev, "type"),
                "text" | "thinking" | "tool" | "tool.result" | "tool.output"
            ) {
                ev["agent"] = json!(agent);
            }
        }
    }
    out
}
pub fn codex_limits(rate: &Value) -> Option<Value> {
    if rate.is_null() {
        return None;
    }
    let mut out = json!({"type":"limits"});
    for window in [&rate["primary"], &rate["secondary"]] {
        if window.is_null() {
            continue;
        }
        out[if window["windowDurationMins"].as_u64().unwrap_or(0) <= 600 {
            "session"
        } else {
            "weekly"
        }] = json!({"pct":window["usedPercent"].as_f64().unwrap_or(0.0),"resetsAt":window["resetsAt"].as_i64().map(|n|n*1000)});
    }
    if !rate["rateLimitReachedType"].is_null() {
        out["rejected"] = json!(true);
    }
    Some(out)
}
#[derive(Default)]
pub struct CodexTranslator {
    pub turn: Option<String>,
    pub completed_turn: String,
    retired_turns: std::collections::VecDeque<String>,
    pub review_turn: Option<String>,
    pub last_text: String,
    pub last_error: String,
    pub children: std::collections::HashMap<String, String>,
    pub context: Value,
}
impl CodexTranslator {
    pub fn is_finished(&self, id: &str) -> bool {
        !id.is_empty()
            && (self.completed_turn == id || self.retired_turns.iter().any(|done| done == id))
    }
    pub fn retire_turn(&mut self, id: &str) {
        if !id.is_empty() && !self.retired_turns.iter().any(|done| done == id) {
            self.retired_turns.push_back(id.into());
            while self.retired_turns.len() > 64 {
                self.retired_turns.pop_front();
            }
        }
    }
    pub fn push(&mut self, method: &str, p: &Value, own: &str) -> Vec<Value> {
        let thread = s(p, "threadId");
        let agent = if !thread.is_empty() && thread != own {
            match self.children.get(thread) {
                Some(id) => Some(id.clone()),
                None => return Vec::new(),
            }
        } else {
            None
        };
        let mut out = Vec::new();
        if agent.is_none() && method == "turn/started" && self.is_finished(s(&p["turn"], "id")) {
            return out;
        }
        if agent.is_none()
            && matches!(method, "item/started" | "item/completed")
            && p["item"]["type"] == "enteredReviewMode"
        {
            self.review_turn = p["turnId"].as_str().map(str::to_owned);
            if self.review_turn.is_some() {
                self.turn = self.review_turn.clone();
            }
        }
        if method == "turn/completed" && agent.is_none() {
            let id = s(&p["turn"], "id");
            if !id.is_empty()
                && (self.is_finished(id) || self.turn.as_ref().is_some_and(|current| current != id))
            {
                return out;
            }
            self.completed_turn = id.into();
            self.retire_turn(id);
        }
        match method{
            "turn/started" if agent.is_none()=>{if self.review_turn.is_none(){self.turn=p["turn"]["id"].as_str().map(str::to_owned);}self.last_text.clear();self.last_error.clear();out.push(json!({"type":"step"}));},
            "item/started"|"item/completed"=>{let end=method.ends_with("completed");let item=&p["item"];if !end&&agent.is_none()&&s(item,"type")!="userMessage"{out.push(json!({"type":"step"}));}if end&&agent.is_none()&&matches!(s(item,"type"),"agentMessage"|"plan")&&!s(item,"text").is_empty(){self.last_text=s(item,"text").to_owned();}if end&&agent.is_none()&&s(item,"type")=="exitedReviewMode"{self.last_text=review_text(s(item,"review"));}out.extend(codex_item(item,end,agent.as_deref()));if end&&agent.is_none(){if s(item,"type")=="subAgentActivity"&&!s(item,"agentThreadId").is_empty(){self.children.insert(s(item,"agentThreadId").into(),format!("agent-{}",s(item,"agentThreadId")));}if s(item,"type")=="collabAgentToolCall"{if s(item,"tool")=="spawnAgent"{for id in arr(&item["receiverThreadIds"]).iter().filter_map(Value::as_str){self.children.insert(id.into(),s(item,"id").into());}}if let Some(states)=item["agentsStates"].as_object(){for(tid,state)in states{let target=self.children.get(tid).cloned().or_else(||if s(item,"tool")=="spawnAgent"{Some(s(item,"id").into())}else{None});let status=match s(state,"status"){"completed"|"shutdown"=>"done","errored"|"notFound"=>"error","interrupted"=>"stopped",_=>continue};if let Some(id)=target{out.push(json!({"type":"agent","id":id,"status":status,"result":state.get("message").and_then(Value::as_str).unwrap_or("")}));}}}}}},
            "hook/started"|"hook/completed"=>{let hook=&p["run"];let id=format!("hook-{}",s(hook,"id"));out.push(json!({"type":"tool","id":id,"name":"Hook","input":{"event":hook["eventName"],"file_path":hook["sourcePath"]},"final":true}));if method=="hook/completed"{out.push(json!({"type":"tool.result","id":id,"status":if matches!(s(hook,"status"),"failed"|"blocked"){"error"}else{"done"},"result":arr(&hook["entries"]).iter().map(|e|s(e,"text")).collect::<Vec<_>>().join("\n")}));}},
            "item/plan/delta"=>out.push(json!({"type":"text","id":p["itemId"],"text":p["delta"],"mode":"delta"})),
            "item/reasoning/textDelta"=>out.push(json!({"type":"thinking","id":format!("{}-raw",s(p,"itemId")),"text":p["delta"],"mode":"delta"})),
            "item/fileChange/outputDelta"=>out.push(json!({"type":"tool.output","id":p["itemId"],"chunk":strip_ansi(s(p,"delta"))})),
            "item/mcpToolCall/progress"=>out.push(json!({"type":"tool.output","id":p["itemId"],"chunk":format!("{}\n",s(p,"message"))})),
            "item/agentMessage/delta"=>out.push(json!({"type":"text","id":p["itemId"],"text":p["delta"],"mode":"delta"})),
            "item/reasoning/summaryPartAdded" if p["summaryIndex"].as_u64().unwrap_or(0)>0=>out.push(json!({"type":"thinking","id":p["itemId"],"text":"\n\n","mode":"delta"})),
            "item/reasoning/summaryTextDelta"=>out.push(json!({"type":"thinking","id":p["itemId"],"text":p["delta"],"mode":"delta"})),
            "item/commandExecution/outputDelta"=>out.push(json!({"type":"tool.output","id":p["itemId"],"chunk":strip_ansi(s(p,"delta"))})),
            "item/fileChange/patchUpdated"=>{for(n,c)in arr(&p["changes"]).iter().enumerate(){out.push(json!({"type":"tool","id":patch_id(s(p,"itemId"),n),"name":"Patch","input":{"file_path":c["path"],"kind":c["kind"].get("type").and_then(Value::as_str).unwrap_or("update"),"diff":c.get("diff").and_then(Value::as_str).unwrap_or("")},"final":true}));}},
            "turn/plan/updated" if agent.is_none()=>{let todos=arr(&p["plan"]).iter().map(|step|json!({"content":step["step"],"activeForm":step["step"],"status":match s(step,"status"){"inProgress"=>"in_progress","completed"=>"completed",_=>"pending"}})).collect::<Vec<_>>();let id=format!("plan-{}",s(p,"turnId"));out.push(json!({"type":"tool","id":id,"name":"TodoWrite","input":{"todos":todos},"final":true}));out.push(json!({"type":"tool.result","id":id,"status":"done","result":p.get("explanation").and_then(Value::as_str).unwrap_or("")}));},
            "error" if agent.is_none()=>{if p["willRetry"]==true{out.push(json!({"type":"status","activity":"retrying"}));}else{self.last_error=error_text(&p["error"]);}},
            "turn/completed" if agent.is_none()=>{let turn=&p["turn"];let failed=s(turn,"status")=="failed";let mut ev=json!({"type":"turn.end","isError":failed,"text":self.last_text});if let Some(duration)=turn.get("durationMs"){ev["durationMs"]=duration.clone();}if failed{let error=error_text(&turn["error"]);ev["error"]=json!(if error.is_empty(){self.last_error.clone()}else{error});}out.push(ev);self.turn=None;self.review_turn=None;self.last_text=String::new();self.last_error=String::new();},
            "thread/tokenUsage/updated" if agent.is_none()=>{let u=&p["tokenUsage"];let used=u["last"]["totalTokens"].as_u64().unwrap_or(0);let max=u["modelContextWindow"].as_u64().unwrap_or(0);if max>0{self.context=json!({"totalTokens":used,"maxTokens":max,"percentage":((used as f64)/(max as f64)*1000.0).round()/10.0,"categories":[]});out.push(json!({"type":"context","usage":self.context}));}},
            "thread/goal/updated" if agent.is_none()=>out.push(json!({"type":"codex.state","state":{"goal":p["goal"]}})),
            "thread/goal/cleared" if agent.is_none()=>out.push(json!({"type":"codex.state","state":{"goal":null}})),
            "thread/settings/updated" if agent.is_none()=>out.push(json!({"type":"codex.state","state":{"settings":p["threadSettings"]}})),
            "thread/name/updated" if agent.is_none()&&p["threadName"].is_string()=>out.push(json!({"type":"codex.state","state":{"title":p["threadName"]}})),
            "turn/diff/updated" if agent.is_none()=>out.push(json!({"type":"codex.state","state":{"diff":s(p,"diff").chars().take(2*1024*1024).collect::<String>()}})),
            "modelProvider/authRecoveryStarted" if agent.is_none()=>out.push(json!({"type":"status","activity":"retrying"})),
            "modelProvider/authRecoveryCompleted" if agent.is_none()=>out.push(json!({"type":"status","activity":null})),
            "thread/compacted" if agent.is_none()=>out.push(json!({"type":"notice","code":"reduce.compacted","tone":"info","at":"feed"})),
            "configWarning"|"deprecationNotice"|"guardianWarning" if agent.is_none()=>out.push(json!({"type":"notice","text":p.get("message").or(p.get("summary")).or(p.get("details")).cloned().unwrap_or(Value::Null),"tone":"warn","at":"feed"})),
            "warning" if agent.is_none()&&!s(p,"message").is_empty()=>out.push(json!({"type":"notice","text":p["message"],"tone":"warn","at":"feed"})),
            "model/rerouted" if agent.is_none()=>out.push(json!({"type":"notice","text":format!("{} → {}",s(p,"fromModel"),s(p,"toModel")),"tone":"info","at":"feed"})),_=>{}
        }
        if let Some(agent) = agent {
            for event in &mut out {
                if matches!(
                    s(event, "type"),
                    "text" | "thinking" | "tool" | "tool.output" | "tool.result"
                ) {
                    event["agent"] = json!(agent);
                }
            }
        }
        out
    }
}
pub fn error_text(error: &Value) -> String {
    let raw = error
        .as_str()
        .unwrap_or_else(|| error["message"].as_str().unwrap_or(""));
    if let Ok(json) = serde_json::from_str::<Value>(raw) {
        json["error"]["message"]
            .as_str()
            .or(json["message"].as_str())
            .unwrap_or(raw)
            .to_owned()
    } else {
        raw.to_owned()
    }
}
