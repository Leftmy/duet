//! Kimi transcript protocol -> shared Duet events. Stable frame IDs make replay idempotent.
use super::events::{arr, result_text, s};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
#[derive(Default)]
pub struct Translator {
    pub sequences: HashMap<String, u64>,
    frames: HashMap<String, Value>,
    turns: HashMap<String, Value>,
    finished: HashSet<String>,
    order: Vec<String>,
    pub agents: HashSet<String>,
    pub context: Value,
    pub last_turn: u64,
    session: String,
}
fn tagged(mut value: Value, agent: &str) -> Value {
    if agent != "main" && !agent.is_empty() {
        value["agent"] = json!(format!("kimi-{agent}"));
    }
    value
}
fn event_id(agent: &str, id: &str) -> String {
    format!("kimi:{agent}:{id}")
}
impl Translator {
    pub fn feed(&mut self, frame: &Value) -> Vec<Value> {
        let typ = s(frame, "type");
        if !s(frame, "session_id").is_empty() {
            self.session = s(frame, "session_id").into();
        }
        let p = &frame["payload"];
        let agent = frame["agent_id"]
            .as_str()
            .or(p["agent_id"].as_str())
            .unwrap_or("main");
        let mut out = Vec::new();
        if typ == "transcript.ops" || typ == "transcript.reset" {
            let seq = p["seq"].as_u64().unwrap_or(0);
            let old = self.sequences.get(agent).copied();
            if old.is_some_and(|n| seq <= n) {
                return out;
            }
            self.sequences.insert(agent.into(), seq);
            if typ == "transcript.reset" {
                self.snapshot(agent, &p["snapshot"], &mut out);
            } else {
                for op in arr(&p["ops"]) {
                    self.operation(agent, op, &mut out);
                }
            }
        } else {
            match typ {
                "agent" => {
                    self.agents.insert(agent.into());
                    if agent != "main" {
                        out.push(json!({"type":"agent","id":format!("kimi-{agent}"),"runId":format!("native:kimi:{}:{agent}",s(frame,"session_id")),"provider":"kimi","name":agent,"model":frame["model"],"status":if frame["status"]=="running"{"running"}else{"done"}}));
                    }
                }
                "usage" => {
                    if agent == "main" {
                        self.context = json!({"totalTokens":frame["context_tokens"],"maxTokens":frame["max_context_tokens"].as_u64().unwrap_or(262144),"percentage":frame["context_tokens"].as_f64().unwrap_or(0.)/frame["max_context_tokens"].as_f64().unwrap_or(262144.).max(1.)*100.,"categories":[]});
                    }
                    out.push(tagged(json!({"type":"context","usage":{"totalTokens":frame["context_tokens"],"maxTokens":frame["max_context_tokens"].as_u64().unwrap_or(262144),"categories":[],"percentage":frame["context_tokens"].as_f64().unwrap_or(0.)/frame["max_context_tokens"].as_f64().unwrap_or(262144.).max(1.)*100.}}),agent));
                }
                "todo" => {
                    let id = format!("kimi:{agent}:todos-{}", self.last_turn);
                    let todos=arr(&frame["items"]).iter().map(|item|json!({"content":item["title"],"activeForm":item["title"],"status":match s(item,"status"){"done"=>"completed","in_progress"=>"in_progress",_=>"pending"}})).collect::<Vec<_>>();
                    out.push(tagged(json!({"type":"tool","id":id,"name":"TodoWrite","input":{"todos":todos},"final":true}),agent));
                    out.push(tagged(
                        json!({"type":"tool.result","id":id,"status":"done","result":""}),
                        agent,
                    ));
                }
                "task.list" => {
                    for task in arr(&frame["tasks"]) {
                        let mut item = task.clone();
                        item["type"] = json!("task");
                        item["session_id"] = frame["session_id"].clone();
                        item["agent_id"] = json!(agent);
                        out.extend(self.feed(&item));
                    }
                }
                "task" => {
                    let task = frame.get("task").unwrap_or(frame);
                    let id = task
                        .get("id")
                        .or(task.get("task_id"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if !id.is_empty() {
                        out.push(tagged(json!({"type":"task","op":if matches!(s(task,"status"),"ended"|"completed"|"failed"|"cancelled"|"stopped"){"end"}else{"start"},"id":format!("kimi:{agent}:{id}"),"description":task.get("description").or(task.get("title")),"background":true,"status":match s(task,"outcome"){"failed"=>"error","cancelled"=>"stopped",_=>if task["status"]=="ended"{"done"}else{"running"}}}),agent));
                    }
                }
                "task.output" => {
                    out.push(tagged(json!({"type":"tool.output","id":event_id(agent,s(frame,"task_id")),"chunk":frame["text"]}),agent));
                }
                "event.config.warning" => out
                    .push(json!({"type":"notice","text":result_text(p),"tone":"warn","at":"open"})),
                _ => {}
            }
        }
        out
    }
    fn snapshot(&mut self, agent: &str, snapshot: &Value, out: &mut Vec<Value>) {
        for item in arr(&snapshot["items"]) {
            if item["kind"] == "turn" {
                self.turn(agent, item, out);
                for step in arr(&item["steps"]) {
                    for frame in arr(&step["frames"]) {
                        let mut frame = frame.clone();
                        frame["_turn"] = item["turnId"].clone();
                        frame["_agent"] = json!(agent);
                        self.frame(agent, &frame, out);
                    }
                }
                self.end(agent, item, out);
            }
        }
    }
    fn operation(&mut self, agent: &str, op: &Value, out: &mut Vec<Value>) {
        match s(op, "op") {
            "reset" => self.snapshot(agent, &op["snapshot"], out),
            "turn.upsert" => {
                self.turn(agent, &op["turn"], out);
                self.end(agent, &op["turn"], out);
            }
            "step.upsert" => {
                if op["step"]["state"] == "running" {
                    out.push(tagged(json!({"type":"step"}), agent));
                }
                if op["step"]["retry"].is_object() {
                    out.push(tagged(json!({"type":"notice","text":format!("Kimi retry: {}",s(&op["step"]["retry"],"errorMessage")),"tone":"warn","at":"open"}),agent));
                }
            }
            "frame.upsert" => {
                let mut frame = op["frame"].clone();
                frame["_turn"] = op["turnId"].clone();
                frame["_agent"] = json!(agent);
                self.frame(agent, &frame, out);
            }
            "append" => {
                let id = event_id(agent, s(&op["target"], "frameId"));
                if let Some(frame) = self.frames.get_mut(&id) {
                    let text = s(frame, "text").to_owned();
                    let offset = op["offset"].as_u64().unwrap_or(0) as usize;
                    let actual = text.encode_utf16().count();
                    if offset == actual {
                        let added = s(op, "text");
                        frame["text"] = json!(format!("{text}{added}"));
                        out.push(tagged(json!({"type":if frame["kind"]=="thinking"{"thinking"}else{"text"},"id":id,"text":added,"mode":"delta"}),agent));
                    } else if offset < actual { /* Covered by an already-applied full frame. */
                    }
                }
            }
            "marker.upsert" => out.push(tagged(
                json!({"type":"notice","text":result_text(&op["item"]),"tone":"info","at":"feed"}),
                agent,
            )),
            _ => {}
        }
    }
    fn turn(&mut self, agent: &str, turn: &Value, out: &mut Vec<Value>) {
        if agent == "main" {
            self.last_turn = turn["ordinal"].as_u64().unwrap_or(self.last_turn);
        }
        let id = event_id(agent, s(turn, "turnId"));
        let fresh = !self.turns.contains_key(&id);
        if fresh && turn["state"] == "running" {
            let previous: HashSet<String> = self
                .turns
                .iter()
                .filter(|(k, _)| {
                    k.starts_with(&format!("kimi:{agent}:")) && self.finished.contains(*k)
                })
                .map(|(_k, v)| {
                    let tid = s(v, "turnId").to_owned();

                    tid
                })
                .collect();
            self.finished
                .retain(|k| !k.starts_with(&format!("kimi:{agent}:")));
            self.frames.retain(|_, v| {
                !(v["_agent"] == agent && v["_turn"].as_str().is_some_and(|v| previous.contains(v)))
            });
            self.order.retain(|k| self.frames.contains_key(k));
            self.turns.retain(|k, v| {
                !(k.starts_with(&format!("kimi:{agent}:")) && previous.contains(s(v, "turnId")))
            });
        }
        self.turns.insert(id, turn.clone());
        if fresh && turn["state"] == "running" {
            out.push(tagged(json!({"type":"step"}), agent));
            if agent == "main" {
                out.push(json!({"type":"mark","uuid":format!("kimi-turn:{}",turn["ordinal"]),"assistant":false}));
            }
        }
    }
    fn end(&mut self, agent: &str, turn: &Value, out: &mut Vec<Value>) {
        if !matches!(s(turn, "state"), "completed" | "failed" | "cancelled") {
            return;
        }
        let id = event_id(agent, s(turn, "turnId"));
        if !self.finished.insert(id) {
            return;
        }
        let text = self
            .order
            .iter()
            .filter_map(|id| self.frames.get(id))
            .filter(|v| {
                v["_turn"] == turn["turnId"]
                    && v["_agent"] == agent
                    && v["kind"] == "text"
                    && v["role"] != "user"
            })
            .map(|v| s(v, "text"))
            .collect::<Vec<_>>()
            .join("\n\n");
        for id in &self.order {
            if let Some(frame) = self.frames.get(id) {
                if frame["_turn"] == turn["turnId"]
                    && frame["_agent"] == agent
                    && matches!(s(frame, "kind"), "text" | "thinking")
                    && frame["role"] != "user"
                {
                    out.push(tagged(
                        json!({"type":frame["kind"],"id":id,"text":frame["text"],"mode":"final"}),
                        agent,
                    ));
                }
            }
        }
        out.push(tagged(json!({"type":"turn.end","text":text,"isError":turn["state"]=="failed","error":turn["error"],"stopped":turn["state"]=="cancelled","durationMs":turn["durationMs"]}),agent));
    }
    fn frame(&mut self, agent: &str, frame: &Value, out: &mut Vec<Value>) {
        let id = event_id(agent, s(frame, "frameId"));
        if self.frames.get(&id).is_some_and(|old| old == frame) {
            return;
        }
        let old = self.frames.insert(id.clone(), frame.clone());
        if old.is_none() {
            self.order.push(id.clone());
        }
        match s(frame,"kind"){
            "text" if frame["role"]!="user"=>out.push(tagged(json!({"type":"text","id":id,"text":frame["text"],"mode":"final"}),agent)),
            "thinking"=>out.push(tagged(json!({"type":"thinking","id":id,"text":frame["text"],"mode":"final"}),agent)),
            "tool"=>{
                for child in arr(&frame["agentRefs"]){let child=s(child,"agentId");if self.agents.insert(child.into()){out.push(json!({"type":"agent","id":format!("kimi-{child}"),"provider":"kimi","runId":format!("native:kimi:{}:{child}",self.session),"name":child,"parentId":if agent=="main"{Value::Null}else{json!(format!("kimi-{agent}"))}}));}}
                let call=event_id(agent,s(frame,"toolCallId"));out.push(tagged(json!({"type":"tool","id":call,"name":frame["name"],"input":frame["input"],"final":true}),agent));
                if matches!(s(frame,"state"),"done"|"error"){out.push(tagged(json!({"type":"tool.result","id":call,"status":if frame["state"]=="error"{"error"}else{"done"},"result":if frame["error"].is_string(){s(frame,"error").to_owned()}else{result_text(&frame["output"])}}),agent));}
                else if let Some(progress)=frame["progress"]["text"].as_str(){if old.as_ref().map(|o|&o["progress"])!=Some(&frame["progress"]){out.push(tagged(json!({"type":"tool.output","id":call,"chunk":progress}),agent));}}
            }
            "notice"=>out.push(tagged(json!({"type":"notice","text":frame["message"],"tone":match s(frame,"level"){"warning"=>"warn","error"=>"error",_=>"info"},"at":"open"}),agent)),_=>{}
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn ops(t: &mut Translator, seq: u64, agent: &str, ops: Value) -> Vec<Value> {
        t.feed(&json!({"type":"transcript.ops","session_id":"session_test","payload":{"seq":seq,"agent_id":agent,"ops":ops}}))
    }
    #[test]
    fn unicode_offsets_replay_and_turn_answer_order() {
        let mut t = Translator::default();
        ops(
            &mut t,
            1,
            "main",
            json!([{"op":"turn.upsert","turn":{"turnId":"t","ordinal":0,"state":"running"}},{"op":"frame.upsert","turnId":"t","frame":{"kind":"text","frameId":"a","role":"assistant","text":"😀"}}]),
        );
        let event = json!([{"op":"append","target":{"frameId":"a"},"offset":2,"text":" unicode"}]);
        assert_eq!(ops(&mut t, 2, "main", event.clone())[0]["text"], " unicode");
        assert!(ops(&mut t, 2, "main", event).is_empty());
        ops(
            &mut t,
            3,
            "main",
            json!([{"op":"frame.upsert","turnId":"t","frame":{"kind":"text","frameId":"b","role":"assistant","text":"second"}}]),
        );
        let end = ops(
            &mut t,
            4,
            "main",
            json!([{"op":"turn.upsert","turn":{"turnId":"t","ordinal":0,"state":"completed"}}]),
        );
        assert_eq!(end.last().unwrap()["text"], "😀 unicode\n\nsecond");
        assert!(end
            .iter()
            .any(|e| e["type"] == "text" && e["mode"] == "final" && e["text"] == "😀 unicode"));
    }
    #[test]
    fn tool_lifecycle_child_events_and_context_contract() {
        let mut t = Translator::default();
        let out = ops(
            &mut t,
            1,
            "child",
            json!([{"op":"frame.upsert","turnId":"t","frame":{"kind":"tool","frameId":"f","toolCallId":"c","name":"Bash","state":"done","output":"ok"}}]),
        );
        assert_eq!(out[0]["agent"], "kimi-child");
        assert_eq!(out[1]["status"], "done");
        assert_eq!(out[1]["id"], "kimi:child:c");
        let out=t.feed(&json!({"type":"usage","agent_id":"main","context_tokens":100,"max_context_tokens":1000}));
        assert_eq!(out[0]["usage"]["percentage"], 10.);
        assert!(out[0]["usage"]["categories"].is_array());
    }
    #[test]
    fn completed_frames_are_released_at_next_turn() {
        let mut t = Translator::default();
        for n in 0..200 {
            let id = n.to_string();
            ops(
                &mut t,
                n * 3 + 1,
                "main",
                json!([{"op":"turn.upsert","turn":{"turnId":id,"ordinal":n,"state":"running"}},{"op":"frame.upsert","turnId":id,"frame":{"kind":"text","frameId":id,"role":"assistant","text":"large payload"}}]),
            );
            ops(
                &mut t,
                n * 3 + 2,
                "main",
                json!([{"op":"turn.upsert","turn":{"turnId":id,"ordinal":n,"state":"completed"}}]),
            );
        }
        assert_eq!(t.frames.len(), 1);
        assert_eq!(t.turns.len(), 1);
        assert_eq!(t.finished.len(), 1);
        assert_eq!(t.order.len(), 1);
    }
}
