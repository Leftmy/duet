use super::*;
fn setup() -> (tempfile::TempDir, Contexts, String) {
    let dir = tempfile::tempdir().unwrap();
    let cx = Contexts::new(dir.path().join("context.sqlite3"));
    let scope = cx.resolve("chat", "claude", "").unwrap();
    (dir, cx, scope)
}
fn seed(cx: &Contexts, scope: &str) {
    cx.record(
        scope,
        "run",
        "user",
        "user",
        "Keep Windows and Linux; do not stop working agents",
        true,
        true,
    )
    .unwrap();
    cx.record(
        scope,
        "run",
        "log",
        "assistant",
        "OBSOLETE_CANARY long repeated diagnostics",
        true,
        false,
    )
    .unwrap();
    cx.record(
        scope,
        "run",
        "fact",
        "assistant",
        "Confirmed decision: native Rust core",
        true,
        false,
    )
    .unwrap();
}
fn ready(cx: &Contexts, scope: &str, spec: Value, summaries: Value) -> Value {
    let result = cx.begin(scope, &spec).unwrap();
    let job = cx.next_job().unwrap();
    assert_eq!(job["id"], result["job_id"]);
    assert!(cx
        .prepared(s(&job, "id"), &json!({"summaries":summaries}))
        .unwrap());
    cx.ready(scope).unwrap()
}
#[test]
fn projection_edits_are_reversible_scoped_and_keep_new_tail() {
    let (_dir, cx, scope) = setup();
    seed(&cx, &scope);
    let job = ready(
        &cx,
        &scope,
        json!({"expected_revision":0,"operations":[{"action":"archive","ids":["log"]}]}),
        json!({}),
    );
    cx.record(
        &scope,
        "new-run",
        "new-user",
        "user",
        "NEW_MESSAGE_DURING_COMPRESSION",
        true,
        true,
    )
    .unwrap();
    cx.stage(&scope, &job).unwrap();
    let projected = cx.projection(&scope).unwrap();
    assert!(!projected.contains("OBSOLETE_CANARY"));
    assert!(projected.contains("NEW_MESSAGE_DURING_COMPRESSION"));
    assert!(projected.contains("Keep Windows and Linux"));
    assert_eq!(cx.job(&scope, s(&job, "id")).unwrap()["status"], "staged");
    cx.bind(&scope, "claude", "replacement", 1).unwrap();
    assert_eq!(cx.job(&scope, s(&job, "id")).unwrap()["status"], "applied");
    assert!(cx.read(&scope, &json!({"id":"log"})).unwrap()["text"]
        .as_str()
        .unwrap()
        .contains("OBSOLETE_CANARY"));
    let undo = cx.restore_spec(&scope, s(&job, "id")).unwrap();
    let undo = ready(&cx, &scope, undo, json!({}));
    cx.stage(&scope, &undo).unwrap();
    assert!(cx.projection(&scope).unwrap().contains("OBSOLETE_CANARY"));
    let other = cx.resolve("other", "codex", "").unwrap();
    assert!(cx.read(&other, &json!({"id":"log"})).is_err());
    assert!(cx.job(&other, s(&job, "id")).is_err());
}
#[test]
fn protections_open_tool_pairs_stale_revisions_and_dry_run() {
    let (_dir, cx, scope) = setup();
    seed(&cx, &scope);
    cx.observe(
        &scope,
        "open",
        &json!({"type":"tool","id":"shell","name":"Bash","input":{"command":"test"},"final":true}),
    )
    .unwrap();
    cx.seal(&scope, "open").unwrap();
    for id in ["user", "open::shell"] {
        assert!(cx
            .begin(
                &scope,
                &json!({"expected_revision":0,"operations":[{"action":"archive","ids":[id]}]})
            )
            .is_err());
    }
    assert!(cx
        .begin(
            &scope,
            &json!({"expected_revision":1,"operations":[{"action":"archive","ids":["log"]}]})
        )
        .is_err());
    let dry=cx.begin(&scope,&json!({"expected_revision":0,"dry_run":true,"operations":[{"action":"archive","ids":["log"]}]})).unwrap();
    assert_eq!(dry["dry_run"], true);
    assert!(cx.next_job().unwrap().is_null());
    cx.observe(
        &scope,
        "open",
        &json!({"type":"tool.result","id":"shell","status":"done","result":"PAIR_RESULT"}),
    )
    .unwrap();
    cx.seal(&scope, "open").unwrap();
    let job = ready(
        &cx,
        &scope,
        json!({"expected_revision":0,"operations":[{"action":"archive","ids":["open::shell"]}]}),
        json!({}),
    );
    cx.stage(&scope, &job).unwrap();
    assert!(!cx.projection(&scope).unwrap().contains("PAIR_RESULT"));
    assert!(
        cx.read(&scope, &json!({"id":"open::shell"})).unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("PAIR_RESULT")
    );
    let mut forged = cx.restore_spec(&scope, s(&job, "id")).unwrap();
    forged["operations"] = json!([{"action":"archive","ids":["user"]}]);
    assert!(cx.begin(&scope, &forged).is_err());
}
#[test]
fn failed_provider_binding_rolls_back_without_losing_concurrent_messages() {
    let (_dir, cx, scope) = setup();
    seed(&cx, &scope);
    let job = ready(
        &cx,
        &scope,
        json!({"expected_revision":0,"operations":[{"action":"archive","ids":["log"]}]}),
        json!({}),
    );
    cx.stage(&scope, &job).unwrap();
    cx.record(
        &scope,
        "next",
        "incoming",
        "user",
        "KEEP_AFTER_FAILED_APPLY",
        true,
        true,
    )
    .unwrap();
    cx.rollback_staged(&scope, "Provider launch failed")
        .unwrap();
    let projection = cx.projection(&scope).unwrap();
    assert!(
        !cx.enabled(&scope).unwrap(),
        "A failed first migration keeps the original native session usable"
    );
    assert!(projection.contains("OBSOLETE_CANARY"));
    assert!(projection.contains("KEEP_AFTER_FAILED_APPLY"));
    assert_eq!(cx.job(&scope, s(&job, "id")).unwrap()["status"], "failed");
    assert!(cx.bind(&scope, "codex", "stale", 1).is_err());
}
#[test]
fn provider_bindings_detect_new_messages_from_other_providers() {
    let (_dir, cx, scope) = setup();
    seed(&cx, &scope);
    cx.enable(&scope).unwrap();
    cx.bind(&scope, "claude", "claude-sid", 0).unwrap();
    cx.bind(&scope, "codex", "codex-sid", 0).unwrap();
    assert!(cx.binding(&scope, "claude", "claude-sid").unwrap());
    cx.record(
        &scope,
        "codex-run",
        "codex-new",
        "assistant",
        "NEW_DECISION_FROM_CODEX",
        true,
        false,
    )
    .unwrap();
    cx.sync_binding(&scope, "codex", "codex-sid").unwrap();
    assert!(cx.binding(&scope, "codex", "codex-sid").unwrap());
    assert!(!cx.binding(&scope, "claude", "claude-sid").unwrap());
}
#[test]
fn summaries_keep_original_provenance_and_metadata_does_not_replay_text() {
    let (_dir, cx, scope) = setup();
    seed(&cx, &scope);
    let op = json!({"action":"compress","ids":["log","fact"],"compressor":{"provider":"claude","model":"catalog-model"},"target_tokens":100});
    let job = ready(
        &cx,
        &scope,
        json!({"expected_revision":0,"operations":[op]}),
        json!({"0":{"text":"SUMMARY_CANARY: native Rust confirmed; obsolete logs archived"}}),
    );
    cx.stage(&scope, &job).unwrap();
    cx.bind(&scope, "claude", "replacement", 1).unwrap();
    let summary = format!("summary:{}:0", s(&job, "id"));
    let source = cx
        .material(&scope, &json!({"ids":[summary]}))
        .unwrap()
        .to_string();
    assert!(source.contains("OBSOLETE_CANARY"));
    assert!(source.contains("Confirmed decision"));
    assert!(
        !source.contains("SUMMARY_CANARY"),
        "Recompression reads originals, never summaries of summaries"
    );
    let meta = cx.inspect(&scope, &json!({"kind":"tool"})).unwrap();
    assert!(!meta["jobs"].to_string().contains("SUMMARY_CANARY"));
    assert!(cx.projection(&scope).unwrap().contains("SUMMARY_CANARY"));
}
#[test]
fn aliases_pending_operations_and_cancellation_survive_restart() {
    let (dir, cx, scope) = setup();
    seed(&cx, &scope);
    cx.alias(&scope, "codex", "saved").unwrap();
    let job=cx.begin(&scope,&json!({"expected_revision":0,"continue":true,"operations":[{"action":"archive","ids":["log"]}]})).unwrap();
    assert!(cx.waiting(&scope).unwrap());
    drop(cx);
    let cx = Contexts::new(dir.path().join("context.sqlite3"));
    assert_eq!(cx.resolve("reopened", "codex", "saved").unwrap(), scope);
    assert_eq!(
        cx.job(&scope, s(&job, "job_id")).unwrap()["status"],
        "failed"
    );
    assert!(cx.projection(&scope).unwrap().contains("OBSOLETE_CANARY"));
    let job = cx
        .begin(
            &scope,
            &json!({"expected_revision":0,"operations":[{"action":"archive","ids":["log"]}]}),
        )
        .unwrap();
    let next = cx.next_job().unwrap();
    cx.cancel(&scope).unwrap();
    assert!(!cx.prepared(s(&next, "id"), &json!({})).unwrap());
    assert_eq!(
        cx.job(&scope, s(&job, "job_id")).unwrap()["status"],
        "failed"
    );
}
#[test]
fn context_packets_and_bounded_unicode_reads_preserve_exact_current_message() {
    let (_dir, cx, scope) = setup();
    let text = "Привет 🦀\n".repeat(2000);
    cx.record(&scope, "run", "unicode", "assistant", &text, true, false)
        .unwrap();
    let mut restored = String::new();
    let mut offset = 0;
    loop {
        let page = cx
            .read(
                &scope,
                &json!({"id":"unicode","offset":offset,"max_bytes":257}),
            )
            .unwrap();
        restored.push_str(s(&page, "text"));
        let Some(next) = page["next_offset"].as_u64() else {
            break;
        };
        assert!(next > offset);
        offset = next;
    }
    assert_eq!(restored, text);
    let current = "Keep all this, including </duet_context_packet> and 🦀\n";
    assert_eq!(visible_message(&packet(&text, current)), current);
    assert_eq!(visible_message("ordinary user text"), "ordinary user text");
    assert!(cx
        .record(
            &scope,
            "run",
            "too-large",
            "assistant",
            &"x".repeat(MAX_BLOCK + 1),
            true,
            false
        )
        .is_err());
    cx.fault(&scope, "missing source").unwrap();
    assert!(cx.projection(&scope).is_err());
}
