//! `backplane builds keep --builds PREFIX --running TAG [--channel C]`: keeps a desktop app's builds current where no guard runs (appkeep.rs). The
//! desktop app starts it, detached, at launch, every few hours while it runs, and on Check now, only when it uses a hub on another machine.
//!
//! It finds, checks and stages the newest release with the hub's own updater (`update::rel` and `update::run`, compiled in by path), so the trust is
//! the hub's: the signed manifest under the one compiled-in key, the channel, the tag's shape, `BAD`, the archive's size, sha256 and members, `EXPECT`,
//! one rename into `builds/<tag>/`. It then writes `app-update/next`, and nothing else: the next launch of the app tries it (appkeep::start) and only
//! a window that opened moves `CURRENT`. It never touches a running build and never starts or stops a hub. The feed comes only from the environment
//! (`BACKPLANE_UPDATE_FEED`), and `BACKPLANE_NO_UPDATE=1` turns it off, as for the hub.
use crate::{appkeep, rel, upd_run as run};
use serde_json::json;
use std::{fs, path::{Path, PathBuf}, process::Command};

const USAGE: &str = "usage: backplane builds keep --builds PREFIX --running TAG [--channel stable|beta|nightly]\n";

/// A program run with no console window on Windows (curl, tar).
fn quiet(prog: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)] let mut c = Command::new(prog);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
    c
}
/// The hub's `svc::curl`: https stays https on a redirect, and nothing larger than `max` is written.
fn curl(url: &str, out: &Path, max: u64) -> Result<(), String> {
    let mut c = quiet("curl");
    c.args(["-fsSL", "--max-time", "1800", "--max-filesize", &max.to_string(), "-A", "backplane-guard", "-o"]).arg(out);
    if url.starts_with("https://") { c.args(["--proto", "=https", "--proto-redir", "=https"]); }
    let o = c.arg(url).output().map_err(|e| format!("curl: {e}"))?;
    if o.status.success() { Ok(()) } else { Err(format!("could not reach the release feed (curl {})", o.status.code().unwrap_or(-1))) }
}
/// The hub's `svc::tar`: listed and checked (`run::members_ok`) before anything is written, then unpacked owning nothing. A zip (Windows) goes
/// through Windows' own tar.exe, which reads zip; Git's GNU tar, often first on PATH there, does not.
fn tar(a: &Path, d: &Path) -> Result<(), String> {
    let zip = a.extension().is_some_and(|e| e == "zip");
    let prog: std::ffi::OsString = match std::env::var_os("SystemRoot") { Some(r) if cfg!(windows) && zip => Path::new(&r).join("System32").join("tar.exe").into(), _ => "tar".into() };
    let z = if zip { "" } else { "z" };
    let list = |flag: &str| -> Result<String, String> {
        let o = quiet(&prog).arg(flag).arg(a).env("LC_ALL", "C").output().map_err(|e| format!("tar: {e}"))?;
        if o.status.success() { Ok(String::from_utf8_lossy(&o.stdout).into_owned()) } else { Err("the archive would not unpack".into()) }
    };
    run::members_ok(&list(&format!("-t{z}f"))?, &list(&format!("-tv{z}f"))?)?;
    let o = quiet(&prog).args(["--no-same-owner", "--no-same-permissions", &format!("-x{z}f")]).arg(a).arg("-C").arg(d).output().map_err(|e| format!("tar: {e}"))?;
    if o.status.success() { Ok(()) } else { Err("the archive would not unpack".into()) }
}
fn feed() -> String { std::env::var("BACKPLANE_UPDATE_FEED").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| run::FEED.to_string()) }
fn off() -> bool { std::env::var("BACKPLANE_NO_UPDATE").map_or(false, |v| v == "1") }

/// The version a release must beat: the running build, or the build already staged when it is newer and not bad (a check while one waits for
/// the next launch looks only for something newer still).
pub fn floor(running: &str, next: &str, bad: &[String], staged: bool) -> String {
    if staged && appkeep::name_ok(next) && !bad.iter().any(|b| b == next) && appkeep::newer(next, running) { next.to_string() } else { running.to_string() }
}

