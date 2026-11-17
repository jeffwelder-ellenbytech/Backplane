//! This device's own app, kept current where no guard does it: an installed build (`<prefix>/builds/<tag>/`) whose app uses a hub on another
//! machine (`launch.json`'s `url`). The rules and files are appkeep.rs's (shared with the guard); this is when they run (docs/deploy.md, "A desktop
//! app on another machine's hub"):
//! - at launch, before any window: the staged build is tried, or a trial that never opened its window is marked bad (`at_launch`);
//! - once the first frame is drawn: this build is proven here, and a trial becomes CURRENT (`opened`);
//! - then, and every six hours while the app runs, and on Check now: the build's own guard stages what is newer (`backplane builds keep`, detached).
//! Whatever updates it, Settings shows this app's version beside the hub's (`row`).
//! A local hub's guard owns the builds, so with one (or with `BACKPLANE_NO_UPDATE=1`, a package install, a build tree) none of this runs.
use crate::appkeep::{self, Start};
use std::{fs::File, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::OnceLock, time::Duration};

/// How often a running app looks for a newer build (the hub looks hourly; the release feed allows 60 unsigned calls an hour per address).
const EVERY: Duration = Duration::from_secs(6 * 3600);

#[derive(Clone, Debug, PartialEq)]
pub struct Here { pub prefix: PathBuf, pub me: String }
static HERE: OnceLock<Option<Here>> = OnceLock::new();
/// The shared hold on `clients.lock` for this process's life: a launch moves builds only when no app holds it.
static HELD: OnceLock<File> = OnceLock::new();

/// Where this app looks after its own build; None when it does not (`at_launch` decides once).
pub fn here() -> Option<&'static Here> { HERE.get().and_then(Option::as_ref) }
fn off() -> bool { std::env::var("BACKPLANE_NO_UPDATE").map_or(false, |v| v == "1") }

/// Whether this launch uses a hub on another machine, by main's own choice of what to open: no `--url`, no `BACKPLANE_HOME`, no local hub this
/// client was started on, and a `url` in launch.json.
pub fn remote(pending: bool, env_home: bool, local_hub: bool, saved_url: &str) -> bool { pending && !env_home && !local_hub && !saved_url.is_empty() }
/// The build this program is, when it runs from a guarded install's builds folder: (prefix, tag).
pub fn find(me: &Path) -> Option<Here> {
    let (_, prefix) = crate::launch::guarded_install(me)?;
    let me = me.parent()?.file_name()?.to_string_lossy().into_owned();
    appkeep::name_ok(&me).then_some(Here { prefix, me })
}

fn lock_file(prefix: &Path) -> Option<File> { std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(prefix.join("clients.lock")).ok() }
/// Held shared from here on, by this process. A launch deciding meanwhile is a moment; this waits it out.
fn hold(f: Option<File>, prefix: &Path) {
    let Some(f) = f.or_else(|| lock_file(prefix)) else { return };
    let _ = f.unlock(); if f.lock_shared().is_ok() { let _ = HELD.set(f); }
}
/// The tried build's app, in this one's place: the same process on Unix (Backplane.app's launcher did the same, so macOS still sees Backplane.app),
/// started and left on Windows (as the guard's `backplane` starts an app). Answers only when it could not be run.
fn run_instead(app: &Path) -> std::io::Error {
    let mut c = Command::new(app); c.args(std::env::args_os().skip(1));
    #[cfg(unix)] { use std::os::unix::process::CommandExt; c.exec() }
    #[cfg(not(unix))] { match c.spawn() { Ok(_) => std::process::exit(0), Err(e) => e } }
}

