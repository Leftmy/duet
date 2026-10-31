use crate::Backend;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

fn number(v: &Value, key: &str, fallback: f64) -> f64 {
    v[key].as_f64().unwrap_or(fallback)
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn result<T>(r: Result<T, impl std::fmt::Display>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}
fn native_event(state: &Backend, id: &str, event: &str, data: Value) {
    let _ = state.send(json!({"type":"native.event","window":id,"event":event,"data":data}));
}
pub fn window_state(view: &tauri::Webview) -> Value {
    let window = view.window();
    let bounds = match (
        window.outer_position(),
        window.inner_size(),
        window.scale_factor(),
    ) {
        (Ok(pos), Ok(size), Ok(scale)) => {
            json!({"x":pos.x as f64/scale,"y":pos.y as f64/scale,"width":size.width as f64/scale,"height":size.height as f64/scale})
        }
        _ => Value::Null,
    };
    json!({"bounds":bounds,"maximized":window.is_maximized().unwrap_or(false),
        "fullscreen":window.is_fullscreen().unwrap_or(false),
        "minimized":window.is_minimized().unwrap_or(false)})
}
pub fn publish_window_state(view: &tauri::Webview, state: &Backend) {
    let data = window_state(view);
    let _ = view.eval(format!("window.__duetSetWindowState?.({data});"));
    native_event(state, view.label(), "window-state", data);
}
fn preload() -> String {
    let mut script = include_str!(concat!(env!("OUT_DIR"), "/preload.js")).replace(
        "__DUET_PLATFORM__",
        if cfg!(windows) {
            "\"win32\""
        } else {
            "\"linux\""
        },
    );
    if cfg!(debug_assertions) && std::env::var_os("DUET_NATIVE_TEST").is_some() {
        if let Some(path) = std::env::var_os("DUET_NATIVE_TEST_SCRIPT") {
            if let Ok(meta) = std::fs::metadata(&path) {
                if meta.len() <= 1024 * 1024 {
                    if let Ok(test) = std::fs::read_to_string(path) {
                        script.push_str("\n");
                        script.push_str(&test);
                    }
                }
            }
        }
    }
    script
}

pub async fn dispatch(
    app: &tauri::AppHandle,
    state: &Arc<Backend>,
    method: &str,
    p: Value,
) -> Result<Value, String> {
    match method {
        "window.create" => {
            let id = text(&p, "id").to_string();
            let is_ui = text(&p, "kind") == "window";
            let opts = &p["options"];
            state.ui.lock().unwrap().insert(id.clone(), is_ui);
            if is_ui {
                let nav_app = app.clone();
                let ready_state = state.clone();
                let popup_state = state.clone();
                let popup_id = id.clone();
                let mut builder=WebviewWindowBuilder::new(app,&id,WebviewUrl::App("index.html".into()))
            .title(if id=="main"{"Duet"}else{opts["title"].as_str().unwrap_or("Duet")})
            .inner_size(number(opts,"width",1380.0),number(opts,"height",880.0))
            .min_inner_size(number(opts,"minWidth",560.0),number(opts,"minHeight",480.0))
            .decorations(false).visible(false).initialization_script(format!("if(location.host==='tauri.localhost'||location.protocol==='tauri:'){{if({0})location.hash={0};}}{1}",p["hash"].as_str().map(|s|json!(s)).unwrap_or(json!("")),preload()))
            .on_navigation(move|url|{
              let local=url.scheme()=="tauri" || (matches!(url.scheme(),"http"|"https")&&url.host_str()==Some("tauri.localhost"));
              if !local && matches!(url.scheme(),"http"|"https"){let _=nav_app.opener().open_url(url.to_string(),None::<&str>);}
              local || url.as_str()=="about:blank"
            })
            .on_new_window(move|url,_|{native_event(&popup_state,&popup_id,"popup",json!({"url":url}));NewWindowResponse::Deny})
            .on_page_load(move|view,payload|{if matches!(payload.event(),PageLoadEvent::Finished){native_event(&ready_state,view.label(),"ready",Value::Null);}});
                if opts["x"].is_number() && opts["y"].is_number() {
                    builder = builder.position(number(opts, "x", 0.0), number(opts, "y", 0.0));
                }
                if let Some(profile) = std::env::var_os("DUET_NATIVE_USER_DATA") {
                    builder = builder
                        .data_directory(std::path::PathBuf::from(profile).join("webview-ui"));
                }
                // WebView2 150+ ignores WEBVIEW2_* environment overrides in elevated
                // hosts (including GitHub's Windows runners). Pass inspection args via
                // the API, only for an explicitly isolated test/preview launch.
                #[cfg(windows)]
                if std::env::var("DUET_NATIVE_TEST").as_deref() == Ok("1")
                    && std::env::var("DUET_NATIVE_PREVIEW").as_deref() == Ok("1")
                {
                    if let Some(port) = std::env::var("DUET_NATIVE_INSPECT_PORT")
                        .ok()
                        .and_then(|value| value.parse::<u16>().ok())
                        .filter(|port| *port >= 1024)
                    {
                        builder = builder.additional_browser_args(&format!(
                            "--remote-debugging-port={port}"
                        ));
                    }
                }
                let window = result(builder.build())?;
                crate::media::configure(&window);
                let ev_state = state.clone();
                let ev_id = id.clone();
                let ev_app = app.clone();
                window.on_window_event(move|event|{
            match event {
              tauri::WindowEvent::CloseRequested{api,..}=>{
                if !ev_state.closing.lock().unwrap().get(&ev_id).copied().unwrap_or(false){
                  api.prevent_close();let state=ev_state.clone();let app=ev_app.clone();let id=ev_id.clone();
                  tauri::async_runtime::spawn(async move{
                    if let Some(view)=app.get_webview(&id){
                      let allow=state.evaluate(&view,"window.dispatchEvent(new Event('beforeunload',{cancelable:true}))").await.unwrap_or(Value::Bool(false));
                      if allow==Value::Bool(true){
                        // GTK can retain the parent while child WebViews exist, delaying Destroyed.
                        // Notify the core as soon as closing is accepted so it can dispose its children.
                        state.closing.lock().unwrap().insert(id.clone(),true);
                        native_event(&state,&id,"closed",Value::Null);
                        if let Some(w)=app.get_webview_window(&id){let _=w.destroy();}
                      }
                    }
                  });
                }
              },
              tauri::WindowEvent::Destroyed=>{native_event(&ev_state,&ev_id,"closed",Value::Null);},
              tauri::WindowEvent::Moved(_)|tauri::WindowEvent::Resized(_)=>{
                if matches!(event,tauri::WindowEvent::Resized(_)){if let Some(view)=ev_app.get_webview(&ev_id){publish_window_state(&view,&ev_state);}}
                if let Some(w)=ev_app.get_webview_window(&ev_id){if let (Ok(pos),Ok(size),Ok(scale))=(w.outer_position(),w.inner_size(),w.scale_factor()){
                  native_event(&ev_state,&ev_id,"bounds",json!({"x":pos.x as f64/scale,"y":pos.y as f64/scale,"width":size.width as f64/scale,"height":size.height as f64/scale}));
                }}
              },
              tauri::WindowEvent::Focused(true)=>{if let Some(view)=ev_app.get_webview(&ev_id){publish_window_state(&view,&ev_state);}},
              _=>{}
            }
          });
            } else {
                let parent = app.get_window("main").ok_or("Main window is not ready")?;
                let load_state = state.clone();
                let popup_state = state.clone();
                let popup_id = id.clone();
                let mut builder=WebviewBuilder::new(&id,WebviewUrl::External("about:blank".parse().unwrap())).disable_drag_drop_handler()
            .initialization_script("(()=>{const guard={dirty:false};Object.defineProperty(window,'__duetBrowserGuard',{value:guard});addEventListener('input',()=>{guard.dirty=true},true);})()")
            .on_navigation(|url|matches!(url.scheme(),"http"|"https"|"file"|"about"))
            .on_new_window(move|url,_|{native_event(&popup_state,&popup_id,"popup",json!({"url":url}));NewWindowResponse::Deny})
            .on_page_load(move|view,payload|{
              let loading=matches!(payload.event(),PageLoadEvent::Started);
              native_event(&load_state,view.label(),"state",json!({"url":payload.url(),"navigationUrl":payload.url(),"loading":loading}));
              if !loading {
                let state=load_state.clone();let id=view.label().to_string();let load_url=payload.url().to_string();
                let _=view.eval_with_callback("({title:document.title,url:location.href,loading:false})",move|raw|{
                  if let Ok(mut data)=serde_json::from_str::<Value>(&raw){data["navigationUrl"]=json!(load_url);native_event(&state,&id,"state",data);}
                });
                let state=load_state.clone();let id=view.label().to_string();
                let _=view.with_webview(move|native|{
                  #[cfg(windows)] unsafe {
                    if let Ok(core)=native.controller().CoreWebView2(){
                      let mut back=windows::core::BOOL::default();let mut forward=windows::core::BOOL::default();
                      let _=core.CanGoBack(&mut back);let _=core.CanGoForward(&mut forward);
                      native_event(&state,&id,"state",json!({"canGoBack":back.as_bool(),"canGoForward":forward.as_bool()}));
                    }
                  }
                  #[cfg(target_os="linux")] {
                    use webkit2gtk::WebViewExt;let page=native.inner();
                    native_event(&state,&id,"state",json!({"canGoBack":page.can_go_back(),"canGoForward":page.can_go_forward()}));
                  }
                });
              }
            });
                let download_state = state.clone();
                builder = builder.on_download(move |view, event| {
                    use tauri::webview::DownloadEvent;
                    match event {
                        DownloadEvent::Requested { url, .. } => native_event(
                            &download_state,
                            view.label(),
                            "download",
                            json!({"active":true,"url":url}),
                        ),
                        DownloadEvent::Finished { url, .. } => native_event(
                            &download_state,
                            view.label(),
                            "download",
                            json!({"active":false,"url":url}),
                        ),
                        _ => {}
                    }
                    true
                });
                let browser_data = std::env::var_os("DUET_NATIVE_USER_DATA")
                    .map(std::path::PathBuf::from)
                    .unwrap_or(app.path().app_local_data_dir().map_err(|e| e.to_string())?)
                    .join("webview-browser");
                builder = builder.data_directory(browser_data);
                let view = result(parent.add_child(
                    builder,
                    LogicalPosition::new(0., 0.),
                    LogicalSize::new(1., 1.),
                ))?;
                result(view.hide())?;
            }
            Ok(Value::Null)
        }
        "event" => {
            if state
                .closing
                .lock()
                .unwrap()
                .get(text(&p, "window"))
                .copied()
                .unwrap_or(false)
            {
                return Ok(Value::Null);
            }
            if let Some(view) = app.get_webview(text(&p, "window")) {
                result(view.eval(format!(
                    "window.__duetDeliver?.({},{});",
                    p["channel"], p["payload"]
                )))?;
            }
            Ok(Value::Null)
        }
        "window.op" => {
            let id = text(&p, "id");
            let view = app.get_webview(id).ok_or("Window is closed")?;
            let is_ui = state.ui.lock().unwrap().get(id).copied().unwrap_or(false);
            match text(&p, "op") {
                "navigate" => result(
                    view.navigate(
                        text(&p, "url")
                            .parse()
                            .map_err(|e: url::ParseError| e.to_string())?,
                    ),
                )?,
                "app-url" => {
                    let mut url = view.url().map_err(|e| e.to_string())?;
                    let hash = text(&p, "hash");
                    url.set_fragment(if hash.is_empty() { None } else { Some(hash) });
                    result(view.navigate(url))?;
                }
                "eval" => return state.evaluate(&view, text(&p, "code")).await,
                "probe" => {
                    return tokio::time::timeout(
                        std::time::Duration::from_millis(750),
                        state.evaluate(&view, text(&p, "code")),
                    )
                    .await
                    .map_err(|_| "Page did not respond; sleep skipped".to_string())?
                }
                "execute" => result(view.eval(text(&p, "code")))?,
                "show" => {
                    if is_ui {
                        if std::env::var_os("DUET_NATIVE_TEST").is_none()
                            || std::env::var_os("DUET_NATIVE_TEST_VISIBLE").is_some()
                        {
                            result(view.window().show())?;
                        }
                    } else {
                        result(view.show())?;
                    }
                }
                "hide" => {
                    if is_ui {
                        result(view.window().hide())?;
                    } else {
                        result(view.hide())?;
                    }
                }
                "focus" => result(view.window().set_focus())?,
                "maximize" => result(view.window().maximize())?,
                "restore" => result(view.window().unminimize())?,
                "close" => {
                    if is_ui {
                        state.closing.lock().unwrap().insert(id.into(), true);
                        native_event(state, id, "closed", Value::Null);
                        result(view.window().destroy())?;
                    } else {
                        result(view.close())?;
                        native_event(state, id, "closed", Value::Null);
                    }
                }
                "bounds" => {
                    result(view.set_position(LogicalPosition::new(
                        number(&p, "x", 0.0),
                        number(&p, "y", 0.0),
                    )))?;
                    result(view.set_size(LogicalSize::new(
                        number(&p, "width", 1.0).max(1.),
                        number(&p, "height", 1.0).max(1.),
                    )))?;
                }
                "background" => {
                    let c = text(&p, "color").trim_start_matches('#');
                    if c.len() == 6 {
                        if let Ok(n) = u32::from_str_radix(c, 16) {
                            result(view.set_background_color(Some(tauri::webview::Color(
                                (n >> 16) as u8,
                                (n >> 8) as u8,
                                n as u8,
                                255,
                            ))))?;
                        }
                    }
                }
                "back" => result(view.eval("history.back()"))?,
                "forward" => result(view.eval("history.forward()"))?,
                "reload" => result(view.eval("location.reload()"))?,
                "stop" => result(view.eval("window.stop()"))?,
                "devtools" => view.open_devtools(),
                "capture" => return crate::capture::capture(&view).await,
                _ => {
                    return Err(format!(
                        "Unknown native window operation: {}",
                        text(&p, "op")
                    ))
                }
            }
            Ok(Value::Null)
        }
        "dialog.open" => {
            let selected = app.dialog().file().blocking_pick_folder();
            Ok(selected
                .map(|f| json!(f.to_string()))
                .unwrap_or(Value::Null))
        }
        "shell.open" => {
            let target = text(&p, "target");
            let application = p["application"].as_str();
            if target.starts_with("http://")
                || target.starts_with("https://")
                || target.starts_with("mailto:")
            {
                result(app.opener().open_url(target, None::<&str>))?;
            } else if std::path::Path::new(target).exists() {
                result(app.opener().open_path(target, application))?;
            } else {
                return Err("Path not found or unsupported URL".into());
            }
            Ok(Value::Null)
        }
        "shell.reveal" => {
            result(app.opener().reveal_item_in_dir(text(&p, "target")))?;
            Ok(Value::Null)
        }
        "notification" => {
            result(
                app.notification()
                    .builder()
                    .title(text(&p, "title"))
                    .body(text(&p, "body"))
                    .show(),
            )?;
            Ok(Value::Null)
        }
        "app.relaunch" => {
            app.restart();
        }
        "app.quit" => {
            app.exit(0);
            Ok(Value::Null)
        }
        _ => Err(format!("Unknown native operation: {method}")),
    }
}