/// Builds that may go: the guard's rule (`run::prunable`), with appkeep's protected ones as pins. Only release-shaped names, so nothing else in
/// the folder (a dev build's, scratch) is ever removed.
fn prune(prefix: &Path, running: &str) {
    let all: Vec<String> = fs::read_dir(prefix.join("builds")).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    let cur = appkeep::current(prefix); if cur.is_empty() { return } // nothing says what runs: delete nothing
    let good = appkeep::good(prefix);
    let mut keep = appkeep::protected(&good, &appkeep::next(prefix), appkeep::trial(prefix).as_ref(), running);
    keep.extend(fs::read_dir(prefix.join(".pins")).map(|d| d.flatten().flat_map(|e| appkeep::lines(&e.path())).collect::<Vec<_>>()).unwrap_or_default());
    for x in run::prunable(&all, &cur, &keep, &good) { if rel::tag_ok(&x) { let _ = fs::remove_dir_all(prefix.join("builds").join(x)); } }
}

struct Args { prefix: PathBuf, running: String, channel: String }
fn args(a: &[String]) -> Option<Args> {
    let (mut prefix, mut running, mut channel) = (None, String::new(), String::new());
    let mut i = 0;
    while i < a.len() {
        let v = a.get(i + 1).cloned();
        match a[i].as_str() { "--builds" => prefix = v.map(PathBuf::from), "--running" => running = v?, "--channel" => channel = v?, _ => return None }
        i += 2;
    }
    let prefix = prefix?;
    (appkeep::name_ok(&running) && prefix.join("builds").join(&running).is_dir()).then(|| Args { prefix, running, channel: rel::channel(&channel).to_string() })
}

/// One look: off, or a guard here, says so and stops; otherwise check, stage what is newer, prune. 0 when it got an answer from the feed.
pub fn keep(a: &[String]) -> i32 {
    if a.first().map(String::as_str) != Some("keep") { eprint!("{USAGE}"); return 2 }
    let Some(o) = args(&a[1..]) else { eprint!("{USAGE}"); return 2 };
    let (p, d) = (&o.prefix, appkeep::dir(&o.prefix));
    if fs::create_dir_all(&d).is_err() { eprintln!("cannot make {}", d.display()); return 1 }
    // one at a time: the launch's check and a Check now pressed meanwhile are the same look
    let Ok(lock) = fs::OpenOptions::new().create(true).truncate(false).write(true).open(d.join("lock")) else { return 1 };
    if lock.try_lock().is_err() { eprintln!("keep: a check already runs"); return 0 }
    let ch = o.channel.clone();
    if off() { appkeep::set_status(p, |s| { s["state"] = json!("off"); s["channel"] = json!(ch); }); return 0 }
    if appkeep::guard_runs(p) { appkeep::set_status(p, |s| { s["state"] = json!("guard"); s["channel"] = json!(ch); }); return 0 }
    appkeep::set_status(p, |s| { s["state"] = json!("checking"); s["channel"] = json!(ch); s["note"] = json!(""); });
    let scratch = d.join("scratch"); let _ = fs::remove_dir_all(&scratch);
    let r = look(&o, &scratch);
    let _ = fs::remove_dir_all(&scratch);
    let at = appkeep::now();
    let code = match r {
        Ok(Some(tag)) => { appkeep::set_status(p, |s| { s["state"] = json!("ready"); s["available"] = json!(tag); s["checked"] = json!(at); }); 0 }
        Ok(None) => { appkeep::set_status(p, |s| { s["state"] = json!("idle"); s["available"] = json!(""); s["checked"] = json!(at); }); 0 }
        Err(e) => { eprintln!("keep: {e}"); appkeep::set_status(p, |s| { s["state"] = json!("failed"); s["note"] = json!(e); s["checked"] = json!(at); }); 1 }
    };
    prune(p, &o.running);
    code
}

