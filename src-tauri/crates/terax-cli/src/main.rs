use std::env;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use terax_control_protocol::{
    CallerContext, ControlDescriptor, ControlRequest, ControlResponse, OpenParams,
    MAX_MESSAGE_BYTES, METHOD_CAPABILITIES, METHOD_IDENTIFY, METHOD_OPEN, METHOD_PING,
    PROTOCOL_VERSION, SERVER_RESPONSE_ID,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const IO_TIMEOUT: Duration = Duration::from_secs(7);
const EXIT_USAGE: u8 = 2;
const EXIT_UNAVAILABLE: u8 = 3;
const EXIT_PROTOCOL: u8 = 4;
const EXIT_REQUEST: u8 = 5;
static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, PartialEq)]
enum Action {
    Help,
    Version,
    Request { method: &'static str, params: Value },
}

#[derive(Debug, PartialEq)]
struct Config {
    json: bool,
    action: Action,
}

#[derive(Debug)]
struct CliError {
    code: String,
    message: String,
    exit: u8,
}

impl CliError {
    fn new(code: impl Into<String>, message: impl Into<String>, exit: u8) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            exit,
        }
    }
}

fn main() -> ExitCode {
    match run(env::args_os().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let mut display_args: Vec<OsString> = env::args_os().skip(1).collect();
            let json = extract_json_flag(&mut display_args);
            if json {
                eprintln!(
                    "{}",
                    json!({
                        "ok": false,
                        "error": { "code": error.code, "message": error.message }
                    })
                );
            } else {
                eprintln!("terax: {}", error.message);
            }
            ExitCode::from(error.exit)
        }
    }
}

fn run(args: Vec<OsString>) -> Result<(), CliError> {
    let config = parse_args(args)?;
    match config.action {
        Action::Help => {
            print_help();
            Ok(())
        }
        Action::Version => {
            println!("terax {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Action::Request { method, params } => {
            let endpoint = load_endpoint()?;
            let caller = env::var("TERAX_PANE_ID")
                .ok()
                .and_then(|value| value.parse::<u32>().ok());
            let request = ControlRequest {
                protocol: PROTOCOL_VERSION,
                id: request_id(),
                token: endpoint.token,
                method: method.to_string(),
                params,
                caller: CallerContext { pane_id: caller },
            };
            let response = send_request(&endpoint.address, &request)?;
            if !response.ok {
                let error = response.error.unwrap_or_else(|| {
                    terax_control_protocol::ControlError::new(
                        "request_failed",
                        "Terax rejected the request",
                    )
                });
                return Err(CliError::new(error.code, error.message, EXIT_REQUEST));
            }
            let result = response.result.unwrap_or(Value::Null);
            print_result(method, result, config.json);
            Ok(())
        }
    }
}

fn parse_args(mut args: Vec<OsString>) -> Result<Config, CliError> {
    let json = extract_json_flag(&mut args);
    if args.is_empty() {
        return Ok(Config {
            json,
            action: Action::Help,
        });
    }

    let command = args.remove(0);
    let command_text = command.to_str();
    let action = match command_text {
        Some("help" | "--help" | "-h") => no_extra_args(args, Action::Help)?,
        Some("--version" | "-V" | "version") => no_extra_args(args, Action::Version)?,
        Some("ping") => request_without_params(args, METHOD_PING)?,
        Some("capabilities") => request_without_params(args, METHOD_CAPABILITIES)?,
        Some("identify") => request_without_params(args, METHOD_IDENTIFY)?,
        Some("open") => parse_open(args)?,
        Some("--") => {
            args.insert(0, command);
            parse_open(args)?
        }
        Some(value) if value.starts_with('-') => {
            return Err(usage_error(format!("unknown option '{value}'")));
        }
        _ => {
            args.insert(0, command);
            parse_open(args)?
        }
    };
    Ok(Config { json, action })
}

fn extract_json_flag(args: &mut Vec<OsString>) -> bool {
    let mut json = false;
    let mut after_separator = false;
    args.retain(|arg| {
        if after_separator {
            return true;
        }
        if arg == "--" {
            after_separator = true;
            return true;
        }
        if arg == "--json" {
            json = true;
            return false;
        }
        true
    });
    json
}

fn no_extra_args(args: Vec<OsString>, action: Action) -> Result<Action, CliError> {
    if args.is_empty() {
        Ok(action)
    } else {
        Err(usage_error("unexpected arguments"))
    }
}

fn request_without_params(args: Vec<OsString>, method: &'static str) -> Result<Action, CliError> {
    no_extra_args(
        args,
        Action::Request {
            method,
            params: json!({}),
        },
    )
}

fn parse_open(args: Vec<OsString>) -> Result<Action, CliError> {
    let mut path: Option<OsString> = None;
    let mut line = None;
    let mut focus = true;
    let mut options = true;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        match arg.to_str() {
            Some("--") if options => options = false,
            Some("--line" | "-l") if options => {
                index += 1;
                let value = args
                    .get(index)
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| usage_error("--line requires a positive integer"))?;
                let parsed = value
                    .parse::<u32>()
                    .ok()
                    .filter(|line| *line > 0)
                    .ok_or_else(|| usage_error("--line requires a positive integer"))?;
                line = Some(parsed);
            }
            Some("--no-focus") if options => focus = false,
            Some(value) if options && value.starts_with('-') => {
                return Err(usage_error(format!("unknown open option '{value}'")));
            }
            _ if path.is_none() => path = Some(arg.clone()),
            _ => return Err(usage_error("open accepts exactly one file path")),
        }
        index += 1;
    }

    let path = path.ok_or_else(|| usage_error("open requires a file path"))?;
    let canonical = std::fs::canonicalize(PathBuf::from(path)).map_err(|error| {
        CliError::new(
            "path_not_found",
            format!("cannot resolve file path: {error}"),
            EXIT_USAGE,
        )
    })?;
    if !canonical.is_file() {
        return Err(CliError::new(
            "not_a_file",
            format!("path is not a regular file: {}", canonical.display()),
            EXIT_USAGE,
        ));
    }
    let path = canonical.into_os_string().into_string().map_err(|_| {
        CliError::new(
            "non_utf8_path",
            "Terax cannot open a path that is not valid UTF-8",
            EXIT_USAGE,
        )
    })?;
    let params = serde_json::to_value(OpenParams {
        path,
        line,
        column: None,
        focus,
    })
    .map_err(|error| {
        CliError::new(
            "serialization_error",
            format!("could not encode open request: {error}"),
            EXIT_PROTOCOL,
        )
    })?;
    Ok(Action::Request {
        method: METHOD_OPEN,
        params,
    })
}

