// -*- coding: utf-8 -*-
import fs from "node:fs";
import vm from "node:vm";

const c = fs.readFileSync("src-tauri/web.html", "utf8");
const m = c.indexOf('<script type="module">') + '<script type="module">'.length;
const n = c.indexOf("</script>", m);
const js = c.slice(m, n);
console.log("html len:", c.length, "js len:", js.length);
try {
  new vm.Script(js);
  console.log("EMBEDDED JS COMPILES OK");
} catch (e) {
  console.log("STILL BROKEN:", e.message);
}
