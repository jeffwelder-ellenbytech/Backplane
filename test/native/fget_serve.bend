import Base
import ../../src/server/host.bend as H
import ../../src/server/argv.bend as A
import ../../src/server/fget.bend as FGH
import ../../src/core/http.bend as W
import ../../src/core/auth.bend as AUTH
import ../../src/core/attach.bend as ATT

# A stand-in for the hub's HTTP for GET /download only (src/server/fget.bend,
# the hub's own handler, behind the hub's own gate, AUTH.Auth.allowed), so
# test/tools/files_zip_e2e.ts can run where the whole hub cannot be built.
# It takes the hub's --home and --port (other flags are ignored), keeps the
# token in <home>/token as the hub does, and answers GET /hello. Where the
# hub reads a thread's folder from its log (Hub.files.root), this reads it
# from BACKPLANE_FGET_ROOTS ("<thread><tab><folder>" lines). Emitted with
# bend test/native/fget_serve.bend -o build/fget/serve.js, run by bun.

def Serve.flag.at(xs: List<&2, String>, +prev: String, +name: String, +d: String) -> String:
  match xs:
    case Nil{}:
      d
    case +x <> t:
      Bool.pick(String, String.eq(prev, name), x, Serve.flag.at(t, x, name, d))

# the value after a flag (d when it is not there)
def Serve.flag(xs: List<&2, String>, +name: String, +d: String) -> String:
  Serve.flag.at(xs, "", name, d)

def Serve.copy(xs: List<String>) -> List<&2, String>:
  match xs:
    case Nil{}:
      Nil{}
    case x <> t:
      x <> Serve.copy(t)

def Serve.digits(s: String, +n: U32) -> U32:
  match s:
    case SNil{}:
      n
    case SCon{Chr{+c}, t}:
      Serve.digits(t, ((n * 10 : U32) + (c - 48 : U32) : U32))

def Serve.root.go(ls: List<&2, String>, +thread: String) -> String:
  match ls:
    case Nil{}:
      ""
    case +l <> t:
      Bool.pick(String, String.starts_with(l, thread ++ "\t"), String.drop(l, 1n+String.length(thread)), Serve.root.go(t, thread))

def Serve.root.k(r: Result<&1, &1, U32 & String, String>, +thread: String) -> String:
  match r:
    case Done{+v}:
      Serve.root.go(String.split(v, '\n'), thread)
    case Fail{_}:
      ""

# a thread's folder ("" for one it does not know)
def Serve.root(+thread: String) -> IO(String):
  IO.bind(Result<&1, &1, U32 & String, String>, String, IO.get_env("BACKPLANE_FGET_ROOTS"), r => IO.pure(String, Serve.root.k(r, thread)))

def Serve.route.k(dl: Bool, hello: Bool, s: Socket, +p: String, +allowed: Bool) -> IO(Unit):
  match dl hello:
    case True{} _:
      FGH.FgetHTTP.serve(allowed, s, ATT.Att.from_uri("file://" ++ W.Http.param(p, "thread")), ATT.Att.from_uri("file://" ++ W.Http.param(p, "path")), t => Serve.root(t))
    case False{} True{}:
      FGH.FgetHTTP.finish(s, W.Http.text("200 OK", "fget_serve"))
    case False{} False{}:
      FGH.FgetHTTP.finish(s, W.Http.text("404 Not Found", "not found"))

def Serve.route(s: Socket, req: W.Request, +token: String) -> IO(Unit):
  match req:
    case W.Request{_, +p, +hs}:
      Serve.route.k(String.eq(W.Http.route(p), "/download"), String.eq(W.Http.route(p), "/hello"), s, p, Bool.and(AUTH.Auth.allowed(hs, p, token), AUTH.Auth.credential(hs, p, token)))

def Serve.head.got(r: Socket & Result<&1, &1, U32 & String, List<&2, U32>>, buf: List<&2, U32>, k: Socket -> List<&2, U32> -> IO(Unit)) -> IO(Unit):
  (s, res) = r
  match res:
    case Done{bs}:
      k(s, List.append(&2, U32, buf, bs))
    case Fail{_}:
      Socket.close(s)

def Serve.head.k(m: Maybe<&2, W.Split>, s: Socket, buf: List<&2, U32>, +token: String, k: Socket -> List<&2, U32> -> IO(Unit)) -> IO(Unit):
  match m:
    case Some{W.Split{head, _}}:
      Serve.route(s, W.Http.request(head), token)
    case None{}:
      IO.bind(Socket & Result<&1, &1, U32 & String, List<&2, U32>>, Unit, H.Sock.recv_bytes(s, 65536), r => Serve.head.got(r, buf, k))

def Serve.head(fuel: Nat, s: Socket, +buf: List<&2, U32>, +token: String) -> IO(Unit):
  match fuel:
    case 0n:
      Socket.close(s)
    case 1n+f:
      Serve.head.k(W.Http.split(buf), s, buf, token, s2 => b2 => Serve.head(f, s2, b2, token))

def Serve.got(r: Listener & Result<&1, &1, U32 & String, Socket>, +token: String, k: Listener -> IO(Unit)) -> IO(Unit):
  (l, res) = r
  match res:
    case Done{s}:
      do IO<Unit>:
        IO.spawn(Unit, Serve.head(64n, s, Nil{}, token))
        k(l)
    case Fail{_}:
      k(l)

def Serve.loop(fuel: Nat, l: Listener, +token: String) -> IO(Unit):
  match fuel:
    case 0n:
      Listener.close(l)
    case 1n+f:
      IO.bind(Listener & Result<&1, &1, U32 & String, Socket>, Unit, TCP.accept(l), r => Serve.got(r, token, l2 => Serve.loop(f, l2, token)))

def Serve.listened(r: Result<&1, &1, U32 & String, Listener>, +token: String) -> IO(Unit):
  match r:
    case Done{l}:
      Serve.loop(1000000n, l, token)
    case Fail{_}:
      IO.print("fget_serve: cannot listen")

def Serve.start(t: Result<&1, &1, U32 & String, String>, +port: U32) -> IO(Unit):
  match t:
    case Done{+token}:
      IO.bind(Result<&1, &1, U32 & String, Listener>, Unit, H.Net.listen("127.0.0.1", port), l => Serve.listened(l, token))
    case Fail{_}:
      IO.print("fget_serve: no token")

def Serve.go(+home: String, +port: U32) -> IO(Unit):
  do IO<Unit>:
    H.Env.put("BACKPLANE_HOME", home)
    t : Result<&1, &1, U32 & String, String> <- H.FS.pairing_token(home ++ "/token")
    Serve.start(t, port)

def Serve.args(+xs: List<&2, String>) -> IO(Unit):
  Serve.go(Serve.flag(xs, "--home", "/nonexistent"), Serve.digits(Serve.flag(xs, "--port", "3799"), 0))

def main() -> IO(Unit):
  IO.bind(List<String>, Unit, A.Argv.args(), xs => Serve.args(Serve.copy(xs)))
