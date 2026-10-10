use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use super::{next_daily, now_ms, Job, Target};

#[derive(Serialize, Deserialize)]
struct Document {
    version: u32,
    jobs: Vec<Job>,
}

pub(super) struct Storage {
    path: PathBuf,
    _lock: File,
}

impl Storage {
    pub fn load(app: &tauri::AppHandle) -> Result<(Self, Vec<Job>), String> {
        let directory = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let name = if cfg!(debug_assertions) {
            "schedules-dev"
        } else {
            "schedules"
        };
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .open(directory.join(format!("{name}.lock")))
            .map_err(|e| format!("无法锁定定时任务存储（可能已有另一个 awei-work 实例）：{e}"))?;
        let storage = Self {
            path: directory.join(format!("{name}.json")),
            _lock: lock,
        };
        let mut jobs = match File::open(&storage.path) {
            Ok(file) => {
                let mut data = Vec::new();
                file.take(32 * 1024 * 1024 + 1)
                    .read_to_end(&mut data)
                    .map_err(|e| e.to_string())?;
                if data.len() > 32 * 1024 * 1024 {
                    return Err("定时任务文件过大，已停止加载".into());
                }
                let document: Document = serde_json::from_slice(&data)
                    .map_err(|e| format!("定时任务文件损坏，原文件已保留：{e}"))?;
                if document.version != 1 {
                    return Err("不支持的定时任务文件版本，原文件已保留".into());
                }
                document.jobs
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(format!("读取定时任务失败：{error}")),
        };
        let mut ids = HashSet::new();
        if jobs.len() > 128 {
            return Err("定时任务数量超出限制".into());
        }
        let now = now_ms();
        for job in &mut jobs {
            if job.id == 0
                || job.id >= u64::MAX - 128
                || !ids.insert(job.id)
                || job.command.trim().is_empty()
                || job.command.len() > 65536
            {
                return Err("定时任务文件包含无效任务，原文件已保留".into());
            }
            if let Some(time) = &job.daily_time {
                next_daily(time, now)?;
            }
            if job.running {
                job.running = false;
                job.last_result = Some("上次执行被中断，结果未知，未自动重发".into());
                if let Some(time) = &job.daily_time {
                    job.fire_at = next_daily(time, now)?;
                } else {
                    job.finished = true;
                }
            }
            if job.target == Target::Terminal && !job.finished {
                job.paused = true;
                job.last_result = Some("重启后需重新绑定终端，避免发送到错误会话".into());
            }
        }
        if !jobs.is_empty() {
            storage.save(&jobs)?;
        }
        Ok((storage, jobs))
    }

    pub fn save(&self, jobs: &[Job]) -> Result<(), String> {
        let save = || -> std::io::Result<()> {
            let parent = self
                .path
                .parent()
                .ok_or_else(|| std::io::Error::other("missing parent"))?;
            let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
            serde_json::to_writer(
                &mut temporary,
                &Document {
                    version: 1,
                    jobs: jobs.to_vec(),
                },
            )?;
            temporary.flush()?;
            temporary.as_file().sync_all()?;
            temporary.persist(&self.path).map_err(|e| e.error)?;
            Ok(())
        };
        save().map_err(|e| format!("保存定时任务失败，自动执行已暂停：{e}"))
    }
}
