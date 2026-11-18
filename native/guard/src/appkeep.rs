//! The desktop app's own updates where no guard runs: a client that uses a hub on another machine (`launch.json` names a `url`) starts no hub
//! here, so no guard looks at the release feed and nothing moves `CURRENT` (docs/deploy.md, "A desktop app on another machine's hub").
//!
//! Two programs share this file (by path, like scopeprobe.rs): the guard's `backplane builds keep` (keep.rs) finds, checks and stages a release
//! with the hub's own updater (`update::rel`, `update::run`), and the desktop app (`native/gpui`, selfupdate.rs) switches to it at a launch and
//! proves it. `CURRENT` only ever names a build whose window opened here: a launch tries the staged build while `CURRENT` still names the one it
//! came from, so a new build that cannot start leaves the launchers (Backplane.app, `backplane-app`, the Windows guard's `backplane`) on the old one,
//! and the next launch marks it bad and stays.
//!
//! Plain files beside the builds, in `<prefix>/app-update/`:
//!   next         the build `keep` staged for the next launch
//!   trial        {"tag","from","at"}: the build a launch is trying; CURRENT still names `from` until the new app's window is up
//!   good         builds whose app opened its window here, oldest first
//!   status.json  what `keep` last did: {state, available, channel, note (its error), checked}, and `said`: how the last switch ended ({"updated": tag} or {"stayed": tag})
//!   lock         one `keep` at a time
//!   keep.log     what `keep` said
//! `<prefix>/clients.lock`: every app of this prefix holds it shared while it runs; a launch moves to another build only when it can hold it alone,
//! so no build ever changes under a running app. `<prefix>/BAD` (id, tab, why) is the guard's list: a build that failed here, under a guard or
//! here, is never offered or tried again.
use serde_json::{json, Value};
use std::{fs, io::Write, path::{Path, PathBuf}};

pub fn now() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()) }
pub fn dir(prefix: &Path) -> PathBuf { prefix.join("app-update") }
/// The app of a build: what every launcher runs.
pub fn app_of(prefix: &Path, tag: &str) -> PathBuf { prefix.join("builds").join(tag).join(if cfg!(windows) { "backplane-gpui.exe" } else { "backplane-gpui" }) }
/// The guard of a build: the app runs its own build's `backplane builds keep`, so the command is always the one this file was built into.
pub fn guard_of(prefix: &Path, tag: &str) -> PathBuf { prefix.join("builds").join(tag).join(if cfg!(windows) { "backplane.exe" } else { "backplane" }) }

/// Written beside and renamed over: a reader never sees half, and a full disk loses the write, never the file that was there.
pub fn put(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(d) = path.parent() { fs::create_dir_all(d)?; }
    let tmp = path.with_file_name(format!(".{}.{}", path.file_name().map_or("x".into(), |n| n.to_string_lossy().into_owned()), std::process::id()));
    let r = fs::write(&tmp, text).and_then(|_| fs::rename(&tmp, path));
    if r.is_err() { let _ = fs::remove_file(&tmp); }
    r
}
pub fn lines(p: &Path) -> Vec<String> { fs::read_to_string(p).unwrap_or_default().lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect() }
fn first(p: &Path) -> String { lines(p).into_iter().next().unwrap_or_default() }

/// `CURRENT`: the build the launchers run.
pub fn current(prefix: &Path) -> String { first(&prefix.join("CURRENT")) }
/// The one writer of CURRENT where no guard runs: a whole file, renamed over (the guard's `Builds::publish` writes it the same way).
pub fn publish(prefix: &Path, tag: &str) -> std::io::Result<()> { put(&prefix.join("CURRENT"), &format!("{tag}\n")) }
/// `BAD`'s ids.
pub fn bad(prefix: &Path) -> Vec<String> { bad_lines(prefix).into_iter().map(|x| x.0).collect() }
/// `BAD`, the guard's list: id, tab, why.
pub fn bad_lines(prefix: &Path) -> Vec<(String, String)> {
    fs::read_to_string(prefix.join("BAD")).unwrap_or_default().lines().filter_map(|l| { let (i, w) = l.split_once('\t').unwrap_or((l, "")); (!i.is_empty()).then(|| (i.to_string(), w.to_string())) }).collect()
}
/// One line more in BAD, as the guard writes it (`store::Builds::mark_bad` is this); `.fresh-bad` holds the newest alone.
pub fn mark_bad(prefix: &Path, id: &str, why: &str) {
    if bad(prefix).iter().any(|b| b == id) { return }
    let why: String = why.chars().filter(|c| !c.is_control()).take(200).collect();
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(prefix.join("BAD")) { let _ = writeln!(f, "{id}\t{why}"); }
    let _ = fs::write(prefix.join(".fresh-bad"), format!("{id}\n"));
}

