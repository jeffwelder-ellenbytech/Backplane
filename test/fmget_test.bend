import Base
import ./check.bend as C
import ../src/core/fmget.bend as FGET

# Downloads from the Files tab (core/fmget.bend): the name a download is
# saved under, its header, the URL, which requests run, and the only
# folder the hub removes after sending a zip. The script itself runs
# end to end in test/tools/files_zip_e2e.ts.

def main() -> IO(Unit):
  do IO<Unit>:
    C.Check.str("zip names", String.join([FGET.Fget.name("/w/board", "", True{}), FGET.Fget.name("/w/board", "hw/main", True{}), FGET.Fget.name("/w/board", "hw/x.kicad_pcb", False{}), FGET.Fget.name("/", "", True{})], "|"), "board.zip|main.zip|x.kicad_pcb|project.zip")
    C.Check.str("the saved name, plain and exact", FGET.Fget.disposition("caf\u{e9} \"b\".zip"), "attachment; filename=\"caf_ _b_.zip\"; filename*=UTF-8''caf%C3%A9%20%22b%22.zip")
    C.Check.str("a zip's head", FGET.Fget.head(True{}, "board.zip", "12"), "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: 12\r\nContent-Disposition: attachment; filename=\"board.zip\"; filename*=UTF-8''board.zip\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n")
    C.Check.str("only the hub's own zip folder is removed", String.join([FGET.Fget.tmp("/h/zips", "/h/zips/z.Ab/out.zip"), FGET.Fget.tmp("/h/zips", "/w/board/out.zip"), FGET.Fget.tmp("zips", "zips/z.a/out.zip")], "|"), "/h/zips/z.Ab||")
    C.Check.str("a file's head", FGET.Fget.head(False{}, "x.kicad_pcb", "2"), "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 2\r\nContent-Disposition: attachment; filename=\"x.kicad_pcb\"; filename*=UTF-8''x.kicad_pcb\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n")
    C.Check.str("the URL names the thread, never a folder", FGET.Fget.url("t1", "hw/a&b#c d"), "/download?thread=t1&path=hw/a%26b%23c%20d")
    C.Check.str("requests that run", String.join([Bool.show(FGET.Fget.ok("t1", "")), Bool.show(FGET.Fget.ok("t1", "hw/main")), Bool.show(FGET.Fget.ok("t1", "../x")), Bool.show(FGET.Fget.ok("t1", "/etc")), Bool.show(FGET.Fget.ok("", "hw")), Bool.show(FGET.Fget.ok("m1~t1", "hw")), Bool.show(FGET.Fget.ok("t1", "ab"))], "|"), "True|True|False|False|False|False|False")
    C.Check.str("what of the home is not served", String.join([FGET.Fget.refused("/h/.bp", ""), FGET.Fget.refused("/h/.bp", "/h/.bp"), FGET.Fget.refused("/h/.bp", "/h/.bp/secrets"), FGET.Fget.refused("/h/.bp", "/h/.bp/scratch"), FGET.Fget.refused("/h/.bp", "relative")], "|"), "no such thread|inside Backplane's home|inside Backplane's home|inside Backplane's home|no such thread")
    C.Check.str("scratch threads and other folders are served", String.join([FGET.Fget.refused("/h/.bp", "/h/.bp/scratch/t1"), FGET.Fget.refused("/h/.bp", "/h/.bp2"), FGET.Fget.refused("/h/.bp", "/h"), FGET.Fget.refused("/h/.bp", "/w/board")], "|"), "|||")
