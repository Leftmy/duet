use super::*;
use crate::core::history::History;
use std::sync::Weak;

#[derive(Default)]
struct Native {
    live: HashMap<String, String>,
    probes: HashMap<String, Value>,
    calls: Vec<Value>,
    fail_probe: bool,
}
struct Fixture {
    _dir: tempfile::TempDir,
    browser: Arc<Browsers>,
    native: Arc<Mutex<Native>>,
}
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let storage = Arc::new(Storage::new(
        dir.path().join("data"),
        dir.path().join("home"),
        dir.path().into(),
    ));
    let history = Arc::new(History::new(
        storage.clone(),
        dir.path().join("transcripts"),
    ));
    let agents = Agents::new(storage.clone(), history, Arc::new(|_, _| {}));
    let browser = Arc::new(Browsers::new(storage, agents.clone(), Arc::new(|_, _| {})));
    let native = Arc::new(Mutex::new(Native::default()));
    let log = native.clone();
    let weak: Weak<Browsers> = Arc::downgrade(&browser);
    agents.set_host(Arc::new(move|method,p|{
        let id=s(&p,"id"); let op=s(&p,"op");
        let mut n=log.lock().unwrap(); n.calls.push(json!({"method":method,"p":p}));
        if method=="window.create"{n.live.insert(id.into(),"about:blank".into());}
        if op=="probe"{if n.fail_probe{return Err("Page did not respond; sleep skipped".into());}return Ok(n.probes.get(id).cloned().unwrap_or(json!({"url":n.live[id],"title":"Test page","x":0,"y":123,"dirty":false,"media":false})));}
        if op=="navigate"{let url=s(&p,"url").to_string();n.live.insert(id.into(),url.clone());drop(n);if let Some(b)=weak.upgrade(){b.native_event(id,"state",&json!({"url":url,"title":"Test page","loading":false}));}return Ok(Value::Null);}
        if op=="close"{n.live.remove(id);drop(n);if let Some(b)=weak.upgrade(){b.native_event(id,"closed",&Value::Null);}return Ok(Value::Null);}
        if op=="eval"{return Ok(json!({"url":n.live[id],"text":"fixture"}));}
        if op=="capture"{return Ok(json!({"png":"iVBORfixture"}));}
        Ok(Value::Null)
    }));
    Fixture {
        _dir: dir,
        browser,
        native,
    }
}
fn new(b: &Browsers, key: &str, url: &str) -> String {
    s(&b.new_tab(key, url, false).unwrap(), "createdTabId").into()
}
fn label(b: &Browsers, key: &str, id: &str) -> String {
    b.find(key, Some(id))
        .unwrap()
        .data
        .lock()
        .unwrap()
        .label
        .clone()
        .unwrap()
}
fn stale(b: &Browsers, key: &str, id: &str) {
    let tab = b.find(key, Some(id)).unwrap();
    let mut p = tab.data.lock().unwrap();
    p.used = 1;
    p.hidden = 1;
}

