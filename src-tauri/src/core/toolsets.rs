use serde_json::{json, Value};
fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})
}
pub fn all(depth: usize) -> Vec<Value> {
    let str_ = json!({"type":"string"});
    let mut sets = vec![
        json!({"name":"ccd_session","instructions":"Use mark_chapter to label a completed stage of work.","tools":[tool("mark_chapter","Mark a completed stage in this conversation.",json!({"title":str_,"summary":str_}),&["title"]),tool("spawn_task","Suggest an out-of-scope follow-up task as a chat chip. The prompt must stand alone.",json!({"title":str_,"prompt":str_,"tldr":str_,"cwd":str_}),&["title","prompt","tldr"]),tool("dismiss_task","Dismiss a session task.",json!({"task_id":str_,"reason":str_}),&["task_id"])]}),
        json!({"name":"desk-browser","instructions":"Tabs belong to this chat. list_tabs gives stable ids. Pass tab_id to target a page without changing the selected tab. Use read before clicking. Sleeping tabs reload when used; input/media/downloads are protected.","tools":[
 tool("navigate","Navigate the chat's browser page.",json!({"url":str_}),&["url"]),tool("screenshot","Capture the chat's browser page.",json!({}),&[]),tool("read_page","Read the visible page with numbered interactive elements.",json!({}),&[]),tool("read","Read the visible page with numbered interactive elements.",json!({}),&[]),tool("click","Click a numbered element from read, or a CSS selector.",json!({"id":{"type":"integer"},"selector":str_,"text":str_}),&[]),tool("type","Fill a numbered input or CSS selector.",json!({"id":{"type":"integer"},"selector":str_,"text":str_,"submit":{"type":"boolean"}}),&["text"]),tool("scroll","Scroll the page.",json!({"dy":{"type":"number"},"direction":{"type":"string","enum":["up","down"]},"amount":{"type":"number"}}),&[]),tool("back","Go back.",json!({}),&[]),tool("run_js","Run JavaScript in the chat browser page.",json!({"code":str_}),&["code"])]}),
    ];
    if let Some(tools) = sets[1]["tools"].as_array_mut() {
        for definition in tools.iter_mut() {
            definition["inputSchema"]["properties"]["tab_id"] = json!({"type":"string","description":"Stable tab id from list_tabs. Defaults to the selected tab."});
        }
        tools.extend([
            tool("list_tabs","List this chat's tabs, selected id and sleeping status. Does not load pages.",json!({}),&[]),
            tool("new_tab","Create a tab. background=true keeps it sleeping until used. Returns createdTabId.",json!({"url":str_,"background":{"type":"boolean"}}),&[]),
            tool("select_tab","Select and wake a tab.",json!({"tab_id":str_}),&["tab_id"]),
            tool("close_tab","Close a tab. Refuses pages with input, media or downloads.",json!({"tab_id":str_}),&["tab_id"]),
            tool("sleep_tab","Unload a tab to release its WebView. Waking reloads the URL. Refuses input, media or downloads.",json!({"tab_id":str_}),&["tab_id"]),
        ]);
    }
    let mut agents=vec![
        tool("message_agent","Send a message to parent, root, or any run_id in your team. Busy recipients queue it; returns immediately. Use wait_agent or agent_events for progress.",json!({"run_id":str_,"message":str_}),&["run_id","message"]),
        tool("wait_agent","Wait for any selected teammate to finish, at most 60 seconds (default 30). Replies include unread team events, cursor and has_more. Timeout keeps agents running. Use run_id or run_ids; cancelled waits never stop unrelated work.",json!({"run_id":str_,"run_ids":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":64},"after":{"type":"integer","minimum":0},"timeout_sec":{"type":"number","minimum":0,"maximum":60}}),&[]),
        tool("list_agents","List this team's run ids, parent relationships, status, queued messages and current event cursor. Other chats are inaccessible.",json!({}),&[]),
        tool("agent_events","Read ALL normalized team events (including nested agents, plans, edits, approvals and completion) in sequence order. Replay with after=cursor; has_more means read again. timeout_sec long-polls up to 60 seconds without spinning. Large events use read_agent_event.",json!({"after":{"type":"integer","minimum":0},"run_id":str_,"limit":{"type":"integer","minimum":1,"maximum":200},"timeout_sec":{"type":"number","minimum":0,"maximum":60}}),&[]),
        tool("read_agent_event","Read a large event as UTF-8 JSON chunks by seq and byte offset. Follow next_offset until null; only this team's events are accessible.",json!({"seq":{"type":"integer","minimum":1},"offset":{"type":"integer","minimum":0},"max_bytes":{"type":"integer","minimum":1024,"maximum":131072}}),&["seq"]),
        tool("stop_agent","Stop a child and all its descendants, cancel permissions/waits and clear queued messages. Only ancestors may stop an agent.",json!({"run_id":str_}),&["run_id"]),
    ];
    let block_ids=json!({"type":"array","items":{"type":"string"},"minItems":1,"maxItems":200});
    sets.push(json!({"name":"desk-context","instructions":"Inspect block IDs and revision without loading raw history. Archive obsolete tool results, compress selected blocks with an explicit available subscription model, or pin important facts. Direct user messages and active turns are protected. Edits are asynchronous and take effect at the next safe boundary. After requesting an edit, finish this turn with a short checkpoint; the app continues the same chat with the retained context. Original blocks remain readable. Never repeatedly compress the same material or poll jobs in a loop.","tools":[
        tool("inspect","List paginated context block metadata, active/archive state, revision, jobs and available compressor models.",json!({"after":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":100},"mode":{"type":"string","enum":["active","archived"]},"kind":str_}),&[]),
        tool("read","Read an original block by ID in bounded UTF-8 chunks; follow next_offset only when needed.",json!({"id":str_,"offset":{"type":"integer","minimum":0},"max_bytes":{"type":"integer","minimum":256,"maximum":65536}}),&["id"]),
        tool("edit","Atomically archive/compress/pin selected blocks at the next safe boundary. Returns a job ID, never claims an edit was applied before provider binding. dry_run validates without mutation.",json!({"expected_revision":{"type":"integer","minimum":0},"dry_run":{"type":"boolean"},"reason":str_,"operations":{"type":"array","minItems":1,"maxItems":50,"items":{"type":"object","additionalProperties":false,"properties":{"action":{"type":"string","enum":["archive","compress","restore","pin","unpin"]},"ids":block_ids,"reason":str_,"compressor":{"type":"object","additionalProperties":false,"properties":{"provider":{"type":"string","enum":["claude","codex","antigravity"]},"model":str_},"required":["provider","model"]},"target_tokens":{"type":"integer","minimum":64,"maximum":16000},"preserve":{"type":"array","items":{"type":"string"},"maxItems":50}},"required":["action","ids"]}}}),&["expected_revision","operations"]),
        tool("job","Read the state/result of one context job. Prefer completion events over repeated polling.",json!({"job_id":str_}),&["job_id"]),
        tool("cancel","Cancel your queued/preparing/ready context job, retaining the original context. Already-dispatched edits must be undone after acknowledgement.",json!({"job_id":str_}),&["job_id"]),
        tool("restore","Undo the latest applied context operation in this chat. Original history and filesystem changes are preserved.",json!({"job_id":str_}),&["job_id"]),
    ]}));
    if depth < 3 {
        agents.insert(0,tool("run_agent","Delegate a self-contained task in the same project with a read-only reviewer or researcher role; the task controls can transfer executor ownership after the current turn. background=true returns immediately; otherwise waits up to 30 seconds, then returns a running run_id. Background completion wakes the parent; all progress is available through agent_events.",json!({"agent":{"type":"string","enum":["claude","codex","antigravity"]},"task":str_,"model":str_,"role":{"type":"string","enum":["executor","reviewer","researcher"]},"workspace":{"type":"string","enum":["shared","isolated"]},"read_only":{"type":"boolean"},"background":{"type":"boolean"},"timeout_sec":{"type":"number","minimum":0,"maximum":60}}),&["agent","task"]));
    }
    sets.push(json!({"name":"desk-agents","instructions":"Agents share one project, not conversation history. Helpers default to read-only. For parallel implementation request role=executor and workspace=isolated; this creates a managed worktree from the current HEAD, so describe any uncommitted parent changes explicitly. Shared executor ownership is transferred through task controls. A queued helper cannot start until capacity is free: finish the current turn and await its completion message. Use self-contained tasks. Send messages to parent, root, or a teammate run_id. Read progress with agent_events and keep its cursor. Only background completion/messages wake a model; streaming deltas stay in the journal to avoid repeated model turns.","tools":agents}));
    sets
}
pub fn text(value: impl Into<String>, error: bool) -> Value {
    json!({"content":[{"type":"text","text":value.into()}],"isError":error})
}
pub fn dynamic(result: &Value) -> Value {
    let content=result["content"].as_array().into_iter().flatten().map(|c|if c["type"]=="image"{json!({"type":"inputImage","imageUrl":format!("data:{};base64,{}",c["mimeType"].as_str().unwrap_or("image/png"),c["data"].as_str().unwrap_or(""))})}else{json!({"type":"inputText","text":c["text"].as_str().unwrap_or("")})}).collect::<Vec<_>>();
    json!({"contentItems":content,"success":result["isError"]!=true})
}
