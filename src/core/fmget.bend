import Base
import ./fm.bend as FM
import ./images.bend as IM
import ./utf8.bend as U

# Downloads from the Files tab (pure): a folder as a zip, a file as it is.
# A client asks the hub's GET /download?thread=<id>&path=<from the root>
# (src/server/fget.bend); it never names a folder of the machine. The hub
# takes the thread's folder from its own log (server.bend's Hub.files.root:
# its worktree, else its project's root; "" for a thread it does not know or
# a removed project), refuses one inside its own home but for a scratch
# thread's (Fget.refused), and runs Fget.sh with the folder and the path as
# arguments, which refuses anything whose real folder is not under the
# root's real folder, inside the real home but its scratch, or holding the
# home, and anything that is a symlink. These defs say which requests go
# that far, the URL a client links to, and the name it is saved under
# (laws fget_*).

def Fget.line(+s: String) -> Bool:
  Bool.or(String.contains(s, "\n"), String.contains(s, "\r"))

# a request the hub runs at all: a thread of its own (not one elsewhere,
# "<link>~<id>"), a path from its folder that never names ".." (core/fm.bend's
# Fm.safe), neither with a line break
def Fget.ok(+thread: String, +rel: String) -> Bool:
  Bool.and(Bool.not(String.is_empty(thread)), Bool.and(Bool.not(String.contains(thread, "~")), Bool.and(FM.Fm.safe(rel),
    Bool.not(Bool.or(Fget.line(thread), Fget.line(rel))))))

# where a client downloads a folder or a file of a thread's folder (both
# percent-encoded as UTF-8; "" a path is the folder itself)
def Fget.url(+thread: String, +rel: String) -> String:
  "/download?thread=" ++ IM.Img.enc.bytes(U.Utf8.encode(thread)) ++ "&path=" ++ IM.Img.enc.bytes(U.Utf8.encode(rel))

def Fget.under(+dir: String, +p: String) -> Bool:
  Bool.or(String.eq(p, dir), String.starts_with(p, dir ++ "/"))

def Fget.refused.k(none: Bool, +home: String, +root: String) -> String:
  match none:
    case True{}:
      "no such thread"
    case False{}:
      Bool.pick(String, Bool.not(String.starts_with(root, "/")), "no such thread",
        Bool.pick(String, Bool.and(Fget.under(home, root), Bool.not(String.starts_with(root, home ++ "/scratch/"))), "inside Backplane's home", ""))

# why the hub will not serve a thread's folder, "" when it will: it knows
# no folder for the thread, or the folder is inside the hub's home (its
# token, secrets and vault) and is not a scratch thread's
# (<home>/scratch/<thread>)
def Fget.refused(+home: String, +root: String) -> String:
  Fget.refused.k(Bool.or(String.is_empty(root), String.is_empty(home)), home, root)

def Fget.base.go(ps: List<&2, String>, +last: String) -> String:
  match ps:
    case Nil{}:
      last
    case +p <> t:
      Fget.base.go(t, Bool.pick(String, String.is_empty(p), last, p))

# the last name of a path, trailing "/" or not ("project" for one that has
# none, as "/")
def Fget.base(+p: String) -> String:
  Fget.base.go(String.split(p, '/'), "project")

def Fget.name.k(zip: Bool, +base: String) -> String:
  match zip:
    case True{}: base ++ ".zip"
    case False{}: base

# the name a download is saved under: the file's own, or the folder's
# (the project's at the root) with ".zip"
def Fget.name(+root: String, +rel: String, zip: Bool) -> String:
  Fget.name.k(zip, Fget.base(Bool.pick(String, String.is_empty(rel), root, rel)))

def Fget.plain(+c: U32) -> Bool:
  Bool.and(Bool.and(U32.is_ge(c, 32), U32.is_le(c, 126)), Bool.not(Bool.or(U32.is_eq(c, 34), U32.is_eq(c, 92))))

def Fget.ascii.go(s: String, acc: String) -> String:
  match s:
    case SNil{}:
      String.reverse(acc)
    case SCon{Chr{+c}, t}:
      Fget.ascii.go(t, SCon{Bool.pick(Char, Fget.plain(c), Chr{c}, '_'), acc})

# a name as a quoted header value: printable ASCII but '"' and '\', the rest
# '_' (so no line break ever reaches the header)
def Fget.ascii(s: String) -> String:
  Fget.ascii.go(s, SNil{})

