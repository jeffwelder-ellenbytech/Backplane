import Base
import ./host.bend as H
import ./proc.bend as P
import ../core/utf8.bend as U
import ../core/http.bend as W
import ../core/fmget.bend as FGET
import ../core/images.bend as IM
import ../core/fm.bend as FMP

# GET /download?thread=<id>&path=<from its folder>: the Files tab's
# download (core/fmget.bend), for a client that presents the token or a
# paired device's credential (server.bend's gate, as for /message-image): a
# folder as a zip made in <home>/zips and removed once sent, a file as it
# is. The folder is the thread's own, from the hub's log, never the
# request's; FGET.Fget.refused and FGET.Fget.sh say what is not served.

def FgetHTTP.sent(r: Socket & Result<&1, &1, U32 & String, Unit>) -> IO(Socket):
  (s, _) = r
  IO.pure(Socket, s)

def FgetHTTP.out(s: Socket, bs: List<&2, U32>) -> IO(Socket):
  IO.bind(Socket & Result<&1, &1, U32 & String, Unit>, Socket, H.Sock.send_bytes(s, bs), FgetHTTP.sent)

def FgetHTTP.finish(s: Socket, bs: List<&2, U32>) -> IO(Unit):
  do IO<Unit>:
    s2 : Socket <- FgetHTTP.out(s, bs)
    Socket.close(s2)

def FgetHTTP.gone.k(none: Bool, +dir: String) -> IO(Unit):
  match none:
    case True{}: IO.pure(Unit, Unit{})
    case False{}: IO.bind(P.Ran, Unit, P.Proc.run("sh", ["-c", "rm -rf -- \"$1\"", "sh", dir], "/"), r => IO.pure(Unit, Unit{}))

def FgetHTTP.gone(+dir: String) -> IO(Unit):
  FgetHTTP.gone.k(String.is_empty(dir), dir)

def FgetHTTP.send(zip: Bool, s: Socket, +name: String, +size: String, +path: String, +tmp: String) -> IO(Unit):
  do IO<Unit>:
    s2 : Socket <- FgetHTTP.out(s, U.Utf8.encode(FGET.Fget.head(zip, name, size)))
    sent : Socket & Result<&1, &1, U32 & String, Unit> <- H.Sock.send_path(s2, path, 0, U32.from_nat(FMP.Fm.num(size)))
    s3 : Socket <- FgetHTTP.sent(sent)
    Socket.close(s3)
    FgetHTTP.gone(tmp)

def FgetHTTP.got.k(ps: List<&2, String>, s: Socket, +root: String, +rel: String, +zips: String) -> IO(Unit):
  match ps:
    case +k <> +n <> +rest:
      +path = String.join(rest, "\t")
      FgetHTTP.send(String.eq(k, "zip"), s, FGET.Fget.name(root, rel, String.eq(k, "zip")), n, path, Bool.pick(String, String.eq(k, "zip"), FGET.Fget.tmp(zips, path), ""))
    case _:
      FgetHTTP.finish(s, W.Http.text("404 Not Found", "unavailable"))

def FgetHTTP.got(r: P.Ran, s: Socket, +root: String, +rel: String, +zips: String) -> IO(Unit):
  match r:
    case P.Ran{0, +out}:
      FgetHTTP.got.k(String.split(String.trim(out), '\t'), s, root, rel, zips)
    case P.Ran{_, +out}:
      FgetHTTP.finish(s, W.Http.text("404 Not Found", String.trim(out)))

def FgetHTTP.run(+home: String, s: Socket, +root: String, +rel: String) -> IO(Unit):
  IO.bind(P.Ran, Unit, P.Proc.run("sh", ["-c", FGET.Fget.sh(), "sh", root, rel, home ++ "/zips", U32.show(IM.Img.cap()), home], "/"), r => FgetHTTP.got(r, s, root, rel, home ++ "/zips"))

def FgetHTTP.gate(ok: Bool, +why: String, +home: String, s: Socket, +root: String, +rel: String) -> IO(Unit):
  match ok:
    case True{}:
      FgetHTTP.run(home, s, root, rel)
    case False{}:
      FgetHTTP.finish(s, W.Http.text("404 Not Found", why))

def FgetHTTP.home.k(none: Bool, +home: String, s: Socket, +root: String, +rel: String) -> IO(Unit):
  match none:
    case True{}:
      FgetHTTP.finish(s, W.Http.text("500 Internal Server Error", "no home"))
    case False{}:
      FgetHTTP.gate(String.is_empty(FGET.Fget.refused(home, root)), FGET.Fget.refused(home, root), home, s, root, rel)

def FgetHTTP.home(r: Result<&1, &1, U32 & String, String>, s: Socket, +root: String, +rel: String) -> IO(Unit):
  match r:
    case Done{+home}:
      FgetHTTP.home.k(String.is_empty(home), home, s, root, rel)
    case Fail{_}:
      FgetHTTP.home.k(True{}, "", s, root, rel)

def FgetHTTP.rooted(+root: String, s: Socket, +rel: String) -> IO(Unit):
  IO.bind(Result<&1, &1, U32 & String, String>, Unit, IO.get_env("BACKPLANE_HOME"), r => FgetHTTP.home(r, s, root, rel))

def FgetHTTP.check(ok: Bool, s: Socket, +thread: String, +rel: String, ask: String -> IO(String)) -> IO(Unit):
  match ok:
    case True{}:
      IO.bind(String, Unit, ask(thread), root => FgetHTTP.rooted(root, s, rel))
    case False{}:
      FgetHTTP.finish(s, W.Http.text("400 Bad Request", "bad path"))

# allowed: the request passed the hub's gate; ask: the thread's folder from
# the hub's log ("" for none; server.bend's Hub.files.root)
def FgetHTTP.serve(allowed: Bool, s: Socket, +thread: String, +rel: String, ask: String -> IO(String)) -> IO(Unit):
  match allowed:
    case True{}:
      FgetHTTP.check(FGET.Fget.ok(thread, rel), s, thread, rel, ask)
    case False{}:
      FgetHTTP.finish(s, W.Http.text("401 Unauthorized", "this Backplane needs its pairing token"))
