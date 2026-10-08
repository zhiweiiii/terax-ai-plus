use std::io::{self, Read};
use std::process::{Child, Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use super::job::ProcessJob;

struct CapturedChild {
    child: Child,
    job: ProcessJob,
}

impl Drop for CapturedChild {
    fn drop(&mut self) {
        self.job.terminate();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn capture(command: &mut Command, timeout: Duration, limit: usize) -> Result<Output, String> {
    super::hide_console(command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let job = match ProcessJob::create_for(child.id()) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("process job setup failed: {error}"));
        }
    };
    let mut process = CapturedChild { child, job };
    let stdout = process
        .child
        .stdout
        .take()
        .ok_or("missing process stdout")?;
    let stderr = process
        .child
        .stderr
        .take()
        .ok_or("missing process stderr")?;
    let (tx, rx) = mpsc::channel();
    for (index, mut reader) in [
        (0, Box::new(stdout) as Box<dyn Read + Send>),
        (1, Box::new(stderr) as Box<dyn Read + Send>),
    ] {
        let tx = tx.clone();
        thread::Builder::new()
            .name("terax-probe-output".into())
            .spawn(move || {
                let mut bytes = Vec::new();
                let result = reader
                    .by_ref()
                    .take(limit.saturating_add(1) as u64)
                    .read_to_end(&mut bytes)
                    .and_then(|_| {
                        if bytes.len() > limit {
                            Err(io::Error::other("process output exceeds limit"))
                        } else {
                            Ok(bytes)
                        }
                    });
                let _ = tx.send((index, result));
            })
            .map_err(|e| e.to_string())?;
    }
    drop(tx);
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or("invalid process timeout")?;
    let mut status = None;
    let mut output = [None, None];
    loop {
        if status.is_none() {
            status = process.child.try_wait().map_err(|e| e.to_string())?;
            if status.is_some() {
                process.job.terminate();
            }
        }
        if let Some(status) = status {
            if let [Some(stdout), Some(stderr)] = &mut output {
                return Ok(Output {
                    status,
                    stdout: std::mem::take(stdout),
                    stderr: std::mem::take(stderr),
                });
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("process probe timed out".into());
        }
        match rx.recv_timeout(remaining.min(Duration::from_millis(10))) {
            Ok((index, bytes)) => output[index] = Some(bytes.map_err(|e| e.to_string())?),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if output.iter().any(Option::is_none) {
                    return Err("process output reader stopped".into());
                }
                thread::sleep(remaining.min(Duration::from_millis(10)));
            }
        }
    }
}