fn usage_error(message: impl Into<String>) -> CliError {
    CliError::new("usage", message, EXIT_USAGE)
}

fn load_endpoint() -> Result<ControlDescriptor, CliError> {
    let env_address = env::var("TERAX_CONTROL_ADDR").ok();
    let env_token = env::var("TERAX_CONTROL_TOKEN").ok();
    let (descriptor, require_live_process) = match (env_address, env_token) {
        (Some(address), Some(token)) => (
            ControlDescriptor {
                protocol: PROTOCOL_VERSION,
                address,
                token,
                pid: 0,
                app_version: String::new(),
            },
            false,
        ),
        (None, None) => {
            let path = dirs::cache_dir()
                .map(|dir| dir.join("terax").join("control.json"))
                .ok_or_else(|| {
                    CliError::new(
                        "app_unavailable",
                        "could not locate the user cache directory",
                        EXIT_UNAVAILABLE,
                    )
                })?;
            let bytes = std::fs::read(&path).map_err(|_| {
                CliError::new(
                    "app_unavailable",
                    "Terax is not running; start the app and try again",
                    EXIT_UNAVAILABLE,
                )
            })?;
            let descriptor = serde_json::from_slice(&bytes).map_err(|error| {
                CliError::new(
                    "invalid_descriptor",
                    format!("invalid Terax control descriptor: {error}"),
                    EXIT_PROTOCOL,
                )
            })?;
            (descriptor, true)
        }
        _ => {
            return Err(CliError::new(
                "invalid_environment",
                "TERAX_CONTROL_ADDR and TERAX_CONTROL_TOKEN must be set together",
                EXIT_PROTOCOL,
            ));
        }
    };
    validate_endpoint(descriptor, require_live_process)
}

fn validate_endpoint(
    descriptor: ControlDescriptor,
    require_live_process: bool,
) -> Result<ControlDescriptor, CliError> {
    if descriptor.protocol != PROTOCOL_VERSION {
        return Err(CliError::new(
            "unsupported_protocol",
            format!(
                "Terax uses control protocol {}, but this CLI supports {PROTOCOL_VERSION}",
                descriptor.protocol
            ),
            EXIT_PROTOCOL,
        ));
    }
    if descriptor.token.len() != 64
        || !descriptor
            .token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(CliError::new(
            "invalid_endpoint",
            "Terax control token is invalid",
            EXIT_PROTOCOL,
        ));
    }
    parse_loopback_address(&descriptor.address)?;
    if require_live_process && !process_is_alive(descriptor.pid) {
        return Err(CliError::new(
            "invalid_endpoint",
            "Terax control process is not running",
            EXIT_PROTOCOL,
        ));
    }
    Ok(descriptor)
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    if pid == 0 {
        return false;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if !handle.is_null() {
            CloseHandle(handle);
            true
        } else {
            GetLastError() == ERROR_ACCESS_DENIED
        }
    }
}