/// A name that can only be a folder in `builds/`: it reaches `exec`, so nothing that could leave the folder gets through.
pub fn name_ok(tag: &str) -> bool { !tag.is_empty() && tag.len() <= 64 && !tag.starts_with('.') && tag.chars().all(|c| c.is_ascii_alphanumeric() || "-._".contains(c)) }

/// A release tag's order (`update::rel::Ver`'s rule, which a test in keep.rs holds this to): a prerelease before its release, prereleases by their numbers.
pub fn ver_key(tag: &str) -> (u64, u64, u64, bool, u64, u64) {
    let s = tag.trim(); let s = s.strip_prefix('v').unwrap_or(s);
    let (core, pre) = match s.split_once('-') { Some((c, p)) => (c, Some(p)), None => (s, None) };
    let mut c = core.split('.').map(|x| x.parse::<u64>().unwrap_or(0));
    let (a, b, d) = (c.next().unwrap_or(0), c.next().unwrap_or(0), c.next().unwrap_or(0));
    let nums: Vec<u64> = pre.map(|p| p.split('.').filter_map(|x| x.parse().ok()).collect()).unwrap_or_default();
    (a, b, d, pre.is_none(), nums.first().copied().unwrap_or(0), nums.get(1).copied().unwrap_or(0))
}
pub fn newer(a: &str, than: &str) -> bool { ver_key(a) > ver_key(than) }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Trial { pub tag: String, pub from: String, pub at: u64 }
pub fn trial(prefix: &Path) -> Option<Trial> {
    let v: Value = serde_json::from_str(&fs::read_to_string(dir(prefix).join("trial")).ok()?).ok()?;
    Some(Trial { tag: v["tag"].as_str()?.to_string(), from: v["from"].as_str().unwrap_or("").to_string(), at: v["at"].as_u64().unwrap_or(0) })
}
pub fn next(prefix: &Path) -> String { first(&dir(prefix).join("next")) }
pub fn good(prefix: &Path) -> Vec<String> { lines(&dir(prefix).join("good")) }
/// `tag` goes last; the newest 16 are kept.
pub fn add_good(prefix: &Path, tag: &str) {
    let mut g: Vec<String> = good(prefix).into_iter().filter(|b| b != tag).collect(); g.push(tag.to_string());
    let from = g.len().saturating_sub(16); let _ = put(&dir(prefix).join("good"), &(g[from..].join("\n") + "\n"));
}

/// What a launch does, before any window. `me`: the build this app is; `next`: the build `keep` staged; `sole`: no other app of this prefix runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Start {
    /// run as this build
    Stay,
    /// try this build: write the trial, then run its app in this one's place
    Try(String),
    /// the build last tried never opened its window: mark it bad and run as this build
    Failed { tag: String, why: String },
    /// a trial this launch cannot judge (CURRENT was moved by hand meanwhile: install.sh run again): forget it, run as this build
    Forget,
}
pub fn start(me: &str, next: &str, trial: Option<&Trial>, bad: &[String], exists: &dyn Fn(&str) -> bool, sole: bool) -> Start {
    // another app of this prefix runs: nothing is judged or moved under it
    if !sole { return Start::Stay }
    if let Some(t) = trial {
        // the trial itself, just started by the build it came from
        if t.tag == me { return Start::Stay }
        // the launchers still run the build it came from, so that build launching again means the trial never got to its window
        if t.from == me { return Start::Failed { tag: t.tag.clone(), why: "its app never opened its window".into() } }
        return Start::Forget;
    }
    if !name_ok(next) || next == me || bad.iter().any(|b| b == next) || !exists(next) || !newer(next, me) { return Start::Stay }
    Start::Try(next.to_string())
}