/// Before any window: decide this launch's build. A trial that never opened its window is marked bad here; a staged newer build is tried (this
/// process becomes its app). Only with no other app of this prefix running, no guard here, and updates on.
pub fn at_launch(remote: bool) {
    let h = if remote && std::env::var_os("APPIMAGE").is_none() && std::env::var_os("BACKPLANE_HUB_BIN").is_none() { std::env::current_exe().ok().and_then(|me| find(&me)) } else { None };
    let _ = HERE.set(h.clone());
    let Some(h) = h else { return };
    let p = &h.prefix;
    let f = lock_file(p);
    let sole = f.as_ref().map_or(false, |f| f.try_lock().is_ok());
    if off() || (sole && appkeep::guard_runs(p)) { return hold(f, p) }
    let s = appkeep::start(&h.me, &appkeep::next(p), appkeep::trial(p).as_ref(), &appkeep::bad(p), &|t| appkeep::app_of(p, t).is_file(), sole);
    match s {
        Start::Stay => {}
        Start::Forget => appkeep::forget(p),
        Start::Failed { tag, why } => { /* i18n-ok: a log line */ eprintln!("backplane-gpui: {tag} {why}: marked bad, {} stays", h.me); appkeep::failed(p, &tag, &why); }
        Start::Try(tag) => {
            if appkeep::begin(p, &tag, &h.me).is_ok() {
                /* i18n-ok: a log line */ eprintln!("backplane-gpui: trying {tag} (from {})", h.me);
                drop(f); // the trial takes the lock again for itself
                let e = run_instead(&appkeep::app_of(p, &tag));
                /* i18n-ok: the reason BAD keeps, never drawn */ appkeep::failed(p, &tag, &format!("its app would not start ({e})"));
                return hold(None, p);
            }
        }
    }
    hold(f, p)
}

/// The first frame is drawn: this build opened its window here. A trial becomes CURRENT; then the build's guard looks for something newer, now and
/// every six hours.
pub fn opened() {
    let Some(h) = here() else { return };
    if off() || appkeep::guard_runs(&h.prefix) { return }
    if let Some(t) = appkeep::opened(&h.prefix, &h.me) { /* i18n-ok: a log line */ eprintln!("backplane-gpui: {t} opened its window: it is CURRENT now"); }
    std::thread::spawn(|| loop { if let Some(mut c) = check() { let _ = c.wait(); } std::thread::sleep(EVERY); });
}

/// `backplane builds keep` of this build's own guard, detached: it outlives the window, and a second one while it runs ends at once (its lock).
/// None where this app does not look after its build, or the build has no guard.
pub fn check() -> Option<Child> {
    let h = here()?; if off() { return None }
    let g = appkeep::guard_of(&h.prefix, &h.me); if !g.is_file() { return None }
    let d = appkeep::dir(&h.prefix); let _ = std::fs::create_dir_all(&d);
    let log = std::fs::OpenOptions::new().create(true).append(true).open(d.join("keep.log")).ok();
    let mut c = Command::new(g);
    c.args(["builds", "keep", "--builds"]).arg(&h.prefix).args(["--running", &h.me, "--channel", &crate::local::path().map(|p| crate::local::Local::read(&p)).unwrap_or_default().app_channel]);
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(log.map_or(Stdio::null(), Stdio::from));
    crate::launch::detached(&mut c);
    c.spawn().ok()
}

/// A time of day as Settings shows the last check: the local clock's hours and minutes, `checked` seconds since the epoch.
pub fn hhmm(checked: u64, now: u64, local: (i32, i32, i32)) -> String {
    if checked == 0 || checked > now { return String::new() }
    let sod = (local.0 * 3600 + local.1 * 60 + local.2) as i64 - (now - checked) as i64;
    let sod = sod.rem_euclid(86400);
    format!("{:02}:{:02}", sod / 3600, sod % 3600 / 60)
}

/// The build this app is: its folder in a guarded install, else the version it was built as.
pub fn version() -> String {
    if let Some(h) = here() { return h.me.clone() }
    std::env::current_exe().ok().and_then(|me| { crate::launch::guarded_install(&me)?; Some(me.parent()?.file_name()?.to_string_lossy().into_owned()) }).unwrap_or_else(crate::install::tag)
}

