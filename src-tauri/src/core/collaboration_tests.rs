use super::*;
#[test]
fn reading_events_acknowledges_mailbox_without_duplicate_model_turns() {
    let (_dir, agents, root, run, _) = fixture();
    let (a, a_run) = child(&agents, &root, "a");
    agents.enqueue_message(&root,json!({"id":"message-read","kind":"message","text":"already delivered through a tool response"})).unwrap();
    a.sub
        .as_ref()
        .unwrap()
        .notify
        .store(true, Ordering::Release);
    agents.emit_event(&a_run, json!({"type":"turn.end","text":"done"}));
    assert_eq!(root.inbox.lock().unwrap().len(), 2);
    agents
        .team_tool(
            &run,
            "agent_events",
            &json!({}),
            "",
            &Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
    assert!(root.inbox.lock().unwrap().is_empty());
    agents.enqueue_message(&root,json!({"kind":"agent.completed","latest_cursor":1,"text":"late notification of an already-read event"})).unwrap();
    assert!(root.inbox.lock().unwrap().is_empty());
    agents.shutdown();
}
#[test]
fn filtered_reads_do_not_skip_unread_events_from_other_agents() {
    let (_dir, agents, root, run, _) = fixture();
    let (_a, a_run) = child(&agents, &root, "a");
    let (_b, b_run) = child(&agents, &root, "b");
    agents.emit_event(
        &b_run,
        json!({"type":"text","id":"b","mode":"delta","text":"B"}),
    );
    agents.emit_event(
        &a_run,
        json!({"type":"text","id":"a","mode":"delta","text":"A"}),
    );
    let token = Arc::new(AtomicBool::new(false));
    let filtered = agents
        .team_tool(&run, "agent_events", &json!({"run_id":"a"}), "", &token)
        .unwrap();
    assert_eq!(arr(&filtered["structuredContent"]["events"]).len(), 1);
    assert_eq!(root.event_cursor.load(Ordering::Acquire), 0);
    let all = agents
        .team_tool(&run, "agent_events", &json!({}), "", &token)
        .unwrap();
    assert_eq!(arr(&all["structuredContent"]["events"]).len(), 2);
    agents.shutdown();
}
type Events = Arc<Mutex<Vec<(String, Value)>>>;
fn fixture() -> (
    tempfile::TempDir,
    Arc<Agents>,
    Arc<Thread>,
    Arc<Run>,
    Events,
) {
    let dir = tempfile::tempdir().unwrap();
    let storage = Arc::new(Storage::new(
        dir.path().join("data"),
        dir.path().join("home"),
        dir.path().into(),
    ));
    let history = Arc::new(History::new(
        storage.clone(),
        dir.path().join("home/.claude/projects"),
    ));
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let log = events.clone();
    let agents = Agents::new(
        storage,
        history,
        Arc::new(move |channel, value| log.lock().unwrap().push((channel.into(), value))),
    );
    let root = agents.thread("root", "claude").unwrap();
    root.mailbox_paused.store(true, Ordering::Release);
    let run = agents.start(&root);
    run.running.store(true, Ordering::Release);
    (dir, agents, root, run, events)
}
fn child(agents: &Arc<Agents>, parent: &Arc<Thread>, id: &str) -> (Arc<Thread>, Arc<Run>) {
    let thread = Arc::new(Thread {
        id: id.into(),
        provider: Mutex::new("codex".into()),
        config: Mutex::new(json!({})),
        session: Mutex::new(String::new()),
        resume_at: Mutex::new(None),
        run: Mutex::new(None),
        lifecycle: Mutex::new(()),
        sub: Some(Sub {
            parent: parent.id.clone(),
            tool: parent
                .sub
                .as_ref()
                .map(|s| format!("{}::{id}", s.tool))
                .unwrap_or(id.into()),
            depth: parent.sub.as_ref().map(|s| s.depth + 1).unwrap_or(1),
            notify: AtomicBool::new(false),
        }),
        hidden: false,
        result: Mutex::new(Value::Null),
        wake: Condvar::new(),
        inbox: Mutex::new(VecDeque::new()),
        delivering: AtomicBool::new(false),
        closed: AtomicBool::new(false),
        mailbox_paused: AtomicBool::new(true),
        turn_sequence: AtomicU64::new(1),
        event_cursor: AtomicU64::new(0),
    });
    agents
        .threads
        .lock()
        .unwrap()
        .insert(id.into(), thread.clone());
    let run = agents.start(&thread);
    run.running.store(true, Ordering::Release);
    (thread, run)
}
#[test]
fn root_replays_all_descendant_event_types_and_nested_approvals() {
    let (_dir, agents, root, _run, events) = fixture();
    let (first, _) = child(&agents, &root, "first");
    let (nested, run) = child(&agents, &first, "nested");
    let kinds = [
        "text",
        "thinking",
        "tool",
        "tool.delta",
        "tool.output",
        "tool.result",
        "status",
        "context",
        "task",
        "notice",
        "codex.state",
    ];
    for kind in kinds {
        agents.emit_event(&run,json!({"type":kind,"id":"item","text":"nested progress","name":"Read","input":{},"final":true}));
    }
    let page = agents.collaboration.page("root", 0, None, 200).unwrap();
    let raw = arr(&page["events"]);
    for kind in kinds {
        assert!(
            raw.iter()
                .any(|e| e["run_id"] == "nested" && e["event"]["type"] == kind),
            "{kind}"
        );
    }
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .filter(|(c, _)| c == "agent:event")
        .all(|(_, e)| e["threadId"] == "root"));
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|(_, e)| e["ev"]["agent"] == "first::nested" && e["ev"]["type"] == "status"));
    let owner = agents.clone();
    let ask_run = run.clone();
    let waiting = std::thread::spawn(move || {
        owner.ask(
            &ask_run,
            "nested-permission".into(),
            json!({"toolName":"Bash","input":{"command":"fixture"}}),
        )
    });
    let start = Instant::now();
    let approval = loop {
        let req = events
            .lock()
            .unwrap()
            .iter()
            .find(|(c, _)| c == "agent:permission")
            .map(|(_, e)| e.clone());
        if let Some(req) = req {
            break req;
        }
        assert!(start.elapsed() < Duration::from_secs(2));
        std::thread::yield_now();
    };
    assert_eq!(approval["threadId"], "root");
    assert_eq!(approval["agentID"], "first::nested");
    agents.invoke("agent:respondPermission",&[json!({"threadId":"root","reqId":approval["reqId"],"decision":"allow","updatedInput":{"secret":"DO_NOT_JOURNAL"}})]).unwrap();
    assert_eq!(waiting.join().unwrap()["decision"], "allow");
    let page = agents.collaboration.page("root", 0, None, 200).unwrap();
    assert!(page.to_string().contains("permission.resolved"));
    assert!(!page.to_string().contains("DO_NOT_JOURNAL"));
    assert_eq!(agents.family_root(&nested).id, "root");
    agents.shutdown();
}
#[test]
fn event_journal_pages_replay_restart_large_unicode_and_family_isolation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite");
    let bus = Bus::new(path.clone());
    for n in 0..10000 {
        bus.append(
            "root",
            if n % 2 == 0 { "a" } else { "b" },
            json!({"event":{"type":"tool.output","chunk":n}}),
        )
        .unwrap();
    }
    bus.append("private", "foreign", json!({"private":"OTHER_CHAT"}))
        .unwrap();
    let mut cursor = 0;
    let mut count = 0;
    loop {
        let page = bus.page("root", cursor, None, 73).unwrap();
        for row in arr(&page["events"]) {
            assert!(row["seq"].as_u64().unwrap() > cursor);
            cursor = row["seq"].as_u64().unwrap();
            count += 1;
        }
        if page["has_more"] == false {
            break;
        }
    }
    assert_eq!(count, 10000);
    assert_eq!(cursor, 10000);
    let body = json!({"event":{"text":"Привет 🌍".repeat(20000)}});
    let expected = body.to_string();
    let seq = bus.append("root", "a", body).unwrap();
    drop(bus);
    let bus = Bus::new(path);
    let page = bus.page("root", 10000, None, 200).unwrap();
    assert_eq!(arr(&page["events"]).len(), 1);
    assert_eq!(page["events"][0]["large_event"], true);
    assert!(bus.detail("root", 10001, 0, 65536).is_err());
    let mut text = String::new();
    let mut offset = 0;
    loop {
        let detail = bus.detail("root", seq, offset, 65536).unwrap();
        text.push_str(detail["text"].as_str().unwrap());
        let Some(next) = detail["next_offset"].as_u64() else {
            break;
        };
        offset = next as usize;
    }
    assert_eq!(text, expected);
    assert_eq!(
        arr(&bus.page("root", 0, Some("a"), 200).unwrap()["events"]).len(),
        200
    );
}
#[test]
fn messages_are_bidirectional_family_scoped_and_stop_is_recursive() {
    let (_dir, agents, root, root_run, _) = fixture();
    let (a, a_run) = child(&agents, &root, "a");
    let (b, b_run) = child(&agents, &root, "b");
    let (nested, nested_run) = child(&agents, &a, "nested");
    agents.thread("outsider", "claude").unwrap();
    let token = Arc::new(AtomicBool::new(false));
    for target in ["parent", "root", "b"] {
        let result = agents
            .team_tool(
                &a_run,
                "message_agent",
                &json!({"run_id":target,"message":format!("hello {target}")}),
                "",
                &token,
            )
            .unwrap();
        assert_eq!(result["structuredContent"]["status"], "queued");
    }
    assert_eq!(root.inbox.lock().unwrap().len(), 2);
    assert_eq!(b.inbox.lock().unwrap().len(), 1);
    assert!(agents
        .team_tool(
            &a_run,
            "message_agent",
            &json!({"run_id":"outsider","message":"no"}),
            "",
            &token
        )
        .is_err());
    assert!(agents
        .team_tool(
            &a_run,
            "wait_agent",
            &json!({"run_id":"parent","timeout_sec":0}),
            "",
            &token
        )
        .is_err());
    assert!(agents
        .team_tool(&a_run, "stop_agent", &json!({"run_id":"b"}), "", &token)
        .is_err());
    agents
        .team_tool(&root_run, "stop_agent", &json!({"run_id":"a"}), "", &token)
        .unwrap();
    assert!(!Agents::current(&a_run));
    assert!(!Agents::current(&nested_run));
    assert!(Agents::current(&b_run));
    assert!(Agents::current(&root_run));
    assert_eq!(state(&a), "stopped");
    assert!(nested.inbox.lock().unwrap().is_empty());
    agents.shutdown();
}
#[test]
fn cancelled_waits_keep_children_alive_after_parent_turn_finishes() {
    let (_dir, agents, root, run, _) = fixture();
    let (child, child_run) = child(&agents, &root, "child");
    let token = Arc::new(AtomicBool::new(false));
    let owner = agents.clone();
    let caller = run.clone();
    let cancelled = token.clone();
    let target = child.clone();
    let worker = std::thread::spawn(move || {
        owner
            .wait_team(&caller, &[target], Duration::from_secs(60), &cancelled)
            .unwrap()
    });
    run.running.store(false, Ordering::Release);
    std::thread::sleep(Duration::from_millis(10));
    assert!(Agents::current(&child_run));
    let start = Instant::now();
    token.store(true, Ordering::Release);
    agents.collaboration.wake();
    assert_eq!(
        worker.join().unwrap()["structuredContent"]["status"],
        "cancelled"
    );
    assert!(start.elapsed() < Duration::from_secs(1));
    assert!(Agents::current(&child_run));
    agents.shutdown();
}
#[test]
fn completion_notifies_once_and_wait_retains_result_when_next_turn_starts() {
    let (_dir, agents, root, run, _) = fixture();
    let (child, child_run) = child(&agents, &root, "child");
    child
        .sub
        .as_ref()
        .unwrap()
        .notify
        .store(true, Ordering::Release);
    let owner = agents.clone();
    let caller = run.clone();
    let target = child.clone();
    let worker = std::thread::spawn(move || {
        owner
            .wait_team(
                &caller,
                &[target],
                Duration::from_secs(2),
                &AtomicBool::new(false),
            )
            .unwrap()
    });
    std::thread::sleep(Duration::from_millis(20));
    agents.emit_event(
        &child_run,
        json!({"type":"turn.end","text":"first result","isError":false}),
    );
    child.turn_sequence.store(2, Ordering::Release);
    child_run.running.store(true, Ordering::Release);
    agents.collaboration.wake();
    let reply = worker.join().unwrap();
    assert_eq!(reply["structuredContent"]["text"], "first result");
    assert_eq!(reply["structuredContent"]["status"], "done");
    agents.notify_completion(&child, None);
    assert_eq!(root.inbox.lock().unwrap().len(), 1);
    assert!(Agents::current(&child_run));
    agents.shutdown();
}
#[test]
fn cancellation_before_worker_registration_and_nested_mcp_alias_are_honored() {
    let (_dir, agents, _root, run, _) = fixture();
    agents.cancel(&run, Some("mcp:42"));
    let request = Request::new(&run, vec!["claude:outer".into(), "mcp:42".into()]);
    assert!(request.cancelled.load(Ordering::Acquire));
    drop(request);
    let next = Request::new(&run, vec!["claude:outer".into(), "mcp:42".into()]);
    assert!(!next.cancelled.load(Ordering::Acquire));
    agents.cancel(&run, Some("claude:outer"));
    assert!(next.cancelled.load(Ordering::Acquire));
    drop(next);
    assert!(run.requests.lock().unwrap().is_empty());
    agents.shutdown();
}
#[test]
fn completion_bursts_keep_a_bounded_wakeup_even_when_mailbox_is_full() {
    let (_dir, agents, root, _run, _) = fixture();
    for n in 0..128 {
        agents
            .enqueue_message(&root, json!({"id":n,"kind":"message","text":"busy"}))
            .unwrap();
    }
    for n in 0..1000 {
        agents
            .enqueue_message(
                &root,
                json!({"kind":"agent.completed","latest_cursor":n,"text":"answer"}),
            )
            .unwrap();
    }
    let inbox = root.inbox.lock().unwrap();
    assert_eq!(inbox.len(), 129);
    assert_eq!(inbox.back().unwrap()["kind"], "agent.events_available");
    assert_eq!(inbox.back().unwrap()["latest_cursor"], 999);
    drop(inbox);
    agents.shutdown();
}
#[test]
fn nested_completion_clears_parent_liveness_marks_and_restart_sets_running() {
    let (_dir, agents, root, run, events) = fixture();
    let (a, a_run) = child(&agents, &root, "a");
    let (nested, nested_run) = child(&agents, &a, "nested");
    agents.team_running(&a);
    agents.team_running(&nested);
    assert!(run.background.lock().unwrap().contains("agent:a"));
    assert!(a_run.background.lock().unwrap().contains("agent:nested"));
    agents.emit_event(&nested_run, json!({"type":"turn.end","text":"nested done"}));
    assert!(!a_run.background.lock().unwrap().contains("agent:nested"));
    agents.emit_event(&a_run, json!({"type":"turn.end","text":"parent done"}));
    assert!(!run.background.lock().unwrap().contains("agent:a"));
    agents.team_running(&a);
    assert!(run.background.lock().unwrap().contains("agent:a"));
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|(_, e)| e["ev"]["runId"] == "a" && e["ev"]["status"] == "running"));
    agents.shutdown();
}