/// `Start::Try`: write the trial before the new app runs, so a crash before its window leaves the way back written down.
pub fn begin(prefix: &Path, tag: &str, from: &str) -> std::io::Result<()> { put(&dir(prefix).join("trial"), &json!({"tag": tag, "from": from, "at": now()}).to_string()) }
/// `Start::Failed`, or a trial that could not even be started: marked bad, never offered or tried again; the staged pointer goes with it.
pub fn failed(prefix: &Path, tag: &str, why: &str) {
    mark_bad(prefix, tag, why);
    let d = dir(prefix); let _ = fs::remove_file(d.join("trial"));
    if next(prefix) == tag { let _ = fs::remove_file(d.join("next")); }
    set_status(prefix, |s| { s["available"] = json!(""); s["said"] = json!({"stayed": tag}); if s["state"] == "ready" { s["state"] = json!("idle") } });
}
/// `Start::Forget`: the trial goes, and nothing is marked.
pub fn forget(prefix: &Path) { let _ = fs::remove_file(dir(prefix).join("trial")); }
/// The app's window is up: the build is proven here. A trial becomes CURRENT; the build CURRENT already names is remembered as good, so pruning keeps it.
/// Answers the build a trial moved to.
pub fn opened(prefix: &Path, me: &str) -> Option<String> {
    let t = trial(prefix);
    match t {
        Some(t) if t.tag == me => {
            add_good(prefix, me);
            if publish(prefix, me).is_err() { return None }
            let d = dir(prefix); let _ = fs::remove_file(d.join("trial"));
            if next(prefix) == me { let _ = fs::remove_file(d.join("next")); }
            set_status(prefix, |s| { s["state"] = json!("idle"); s["available"] = json!(""); s["said"] = json!({"updated": me}); });
            Some(me.to_string())
        }
        _ => { if current(prefix) == me { add_good(prefix, me); } None }
    }
}

/// Builds pruning keeps whatever the guard's rule says (`run::prunable`): CURRENT, the newest good build, and these: the two good builds before it
/// (a second app opened before a switch still runs the one CURRENT named then), the staged build, both sides of a trial, and the build this is.
pub fn protected(good: &[String], next: &str, trial: Option<&Trial>, running: &str) -> Vec<String> {
    let mut p: Vec<String> = good[good.len().saturating_sub(3)..].to_vec();
    for x in [next, running] { if !x.is_empty() { p.push(x.to_string()) } }
    if let Some(t) = trial { p.push(t.tag.clone()); p.push(t.from.clone()); }
    p
}

pub fn status(prefix: &Path) -> Value { serde_json::from_str(&fs::read_to_string(dir(prefix).join("status.json")).unwrap_or_default()).unwrap_or_else(|_| json!({})) }
pub fn set_status(prefix: &Path, f: impl FnOnce(&mut Value)) {
    let mut s = status(prefix); if !s.is_object() { s = json!({}); } f(&mut s); let _ = put(&dir(prefix).join("status.json"), &s.to_string());
}

/// Whether a guard runs a hub from this prefix: then it owns CURRENT, and the app leaves its builds alone. A running guard pins its builds under
/// `.pins/<port>` and unpins them when it stops; a pin a killed guard left is told apart by its port, where nothing answers.
pub fn guard_runs(prefix: &Path) -> bool {
    let ports: Vec<u16> = fs::read_dir(prefix.join(".pins")).map(|d| d.flatten().filter_map(|e| e.file_name().to_string_lossy().parse().ok()).collect()).unwrap_or_default();
    ports.into_iter().any(|p| std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], p)), std::time::Duration::from_millis(300)).is_ok())
}

