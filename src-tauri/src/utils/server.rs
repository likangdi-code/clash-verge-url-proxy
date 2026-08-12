use super::resolve;
use crate::{
    cmd::is_port_in_use,
    config::{Config, DEFAULT_PAC, IVerge},
    module::lightweight,
    process::AsyncHandler,
    utils::window_manager::WindowManager,
};
use anyhow::{Result, bail};
use clash_verge_logging::{Type, logging, logging_error};
use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use reqwest::ClientBuilder;
use smartstring::alias::String;
use std::time::Duration;
use tokio::sync::oneshot;
use warp::Filter as _;

#[derive(serde::Deserialize, Debug)]
struct QueryParam {
    param: String,
}

#[derive(serde::Deserialize, Debug)]
struct SaveQuery {
    index: String,
}

// 关闭 embedded server 的信号发送端
static SHUTDOWN_SENDER: OnceCell<Mutex<Option<oneshot::Sender<()>>>> = OnceCell::new();

// 外部命令桥（/commands/profile-save、/commands/profile-enhance）的可选 token：
// 设置环境变量 CLASH_VERGE_API_TOKEN 后，请求需带请求头 X-API-Token 匹配；未设置则放行（服务器仅绑定 127.0.0.1）。
// 用途：让外部 CLI（如 clash-pick）能触发「写 profile 增强文件 + 校验 + reload」，实现网址代理组自动化。
static API_TOKEN: OnceCell<Mutex<Option<std::string::String>>> = OnceCell::new();

fn check_api_token(token: Option<std::string::String>) -> bool {
    if let Some(guard) = API_TOKEN.get() {
        if let Some(expected) = guard.lock().as_deref() {
            return token.as_deref() == Some(expected);
        }
    }
    true
}

/// check whether there is already exists
pub async fn check_singleton() -> Result<()> {
    let port = IVerge::get_singleton_port();
    if is_port_in_use(port) {
        let client = ClientBuilder::new().timeout(Duration::from_millis(500)).build()?;
        // 需要确保 Send
        #[allow(clippy::needless_collect)]
        let argvs: Vec<std::string::String> = std::env::args().collect();
        if argvs.len() > 1 {
            #[cfg(not(target_os = "macos"))]
            {
                let param = argvs[1].as_str();
                if param.starts_with("clash:") {
                    client
                        .get(format!("http://127.0.0.1:{port}/commands/scheme?param={param}"))
                        .send()
                        .await?;
                }
            }
        } else {
            client
                .get(format!("http://127.0.0.1:{port}/commands/visible"))
                .send()
                .await?;
        }
        logging!(error, Type::Window, "failed to setup singleton listen server");
        bail!("app exists");
    }
    Ok(())
}

