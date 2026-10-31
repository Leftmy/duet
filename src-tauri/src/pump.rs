//! A bounded event stream with render acknowledgements. A slow WebView backpressures the CLI reader.
use crate::{trusted, Backend};
use duet_native::core::Emit;
use serde_json::{json, Value};
use std::{
    sync::{atomic::Ordering, mpsc, Arc, Condvar, Mutex, Weak},
    time::{Duration, Instant},
};
use tauri::Manager;
pub fn start(app: tauri::AppHandle, backend: Weak<Backend>) -> Emit {
    let (tx, rx) = mpsc::sync_channel::<(String, Value, usize)>(1024);
    let budget = Arc::new((Mutex::new(0usize), Condvar::new()));
    let consumed = budget.clone();
    let sender_backend = backend.clone();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut messages = vec![first];
            let mut bytes = messages[0].1.to_string().len();
            let start = Instant::now();
            while messages.len() < 128 && bytes < 256 * 1024 {
                let wait = Duration::from_millis(8).saturating_sub(start.elapsed());
                if wait.is_zero() {
                    break;
                }
                match rx.recv_timeout(wait) {
                    Ok(item) => {
                        bytes += item.1.to_string().len();
                        messages.push(item)
                    }
                    Err(_) => break,
                }
            }
            let reservation: usize = messages.iter().map(|(_, _, n)| *n).sum();
            let frames = messages.len();
            let mut delivery = vec![];
            let mut agents = vec![];
            for (channel, payload, _) in messages {
                if channel == "agent:event" {
                    agents.push(payload)
                } else {
                    if !agents.is_empty() {
                        delivery.push(
                            json!({"channel":"agent:events","payload":std::mem::take(&mut agents)}),
                        );
                    }
                    delivery.push(json!({"channel":channel,"payload":payload}));
                }
            }
            if !agents.is_empty() {
                delivery.push(json!({"channel":"agent:events","payload":agents}));
            }
            let Some(state) = backend.upgrade() else {
                break;
            };
            let windows = state
                .ui
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, ui)| **ui)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            let script=format!("(()=>{{for(const e of {})window.__duetDeliver?.(e.channel,e.payload);return true}})()",json!(delivery));
            for id in windows {
                if state
                    .closing
                    .lock()
                    .unwrap()
                    .get(&id)
                    .copied()
                    .unwrap_or(false)
                {
                    continue;
                }
                let Some(view) = app.get_webview(&id) else {
                    continue;
                };
                if !trusted(&view, &state) {
                    continue;
                }
                let (ack, received) = mpsc::sync_channel(1);
                if view
                    .eval_with_callback(&script, move |_| {
                        let _ = ack.send(());
                    })
                    .is_err()
                {
                    continue;
                }
                loop {
                    match received.recv_timeout(Duration::from_millis(200)) {
                        Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(_) => {
                            if state.exiting.load(Ordering::Acquire)
                                || app.get_webview(&id).is_none()
                                || state
                                    .closing
                                    .lock()
                                    .unwrap()
                                    .get(&id)
                                    .copied()
                                    .unwrap_or(false)
                            {
                                break;
                            }
                        }
                    }
                }
            }
            {
                state
                    .delivery_bytes
                    .fetch_sub(reservation, Ordering::Relaxed);
                state.delivery_messages.fetch_sub(frames, Ordering::Relaxed);
                let mut used = consumed.0.lock().unwrap();
                *used = used.saturating_sub(reservation);
                consumed.1.notify_all();
            }
        }
    });
    Arc::new(move |channel, payload| {
        let Some(state) = sender_backend.upgrade() else {
            return;
        };
        if state.exiting.load(Ordering::Acquire) {
            return;
        }
        let size = payload.to_string().len().min(64 * 1024 * 1024);
        let mut used = budget.0.lock().unwrap();
        while used.saturating_add(size) > 64 * 1024 * 1024 {
            used = budget
                .1
                .wait_timeout(used, Duration::from_millis(200))
                .unwrap()
                .0;
            if state.exiting.load(Ordering::Acquire) {
                return;
            }
        }
        *used += size;
        state.delivery_bytes.fetch_add(size, Ordering::Relaxed);
        state.delivery_messages.fetch_add(1, Ordering::Relaxed);
        drop(used);
        if tx.send((channel.into(), payload, size)).is_err() {
            state.delivery_bytes.fetch_sub(size, Ordering::Relaxed);
            state.delivery_messages.fetch_sub(1, Ordering::Relaxed);
            let mut used = budget.0.lock().unwrap();
            *used = used.saturating_sub(size);
            budget.1.notify_all();
        }
    })
}
