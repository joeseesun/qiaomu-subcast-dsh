use super::*;
use std::io::Write;
use tokio::io::{AsyncBufReadExt, BufReader};

fn send(message: Value) -> std::io::Result<()> {
    let mut out = std::io::stdout().lock();
    serde_json::to_writer(&mut out, &message)?;
    out.write_all(b"\n")?;
    out.flush()
}

#[derive(Clone, Copy)]
pub(super) struct AppHandle;
impl AppHandle {
    pub fn emit(&self, event: &str, payload: impl Serialize) -> std::io::Result<()> {
        send(json!({ "event": event, "payload": payload }))
    }
}

pub(super) fn show_path(path: &std::path::Path, select: bool) -> Res<()> {
    #[cfg(target_os = "macos")]
    let mut cmd = { let mut c = std::process::Command::new("open"); if select { c.arg("-R"); } c.arg(path); c };
    #[cfg(target_os = "windows")]
    let mut cmd = { let mut c = std::process::Command::new("explorer"); if select { c.arg(format!("/select,{}", path.display())); } else { c.arg(path); } c };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = { let mut c = std::process::Command::new("xdg-open"); c.arg(if select { path.parent().unwrap_or(path) } else { path }); c };
    cmd.stdout(std::process::Stdio::null()).spawn().map(|_| ()).map_err(e)
}

pub(super) async fn serve(state: Arc<AppState>) -> anyhow::Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let request: Value = serde_json::from_str(&line)?;
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let result = super::dispatch::call(&state, request["method"].as_str().unwrap_or(""), &request["args"]).await;
            let reply = match result {
                Ok(value) => json!({"id": request["id"], "value": value}),
                Err(error) => json!({"id": request["id"], "error": error}),
            };
            let _ = send(reply);
        });
    }
    Ok(())
}