/// This computer's app beside the hub's version, on the hub's Network and About pages, whenever this client is connected to a hub: the two can
/// differ (a hub on another machine, or one updated while this window stayed open). On Network it also says what updates it: where it keeps its
/// own build (a hub on another machine), what `keep` last did, with Check now and its channel; else this computer's hub (its guard), or its package.
pub fn row(l: &crate::local::Local, page: &str) -> Option<crate::screens::settings::Row> {
    use crate::{i18n::{tf, trs}, screens::settings::{Btn, Row}};
    let label = tf(if cfg!(target_os = "macos") { "gpui.appupdate.label.mac" } else { "gpui.appupdate.label" }, &[("tag", version().trim_start_matches('v').to_string().into())]); // as the hub's own row says its version
    let r = |note: String, buttons: Vec<Btn>| Some(Row { label: label.clone(), note, buttons, local: true, ..Default::default() });
    match (page, here()) {
        /* i18n-ok: drawn through trs */ ("about", _) => r(trs("Updates are under Network."), vec![]),
        ("network", Some(h)) => {
            let mut s = appkeep::status(&h.prefix);
            if off() { s["state"] = "off".into() }
            let (_, _, _, hh, mm, ss) = crate::plat::local_now();
            let when = hhmm(s["checked"].as_u64().unwrap_or(0), appkeep::now(), (hh, mm, ss));
            let (key, args, check) = appkeep::line(&s, &when);
            let args: Vec<(&str, crate::i18n::Arg)> = args.into_iter().map(|(k, v)| (k, v.into())).collect();
            let b = |label: String, name: &str, value: &str, on: bool| Btn { label, action: format!("local:{name}"), value: value.into(), on };
            let mut buttons: Vec<Btn> = if check { vec![b(trs("Check now"), "app-check", "", false)] } else { vec![] };
            buttons.extend(crate::local::APP_CHANNELS.iter().map(|c| b(c.to_string(), "app-channel", c, l.app_channel == *c)));
            r(tf(key, &args), buttons)
        }
        ("network", None) => {
            let guarded = std::env::current_exe().ok().and_then(|me| crate::launch::guarded_install(&me)).is_some();
            r(tf(if guarded { "gpui.appupdate.local" } else { "gpui.appupdate.package" }, &[]), vec![])
        }
        _ => None,
    }
}
/// Where the row goes: after the hub's own update row on Network (it follows "Update channel"), after the hub's version on About; else at the end.
pub fn row_at(labels: &[&str]) -> usize {
    if let Some(i) = labels.iter().position(|l| *l == "Update channel") { return (i + 2).min(labels.len()) }
    labels.iter().position(|l| l.starts_with("Hub: Backplane ") || l.starts_with("Backplane ")).map_or(labels.len(), |i| i + 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn only_a_client_on_another_machine_s_hub_looks_after_its_build() {
        assert!(remote(true, false, false, "http://192.0.2.7:3787"));
        assert!(!remote(false, false, false, "http://192.0.2.7:3787"), "--url: a hub was named on the command line");
        assert!(!remote(true, true, false, "http://192.0.2.7:3787"), "BACKPLANE_HOME: this device's hub");
        assert!(!remote(true, false, true, "http://192.0.2.7:3787"), "a local hub this client was started on");
        assert!(!remote(true, false, false, ""), "launch.json names a home");
    }
    #[test] fn the_build_is_the_folder_this_app_runs_from() {
        let d = crate::tmp::uncreated("selfupdate-find");
        let me = d.join("builds/v0.16.0").join(if cfg!(windows) { "backplane-gpui.exe" } else { "backplane-gpui" }); std::fs::create_dir_all(me.parent().unwrap()).unwrap();
        assert_eq!(find(&me), None, "no CURRENT, no guard: not a guarded install");
        std::fs::write(d.join("CURRENT"), "v0.16.0\n").unwrap(); std::fs::write(d.join(if cfg!(windows) { "backplane.exe" } else { "backplane" }), b"x").unwrap();
        assert_eq!(find(&me), Some(Here { prefix: d.to_path_buf(), me: "v0.16.0".into() }));
        assert_eq!(find(&d.join("target/release/backplane-gpui")), None, "a build tree");
    }
    #[test] fn the_last_check_is_a_time_of_day_on_this_clock() {
        assert_eq!(hhmm(1000, 1000 + 125 * 60, (14, 10, 0)), "12:05");
        assert_eq!(hhmm(1000, 1000 + 3600, (0, 30, 0)), "23:30", "before midnight");
        assert_eq!(hhmm(0, 5, (1, 0, 0)), "", "never"); assert_eq!(hhmm(9, 5, (1, 0, 0)), "", "a clock that went back");
    }
    #[test] fn the_row_sits_after_the_hub_s_own_update_row() {
        assert_eq!(row_at(&["Network", "Update channel", "Backplane v0.16.0", "Tailscale"]), 3);
        assert_eq!(row_at(&["Network", "Update channel"]), 2); assert_eq!(row_at(&["Network", "Tailscale"]), 2, "an older hub: at the end");
        assert_eq!(row_at(&["About", "Hub: Backplane v0.16.0", "Browser"]), 2, "About: under the hub's version");
        assert_eq!(row_at(&["About", "Backplane v0.15.2", "Browser"]), 2, "an older hub's label");
    }
}