/// The embed server only be used to implement singleton process
/// maybe it can be used as pac server later
pub fn embed_server() {
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    #[allow(clippy::expect_used)]
    SHUTDOWN_SENDER
        .set(Mutex::new(Some(shutdown_tx)))
        .expect("failed to set shutdown signal for embedded server");
    let port = IVerge::get_singleton_port();

    API_TOKEN
        .set(Mutex::new(std::env::var("CLASH_VERGE_API_TOKEN").ok()))
        .expect("failed to init api token");

    let visible = warp::path!("commands" / "visible").and_then(|| async {
        logging!(info, Type::Window, "检测到从单例模式恢复应用窗口");
        if !lightweight::exit_lightweight_mode().await {
            WindowManager::show_main_window().await;
        } else {
            logging!(error, Type::Window, "轻量模式退出失败，无法恢复应用窗口");
        };
        Ok::<_, warp::Rejection>(warp::reply::with_status::<std::string::String>(
            "ok".to_string(),
            warp::http::StatusCode::OK,
        ))
    });

    let pac = warp::path!("commands" / "pac").and_then(|| async move {
        let verge_config = Config::verge().await;
        let clash_config = Config::clash().await;

        let verge_data = verge_config.data_arc();
        let clash_data = clash_config.data_arc();

        let pac_content = verge_data.pac_file_content.as_deref().unwrap_or(DEFAULT_PAC);

        let pac_port = verge_data
            .verge_mixed_port
            .unwrap_or_else(|| clash_data.get_mixed_port());
        let processed_content = pac_content.replace("%mixed-port%", &format!("{pac_port}"));
        Ok::<_, warp::Rejection>(
            warp::http::Response::builder()
                .header("Content-Type", "application/x-ns-proxy-autoconfig")
                .body(processed_content)
                .unwrap_or_default(),
        )
    });

    // Use map instead of and_then to avoid Send issues
    let scheme = warp::path!("commands" / "scheme")
        .and(warp::query::<QueryParam>())
        .and_then(|query: QueryParam| async move {
            AsyncHandler::spawn(|| async move {
                logging_error!(Type::Setup, resolve::resolve_scheme(&query.param).await);
            });
            Ok::<_, warp::Rejection>(warp::reply::with_status::<std::string::String>(
                "ok".to_string(),
                warp::http::StatusCode::OK,
            ))
        });

    // 外部命令桥：保存 profile 文件（写增强文件 + 校验 + 若影响运行时则 reload）
    // POST /commands/profile-save?index=<uid>，body 为文件内容（如 Groups/Rules 增强 YAML）
    // 复用前端同路径 cmd::save_profile_file（走 CoreManager 全局单例，不依赖 AppHandle）
    let profile_save = warp::path!("commands" / "profile-save")
        .and(warp::query::<SaveQuery>())
        .and(warp::header::optional::<std::string::String>("x-api-token"))
        .and(warp::body::content_length_limit(1024 * 1024))
        .and(warp::body::bytes())
        .and_then(
            |query: SaveQuery,
             token: Option<std::string::String>,
             body: bytes::Bytes| async move {
                if !check_api_token(token) {
                    return Ok::<_, warp::Rejection>(warp::reply::with_status(
                        "unauthorized".to_string(),
                        warp::http::StatusCode::UNAUTHORIZED,
                    ));
                }
                let file_data = std::string::String::from_utf8_lossy(&body).to_string();
                match crate::cmd::save_profile_file(query.index, Some(file_data.into())).await {
                    Ok(outcome) => Ok::<_, warp::Rejection>(warp::reply::with_status(
                        serde_json::to_string(&outcome).unwrap_or_default(),
                        warp::http::StatusCode::OK,
                    )),
                    Err(e) => Ok::<_, warp::Rejection>(warp::reply::with_status(
                        format!("save_profile_file error: {e}"),
                        warp::http::StatusCode::BAD_REQUEST,
                    )),
                }
            });

    // 外部命令桥：触发「增强配置 + reload」（校验失败不弹通知，silent=true）
    // GET /commands/profile-enhance
    let profile_enhance = warp::path!("commands" / "profile-enhance")
        .and(warp::header::optional::<std::string::String>("x-api-token"))
        .and_then(|token: Option<std::string::String>| async move {
            if !check_api_token(token) {
                return Ok::<_, warp::Rejection>(warp::reply::with_status(
                    "unauthorized".to_string(),
                    warp::http::StatusCode::UNAUTHORIZED,
                ));
            }
            match crate::cmd::enhance_profiles(Some(true)).await {
                Ok(outcome) => Ok::<_, warp::Rejection>(warp::reply::with_status(
                    serde_json::to_string(&outcome).unwrap_or_default(),
                    warp::http::StatusCode::OK,
                )),
                Err(e) => Ok::<_, warp::Rejection>(warp::reply::with_status(
                    format!("enhance_profiles error: {e}"),
                    warp::http::StatusCode::BAD_REQUEST,
                )),
            }
        });

    let commands = visible.or(scheme).or(pac).or(profile_save).or(profile_enhance);

    AsyncHandler::spawn(move || async move {
        warp::serve(commands)
            .bind(([127, 0, 0, 1], port))
            .await
            .graceful(async {
                shutdown_rx.await.ok();
            })
            .run()
            .await;
    });
}

pub fn shutdown_embedded_server() {
    logging!(info, Type::Window, "shutting down embedded server");
    if let Some(sender) = SHUTDOWN_SENDER.get()
        && let Some(sender) = sender.lock().take()
    {
        sender.send(()).ok();
    }
}