#[test]
fn tabs_keep_independent_urls_and_history_and_reject_cross_chat_ids() {
    let f = fixture();
    let b = &f.browser;
    let a = new(b, "one", "https://example.org/a");
    let c = new(b, "one", "https://example.org/c");
    b.tool(
        &json!({"threadId":"one","action":"navigate","tab_id":a,"url":"https://example.org/a2"}),
    )
    .unwrap();
    assert_eq!(b.state("one")["activeTabId"], c);
    assert_eq!(b.state("one")["url"], "https://example.org/c");
    assert_eq!(
        b.tool(&json!({"threadId":"one","action":"read","tab_id":a}))
            .unwrap()["url"],
        "https://example.org/a2"
    );
    b.control("one", &json!({"action":"back","tabId":a}))
        .unwrap();
    assert_eq!(
        b.find("one", Some(&a)).unwrap().state()["url"],
        "https://example.org/a"
    );
    assert!(b
        .tool(&json!({"threadId":"two","action":"read","tab_id":a}))
        .is_err());
}
#[test]
fn sleep_releases_native_page_and_wake_has_a_new_generation_and_scroll() {
    let f = fixture();
    let b = &f.browser;
    let id = new(b, "one", "https://example.org/a");
    let old = label(b, "one", &id);
    b.control("one", &json!({"action":"sleep-tab","tabId":id}))
        .unwrap();
    assert!(f.native.lock().unwrap().live.is_empty());
    assert_eq!(b.state("one")["sleeping"], true);
    b.invoke("browser:setVisible", &[json!(true), json!("one")])
        .unwrap();
    assert!(
        f.native.lock().unwrap().live.is_empty(),
        "manual sleep stays asleep when revealing the panel"
    );
    b.select("one", &id).unwrap();
    assert_ne!(label(b, "one", &id), old);
    assert!(!b.native_event(&old, "closed", &Value::Null));
    assert!(!b.native_event(&old, "state", &json!({"url":"https://stale.invalid/"})));
    assert_eq!(b.state("one")["url"], "https://example.org/a");
    assert!(f
        .native
        .lock()
        .unwrap()
        .calls
        .iter()
        .any(|c| c["p"]["op"] == "execute" && s(&c["p"], "code").contains("123")));
}
#[test]
fn input_media_download_and_unresponsive_pages_are_not_discarded_implicitly() {
    let f = fixture();
    let b = &f.browser;
    let id = new(b, "one", "https://example.org/");
    let l = label(b, "one", &id);
    for flag in ["dirty", "media"] {
        f.native.lock().unwrap().probes.insert(
            l.clone(),
            json!({"dirty":flag=="dirty","media":flag=="media"}),
        );
        assert!(b
            .control("one", &json!({"action":"sleep-tab","tabId":id}))
            .is_err());
        assert!(f.native.lock().unwrap().live.contains_key(&l));
    }
    f.native.lock().unwrap().probes.clear();
    b.native_event(&l, "download", &json!({"active":true}));
    assert!(b
        .control("one", &json!({"action":"sleep-tab","tabId":id}))
        .is_err());
    b.native_event(&l, "download", &json!({"active":false}));
    f.native.lock().unwrap().fail_probe = true;
    assert!(b
        .control("one", &json!({"action":"sleep-tab","tabId":id}))
        .is_err());
    b.control(
        "one",
        &json!({"action":"sleep-tab","tabId":id,"force":true}),
    )
    .unwrap();
    assert!(f.native.lock().unwrap().live.is_empty());
}
#[test]
fn automatic_sleep_preserves_visible_pinned_and_busy_tabs_and_can_be_disabled() {
    let f = fixture();
    let b = &f.browser;
    let pinned = new(b, "one", "https://example.org/pin");
    b.control(
        "one",
        &json!({"action":"pin-tab","tabId":pinned,"pinned":true}),
    )
    .unwrap();
    let busy = new(b, "one", "https://example.org/busy");
    let clean = new(b, "one", "https://example.org/clean");
    let visible = new(b, "one", "https://example.org/visible");
    b.invoke("browser:setVisible", &[json!(true), json!("one")])
        .unwrap();
    for id in [&pinned, &busy, &clean, &visible] {
        stale(b, "one", id);
    }
    let busy_tab = b.find("one", Some(&busy)).unwrap();
    let _operation = busy_tab.operation.lock().unwrap();
    b.storage.set_ui(&json!({"browserIdleMinutes":0})).unwrap();
    b.maintain();
    assert_eq!(f.native.lock().unwrap().live.len(), 4);
    b.storage.set_ui(&json!({"browserIdleMinutes":1})).unwrap();
    b.maintain();
    assert_eq!(
        b.find("one", Some(&clean)).unwrap().state()["sleeping"],
        true
    );
    assert_eq!(f.native.lock().unwrap().live.len(), 3);
    assert_eq!(
        b.find("one", Some(&visible)).unwrap().state()["sleeping"],
        false
    );
}
#[test]
fn inactive_sleep_skips_form_and_pin_and_manual_close_selects_and_wakes_neighbor() {
    let f = fixture();
    let b = &f.browser;
    let a = new(b, "one", "https://example.org/a");
    let c = new(b, "one", "https://example.org/c");
    b.invoke("browser:setVisible", &[json!(true), json!("one")])
        .unwrap();
    // Opening the browser options temporarily hides its native page.
    b.invoke("browser:setVisible", &[json!(false), json!("one")])
        .unwrap();
    let report = b
        .control("one", &json!({"action":"sleep-inactive"}))
        .unwrap();
    assert_eq!(report["sleepReport"]["slept"], 1);
    assert_eq!(b.find("one", Some(&c)).unwrap().state()["sleeping"], false);
    assert_eq!(b.find("one", Some(&a)).unwrap().state()["sleeping"], true);
    b.close_tab("one", &c, false).unwrap();
    assert_eq!(b.state("one")["activeTabId"], a);
    assert_eq!(b.state("one")["sleeping"], false);
    b.close_tab("one", &a, false).unwrap();
    let current = b.state("one");
    let id = s(&current, "activeTabId").to_string();
    b.close_tab("one", &id, false).unwrap();
    assert_eq!(b.state("one")["url"], "about:blank");
    assert_eq!(arr(&b.state("one")["tabs"]).len(), 1);
}
#[test]
fn popup_creates_tab_and_background_metadata_does_not_create_webview() {
    let f = fixture();
    let b = &f.browser;
    let a = new(b, "one", "https://example.org/a");
    let l = label(b, "one", &a);
    b.native_event(&l, "popup", &json!({"url":"https://example.org/popup"}));
    assert_eq!(b.state("one")["url"], "https://example.org/popup");
    assert_eq!(
        b.find("one", Some(&a)).unwrap().state()["url"],
        "https://example.org/a"
    );
    let count = f.native.lock().unwrap().live.len();
    b.new_tab("one", "https://example.org/background", true)
        .unwrap();
    assert_eq!(f.native.lock().unwrap().live.len(), count);
    assert!(b.new_tab("one", "javascript:alert(1)", false).is_err());
}
#[test]
fn pressure_discards_lru_clean_pages_and_respects_hard_live_and_tab_limits() {
    let f = fixture();
    let b = &f.browser;
    for n in 0..12 {
        new(b, "one", &format!("https://example.org/{n}"));
    }
    assert_eq!(f.native.lock().unwrap().live.len(), SOFT_LIVE);
    b.storage.set_ui(&json!({"browserIdleMinutes":0})).unwrap();
    for n in 0..24 {
        b.new_tab("two", &format!("https://example.org/second{n}"), false)
            .unwrap();
    }
    assert_eq!(f.native.lock().unwrap().live.len(), HARD_LIVE);
    assert!(b
        .new_tab("two", "https://example.org/limit", false)
        .is_err());
    for _ in 0..40 {
        let _ = b.new_tab("one", "about:blank", true);
    }
    assert_eq!(arr(&b.state("one")["tabs"]).len(), MAX_TABS);
}
#[test]
fn restart_restores_tab_metadata_without_launching_pages_or_storing_form_values() {
    let f = fixture();
    let b = &f.browser;
    let id = new(b, "one", "https://example.org/saved");
    b.control("one", &json!({"action":"pin-tab","tabId":id,"pinned":true}))
        .unwrap();
    b.flush();
    let saved = b.storage.read("native/browser-tabs.json");
    assert!(!saved.to_string().contains("input"));
    let restored = Browsers::new(b.storage.clone(), b.agents.clone(), Arc::new(|_, _| {}));
    restored.ensure_space("one").unwrap();
    let state = restored.state("one");
    assert_eq!(state["activeTabId"], id);
    assert_eq!(state["url"], "https://example.org/saved");
    assert_eq!(state["sleeping"], true);
    assert_eq!(state["pinned"], true);
    assert_eq!(f.native.lock().unwrap().live.len(), 1);
}
#[test]
fn delayed_blank_load_events_and_stale_panel_cleanup_cannot_replace_current_page() {
    let f = fixture();
    let b = &f.browser;
    let id = new(b, "one", "https://example.org/");
    let l = label(b, "one", &id);
    b.native_event(
        &l,
        "state",
        &json!({"url":"about:blank","navigationUrl":"about:blank","loading":false}),
    );
    assert_eq!(b.state("one")["url"], "https://example.org/");
    b.invoke("browser:setVisible", &[json!(true), json!("one")])
        .unwrap();
    b.invoke("browser:setVisible", &[json!(false), json!("old-chat")])
        .unwrap();
    assert!(b.active.lock().unwrap().visible);
}
#[test]
fn native_page_calls_do_not_hold_the_global_host_registry() {
    let f = fixture();
    let agents = f.browser.agents.clone();
    let weak = Arc::downgrade(&agents);
    agents.set_host(Arc::new(move |_, _| {
        assert!(weak.upgrade().unwrap().host.try_lock().is_ok());
        Ok(Value::Null)
    }));
    agents.host("test", Value::Null).unwrap();
}