# the Content-Disposition value: the plain name for every browser, and the
# exact one as RFC 6266's filename* (UTF-8, percent-encoded)
def Fget.disposition(+name: String) -> String:
  "attachment; filename=\"" ++ Fget.ascii(name) ++ "\"; filename*=UTF-8''" ++ IM.Img.enc.bytes(U.Utf8.encode(name))

# the hub's script: $1 the root, $2 the path from it, $3 the hub's folder
# for zips (<home>/zips), $4 the most bytes, $5 the hub's home. It prints "zip<tab>size<tab>
# zip file" or "file<tab>size<tab>file", else why not (exit 1). A zip is
# made in a fresh folder of its own under $3 (the hub removes it once
# sent; one left by a hub that stopped goes after an hour); it leaves .git
# and .backplane out and stores symlinks as links (-y), so nothing outside
# the folder goes in.
def Fget.sh() -> String:
  "no() { echo \"$1\"; exit 1; }; cd \"$1\" 2>/dev/null || no 'no such folder'; rr=$(pwd -P); p=\"$2\"; while [ \"${p%/}\" != \"$p\" ]; do p=\"${p%/}\"; done; " ++
  "if [ -z \"$p\" ]; then b=$(basename \"$rr\"); cd .. || no 'no such folder'; else case \"$p\" in */*) cd \"./${p%/*}\" 2>/dev/null || no 'no such folder';; esac; b=\"${p##*/}\"; fi; " ++
  "case \"$(pwd -P)/$b/\" in \"$rr\"/*) ;; *) no 'not in the project';; esac; t=\"$(pwd -P)/$b\"; hr=$(cd \"$5\" 2>/dev/null && pwd -P); " ++
  "case \"$t/\" in \"$hr\"/scratch/?*) ;; \"$hr\"/*) no 'inside Backplane home';; esac; case \"$hr/\" in \"$t\"/*) no 'holds Backplane home';; esac; " ++
  "if [ -L \"$b\" ]; then no 'a link'; elif [ -d \"$b\" ]; then command -v zip >/dev/null 2>&1 || no 'zip is not installed'; mkdir -p \"$3\" || no 'cannot write'; " ++
  "find \"$3\" -mindepth 1 -maxdepth 1 -mmin +60 -exec rm -rf {} + 2>/dev/null; d=$(mktemp -d \"$3/z.XXXXXXXX\") || no 'cannot write'; " ++
  "zip -r -q -y \"$d/out.zip\" \"./$b\" -x '*/.git/*' '*/.git' '*/.backplane/*' '*/.backplane' 2>/dev/null || { rm -rf \"$d\"; no 'zip failed'; }; n=$(wc -c < \"$d/out.zip\" | tr -d ' '); [ \"$n\" -le \"$4\" ] || { rm -rf \"$d\"; no 'too large'; }; printf 'zip\\t%s\\t%s\\n' \"$n\" \"$d/out.zip\"; " ++
  "elif [ -f \"$b\" ]; then n=$(wc -c < \"$b\" | tr -d ' '); [ \"$n\" -le \"$4\" ] || no 'too large'; printf 'file\\t%s\\t%s\\n' \"$n\" \"$(pwd -P)/$b\"; else no 'no such file'; fi"

def Fget.tmp.name(+n: String) -> Bool:
  Bool.and(Bool.not(String.is_empty(n)), Bool.not(Bool.or(String.contains(n, "/"), String.contains(n, ".."))))

def Fget.tmp.k(ok: Bool, +path: String) -> String:
  match ok:
    case True{}: String.take(path, Nat.sub(String.length(path), 8n))
    case False{}: ""

# the folder a zip was made in, for the hub to remove once it is sent: only
# a "<zips>/z.<name>/out.zip" the script made gives one, else ""
def Fget.tmp(+zips: String, +path: String) -> String:
  Fget.tmp.k(Bool.and(Bool.and(String.starts_with(zips, "/"), String.starts_with(path, zips ++ "/z.")), Bool.and(String.ends_with(path, "/out.zip"),
    Fget.tmp.name(String.take(String.drop(path, String.length(zips ++ "/z.")), Nat.sub(Nat.sub(String.length(path), String.length(zips ++ "/z.")), 8n))))), path)

# the HTTP head a download is sent with
def Fget.head(zip: Bool, +name: String, +size: String) -> String:
  "HTTP/1.1 200 OK\r\nContent-Type: " ++ Bool.pick(String, zip, "application/zip", "application/octet-stream") ++ "\r\nContent-Length: " ++ size ++
    "\r\nContent-Disposition: " ++ Fget.disposition(name) ++ "\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
