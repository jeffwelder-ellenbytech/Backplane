import Base
import ./check.bend as C
import ../src/core/json.bend as J
import ../src/core/client.bend as U
import ../src/core/model.bend as M
import ../src/core/i18n.bend as I
import ../src/web/view.bend as V
import ../src/web/dom.bend as D
import ../src/web/presentation.bend as WP

# The web's Files tab offers downloads (view.bend's View.files, View.fm.get;
# client.bend's Fm.get): Download in the bar is the folder on show as a zip,
# each row's link is the folder as a zip or the file itself, plain links the
# browser saves (GET /download, test/tools/files_zip_e2e.ts).

def log() -> List<&2, M.Change>:
  [M.ProjectCreated{"p1", "board", "/w/board", 1n}, M.ThreadCreated{"t1", "p1", "Bring-up", M.Local{}, "", "", "claude", "", 2n}]

def ui(a: U.Act) -> U.Ui:
  match a:
    case U.Act{u, _}:
      u

def act(+u: U.Ui, +a: String, +v: String) -> U.Ui:
  ui(U.Ui.act(u, a, v))

def listed(+u: U.Ui, +dir: String, +entries: String) -> U.Ui:
  U.Ui.recv(u, J.Json.obj([J.KV{"t", J.Str{"reply"}}, J.KV{"id", J.Num{U.Ui.info(u, "fm.id:t1")}}, J.KV{"ok", J.Flag{True{}}},
    J.KV{"result", J.Json.obj([J.KV{"fmEntries", J.Str{entries}}, J.KV{"fmDir", J.Str{dir}}, J.KV{"fmRoot", J.Str{"/w/board"}}, J.KV{"thread", J.Str{"t1"}}])}]))

def shown() -> U.Ui:
  listed(act(act(U.Ui.fold(log(), U.Ui.init(10n)), "select", "t1"), "fm", ""), "", "d\t0\thw\nf\t5\tnotes.txt\n")

def html.go(ns: List<&2, D.Node>) -> String:
  match ns:
    case Nil{}: ""
    case n <> t: J.Json.show(WP.Node.write(n)) ++ html.go(t)

def html() -> String:
  html.go(V.View.files(I.En{}, shown()))

def main() -> IO(Unit):
  do IO<Unit>:
    +h : String = html()
    C.Check.str("Download in the bar is the folder as a zip", Bool.show(String.contains(h, "\"value\":\"/download?thread=t1&path=\"")), "True")
    C.Check.str("the bar says Download", Bool.show(String.contains(h, "Download this folder as a zip")), "True")
    C.Check.str("a folder row downloads its zip", Bool.show(String.contains(h, "\"value\":\"/download?thread=t1&path=hw\"")), "True")
    C.Check.str("a file row downloads the file", Bool.show(String.contains(h, "\"value\":\"/download?thread=t1&path=notes.txt\"")), "True")
    C.Check.str("a file row's tip", Bool.show(String.contains(h, "Download this file")), "True")
    C.Check.str("the links download", Bool.show(String.contains(h, "{\"name\":\"download\",\"value\":\"\"}")), "True")
    C.Check.str("the download icon", Bool.show(String.contains(h, "{\"name\":\"data-icon\",\"value\":\"download\"}")), "True")