/// Find and stage. The build that waits for the next launch, when there is one and nothing newer.
fn look(o: &Args, scratch: &Path) -> Result<Option<String>, String> {
    let p = &o.prefix;
    fs::create_dir_all(scratch).map_err(|e| e.to_string())?;
    let target = rel::target().ok_or("no build is made for this machine")?;
    let list = scratch.join("releases.json"); curl(&feed(), &list, 8 << 20)?;
    let l = run::listing(&fs::read(&list).map_err(|e| e.to_string())?)?;
    let bad = appkeep::bad(p); let next = appkeep::next(p);
    let staged = appkeep::app_of(p, &next).is_file();
    let floor = floor(&o.running, &next, &bad, staged);
    let waiting = (floor != o.running).then(|| floor.clone());
    let Some(f) = run::find(&run::Ask { current: &floor, channel: &o.channel, target, keys: &rel::keys(), bad: &bad }, &l, scratch, &curl)? else {
        if waiting.is_none() && !next.is_empty() { let _ = fs::remove_file(appkeep::dir(p).join("next")); } // older than what runs, bad, or gone
        return Ok(waiting);
    };
    let t = f.tag.clone(); appkeep::set_status(p, |s| { s["state"] = json!("downloading"); s["available"] = json!(t); });
    run::stage(&f, p, &curl, &tar)?;
    appkeep::put(&appkeep::dir(p).join("next"), &format!("{}\n", f.tag)).map_err(|e| e.to_string())?;
    Ok(Some(f.tag))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn appkeep_orders_tags_as_the_updater_does() {
        let tags = ["v0.14.2", "v0.15.0-beta.1", "v0.15.0-beta.10", "v0.15.0-beta.2", "v0.15.0", "v0.15.4-nightly.20261113.1", "v0.15.4-nightly.20261113.2", "v0.15.4-nightly.20261114.1", "v0.15.4", "v0.16.0", "v0.9.9", "v0.10.0"];
        for a in tags { for b in tags { assert_eq!(appkeep::newer(a, b), rel::Ver::parse(a).newer(&rel::Ver::parse(b)), "{a} vs {b}"); } }
        for t in tags { if rel::tag_ok(t) { assert!(appkeep::name_ok(t), "{t}: a release's tag is always a name appkeep runs") } }
    }
    #[test] fn a_check_while_a_build_waits_looks_past_it() {
        assert_eq!(floor("v0.16.0", "v0.16.1", &[], true), "v0.16.1");
        assert_eq!(floor("v0.16.0", "v0.16.1", &[], false), "v0.16.0", "staged no more (pruned): found again");
        assert_eq!(floor("v0.16.0", "v0.16.1", &["v0.16.1".into()], true), "v0.16.0", "bad: the next newer one is wanted");
        assert_eq!(floor("v0.16.2", "v0.16.1", &[], true), "v0.16.2", "an install by hand moved past it");
        assert_eq!(floor("v0.16.0", "", &[], false), "v0.16.0");
    }
    #[test] fn only_a_build_of_this_prefix_is_a_running_build() {
        let d = crate::tmp::dir("keep-args"); fs::create_dir_all(d.join("builds/v1")).unwrap();
        let s = |x: &[&str]| x.iter().map(|y| y.to_string()).collect::<Vec<_>>(); let p = d.to_string_lossy().into_owned();
        let o = args(&s(&["--builds", &p, "--running", "v1", "--channel", "canary"])).unwrap(); assert_eq!(o.channel, "stable", "the unknown is stable");
        assert!(args(&s(&["--builds", &p, "--running", "v2"])).is_none(), "no such build"); assert!(args(&s(&["--builds", &p, "--running", "../v1"])).is_none());
        assert!(args(&s(&["--running", "v1"])).is_none()); assert!(args(&s(&["--builds", &p, "--running", "v1", "--x"])).is_none());
    }
}