/// The words for this device's row in Settings > Network, beside the hub's own, from `status.json`, and whether Check now is offered. The app
/// draws them through its catalog by the key (`gpui.appupdate.*`) with these arguments. `when`: the last check's time as the app shows a time.
pub fn line(s: &Value, when: &str) -> (&'static str, Vec<(&'static str, String)>, bool) {
    let g = |k: &str| s[k].as_str().unwrap_or("").to_string();
    let (avail, note, when) = (g("available"), g("note"), when.to_string());
    // how the last switch ended, said until a check finds something new
    let said = [("updated", "gpui.appupdate.updated"), ("stayed", "gpui.appupdate.stayed")].into_iter()
        .find_map(|(k, key)| s["said"][k].as_str().filter(|t| !t.is_empty()).map(|t| (key, t.to_string())));
    match g("state").as_str() {
        "off" => ("gpui.appupdate.off", vec![], false),
        "guard" => ("gpui.appupdate.guard", vec![], false),
        "checking" => ("gpui.appupdate.checking", vec![], false),
        "downloading" => ("gpui.appupdate.downloading", vec![("tag", avail)], false),
        "ready" => ("gpui.appupdate.ready", vec![("tag", avail)], true),
        "failed" if !note.is_empty() => ("gpui.appupdate.failed.note", vec![("note", note)], true),
        "failed" => ("gpui.appupdate.failed", vec![], true),
        _ => match (said, when.is_empty()) {
            (Some((key, tag)), true) => (key, vec![("tag", tag)], true),
            (Some((key, tag)), false) => (if key == "gpui.appupdate.updated" { "gpui.appupdate.updated.when" } else { "gpui.appupdate.stayed.when" }, vec![("tag", tag), ("when", when)], true),
            (None, false) => ("gpui.appupdate.idle", vec![("when", when)], true),
            (None, true) => ("gpui.appupdate.never", vec![], true),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tmp(n: &str) -> crate::tmp::TempDir { crate::tmp::dir(&format!("appkeep-{n}")) }
    fn all(_: &str) -> bool { true }
    fn none(_: &str) -> bool { false }
    fn t(tag: &str, from: &str) -> Trial { Trial { tag: tag.into(), from: from.into(), at: 1 } }

    #[test] fn a_staged_newer_build_is_tried_only_when_this_app_is_alone() {
        assert_eq!(start("v0.16.0", "v0.16.1", None, &[], &all, true), Start::Try("v0.16.1".into()));
        assert_eq!(start("v0.16.0", "v0.16.1", None, &[], &all, false), Start::Stay, "another app of this prefix runs: nothing moves under it");
        assert_eq!(start("v0.16.0", "", None, &[], &all, true), Start::Stay, "nothing staged");
        assert_eq!(start("v0.16.0", "v0.16.0", None, &[], &all, true), Start::Stay, "staged is what runs");
        assert_eq!(start("v0.16.1", "v0.16.0", None, &[], &all, true), Start::Stay, "older than this (an install by hand moved past it)");
        assert_eq!(start("v0.16.0", "v0.16.1", None, &["v0.16.1".into()], &all, true), Start::Stay, "bad here");
        assert_eq!(start("v0.16.0", "v0.16.1", None, &[], &none, true), Start::Stay, "pruned, or never whole");
        assert_eq!(start("v0.16.0", "../../x", None, &[], &all, true), Start::Stay, "no name that leaves builds/");
        assert_eq!(start("v0.15.4-nightly.20261113.1", "v0.15.4", None, &[], &all, true), Start::Try("v0.15.4".into()), "the release follows its nightlies");
    }
    #[test] fn a_trial_that_never_opened_its_window_is_failed_by_the_build_it_came_from() {
        let tr = t("v0.16.1", "v0.16.0");
        assert_eq!(start("v0.16.1", "v0.16.1", Some(&tr), &[], &all, true), Start::Stay, "the trial itself, just started");
        assert_eq!(start("v0.16.0", "v0.16.1", Some(&tr), &[], &all, true), Start::Failed { tag: "v0.16.1".into(), why: "its app never opened its window".into() });
        assert_eq!(start("v0.16.0", "v0.16.1", Some(&tr), &[], &all, false), Start::Stay, "the trial may still be starting in another app: not judged");
        assert_eq!(start("v0.16.2", "v0.16.1", Some(&tr), &[], &all, true), Start::Forget, "CURRENT moved by hand meanwhile: nothing is known of the trial, nothing is marked");
    }
    #[test] fn the_order_is_the_updaters() {
        assert!(newer("v0.16.0", "v0.15.9") && newer("0.10.0", "0.9.9") && newer("v0.16.0", "v0.16.0-beta.9"));
        assert!(newer("v0.3.1-nightly.20260923.2", "v0.3.1-nightly.20260923.1") && newer("0.15.1-beta.10", "0.15.1-beta.2"));
        assert!(!newer("v0.16.0", "v0.16.0") && !newer("v0.16.0-beta.1", "v0.16.0"));
    }
    #[test] fn names_that_could_leave_the_builds_folder_are_refused() {
        for n in ["v0.16.0", "v0.16.0-nightly.20261114.1"] { assert!(name_ok(n), "{n}"); }
        for n in ["", ".stage-x", "../x", "a/b", r"a\b", "v0.16.0 ", &"v".repeat(65)] { assert!(!name_ok(n), "{n:?}"); }
    }
    #[test] fn a_trial_becomes_current_only_once_its_window_is_up() {
        let d = tmp("open"); let p: &Path = &d;
        fs::create_dir_all(p.join("builds")).unwrap(); publish(p, "v1").unwrap(); put(&dir(p).join("next"), "v2\n").unwrap();
        assert_eq!(opened(p, "v1"), None); assert_eq!(good(p), vec!["v1"], "the build CURRENT names is good once its window opens");
        begin(p, "v2", "v1").unwrap();
        assert_eq!(current(p), "v1", "a trial leaves CURRENT alone: the launchers still run the build it came from");
        assert_eq!(opened(p, "v2"), Some("v2".into()));
        assert_eq!((current(p), good(p), next(p), trial(p)), ("v2".to_string(), vec!["v1".to_string(), "v2".to_string()], String::new(), None));
        assert_eq!(status(p)["said"]["updated"], "v2");
    }
    #[test] fn a_failed_trial_is_marked_bad_and_never_offered_again() {
        let d = tmp("fail"); let p: &Path = &d;
        publish(p, "v1").unwrap(); put(&dir(p).join("next"), "v2\n").unwrap(); begin(p, "v2", "v1").unwrap();
        failed(p, "v2", "its app never opened its window");
        assert_eq!(bad(p), vec!["v2"]); assert_eq!(bad_lines(p)[0].1, "its app never opened its window");
        assert_eq!((trial(p), next(p), current(p)), (None, String::new(), "v1".to_string()));
        assert_eq!(status(p)["said"]["stayed"], "v2");
        failed(p, "v2", "again"); assert_eq!(bad_lines(p).len(), 1, "one line a build");
        assert_eq!(start("v1", "v2", None, &bad(p), &all, true), Start::Stay);
    }
    #[test] fn pruning_keeps_both_sides_of_a_switch() {
        let g: Vec<String> = ["a", "b", "c", "d"].iter().map(|s| s.to_string()).collect();
        let p = protected(&g, "n", Some(&t("t", "f")), "r");
        for x in ["b", "c", "d", "n", "t", "f", "r"] { assert!(p.contains(&x.to_string()), "{x}"); } assert!(!p.contains(&"a".to_string()));
        assert_eq!(protected(&[], "", None, ""), Vec::<String>::new());
    }
    #[test] fn the_line_says_what_this_device_s_app_is_doing() {
        let a = |v: &[(&'static str, &str)]| v.iter().map(|(k, x)| (*k, x.to_string())).collect::<Vec<_>>();
        assert_eq!(line(&json!({}), ""), ("gpui.appupdate.never", vec![], true));
        assert_eq!(line(&json!({"state": "idle"}), "14:05"), ("gpui.appupdate.idle", a(&[("when", "14:05")]), true));
        assert_eq!(line(&json!({"state": "ready", "available": "v0.16.1"}), "14:05"), ("gpui.appupdate.ready", a(&[("tag", "v0.16.1")]), true));
        assert!(!line(&json!({"state": "checking"}), "").2); assert_eq!(line(&json!({"state": "downloading", "available": "v2"}), "").1, a(&[("tag", "v2")]));
        assert_eq!(line(&json!({"state": "failed", "note": "could not reach the release feed"}), "").0, "gpui.appupdate.failed.note");
        assert_eq!(line(&json!({"state": "idle", "note": "an old error", "said": {"updated": "v2"}}), "14:05"), ("gpui.appupdate.updated.when", a(&[("tag", "v2"), ("when", "14:05")]), true),
            "how the last switch ended stays beside the check; the keeper's old error does not");
        assert_eq!(line(&json!({"said": {"stayed": "v3"}}), ""), ("gpui.appupdate.stayed", a(&[("tag", "v3")]), true));
        assert_eq!(line(&json!({"state": "off"}), ""), ("gpui.appupdate.off", vec![], false));
        assert!(!line(&json!({"state": "guard"}), "").2, "a guard here updates it");
    }
    #[test] fn a_pin_with_nothing_on_its_port_is_a_guard_that_died() {
        let d = tmp("pins"); let p: &Path = &d; assert!(!guard_runs(p));
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap(); let port = l.local_addr().unwrap().port();
        fs::create_dir_all(p.join(".pins")).unwrap(); fs::write(p.join(".pins").join(port.to_string()), "v1\n").unwrap();
        assert!(guard_runs(p)); drop(l); assert!(!guard_runs(p));
    }
}