fn send_request(address: &str, request: &ControlRequest) -> Result<ControlResponse, CliError> {
    let address = parse_loopback_address(address)?;
    let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).map_err(|error| {
        CliError::new(
            "app_unavailable",
            format!("could not connect to Terax: {error}"),
            EXIT_UNAVAILABLE,
        )
    })?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).ok();
    stream.set_write_timeout(Some(IO_TIMEOUT)).ok();
    write_request(&mut stream, request)?;

    let mut reader = BufReader::new(stream);
    read_response(&mut reader, request)
}

fn parse_loopback_address(address: &str) -> Result<SocketAddr, CliError> {
    let address: SocketAddr = address.parse().map_err(|error| {
        CliError::new(
            "invalid_endpoint",
            format!("invalid Terax control address: {error}"),
            EXIT_PROTOCOL,
        )
    })?;
    if !address.ip().is_loopback() {
        return Err(CliError::new(
            "invalid_endpoint",
            "Terax control address must be loopback-only",
            EXIT_PROTOCOL,
        ));
    }
    Ok(address)
}

fn write_request(writer: &mut impl Write, request: &ControlRequest) -> Result<(), CliError> {
    serde_json::to_writer(&mut *writer, request).map_err(|error| {
        CliError::new(
            "serialization_error",
            format!("could not encode request: {error}"),
            EXIT_PROTOCOL,
        )
    })?;
    writer.write_all(b"\n").map_err(io_error)?;
    writer.flush().map_err(io_error)
}

fn read_response(
    reader: &mut impl BufRead,
    request: &ControlRequest,
) -> Result<ControlResponse, CliError> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take((MAX_MESSAGE_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(io_error)?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(CliError::new(
            "message_too_large",
            "Terax response exceeded the protocol limit",
            EXIT_PROTOCOL,
        ));
    }
    if bytes.last() != Some(&b'\n') {
        return Err(CliError::new(
            "invalid_response",
            "Terax returned an incomplete response",
            EXIT_PROTOCOL,
        ));
    }
    let response: ControlResponse = serde_json::from_slice(&bytes).map_err(|error| {
        CliError::new(
            "invalid_response",
            format!("Terax returned invalid JSON: {error}"),
            EXIT_PROTOCOL,
        )
    })?;
    let matched_id =
        response.id == request.id || (!response.ok && response.id == SERVER_RESPONSE_ID);
    if response.protocol != PROTOCOL_VERSION || !matched_id {
        return Err(CliError::new(
            "invalid_response",
            "Terax returned a mismatched protocol version or request id",
            EXIT_PROTOCOL,
        ));
    }
    Ok(response)
}

fn io_error(error: std::io::Error) -> CliError {
    CliError::new(
        "io_error",
        format!("control connection failed: {error}"),
        EXIT_UNAVAILABLE,
    )
}

fn request_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{nanos}-{sequence}", std::process::id())
}

fn print_result(method: &str, result: Value, as_json: bool) {
    if as_json {
        println!("{}", json!({ "ok": true, "result": result }));
        return;
    }
    match method {
        METHOD_PING => {
            let version = result
                .get("app_version")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            println!("Terax {version} is running");
        }
        METHOD_CAPABILITIES => {
            if let Some(methods) = result.get("methods").and_then(Value::as_array) {
                for method in methods.iter().filter_map(Value::as_str) {
                    println!("{method}");
                }
            }
        }
        METHOD_IDENTIFY => {
            let space = result
                .get("space_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let tab = result
                .get("tab_id")
                .and_then(Value::as_u64)
                .map_or_else(|| "none".to_string(), |id| id.to_string());
            let pane = result
                .get("pane_id")
                .and_then(Value::as_u64)
                .map_or_else(|| "none".to_string(), |id| id.to_string());
            println!("space={space} tab={tab} pane={pane}");
        }
        METHOD_OPEN => {
            let path = result.get("path").and_then(Value::as_str).unwrap_or("");
            let line = result.get("line").and_then(Value::as_u64);
            if let Some(line) = line {
                println!("Opened {path}:{line} in Terax");
            } else {
                println!("Opened {path} in Terax");
            }
        }
        _ => println!("{result}"),
    }
}

fn print_help() {
    println!(
        "Terax command line interface\n\n\
Usage:\n  terax <file> [--line <n>] [--no-focus] [--json]\n  terax open <file> [--line <n>] [--no-focus] [--json]\n  terax ping [--json]\n  terax capabilities [--json]\n  terax identify [--json]\n  terax --version\n\n\
The app must be running. Commands launched in a Terax pane target that pane's space."
    );
}


