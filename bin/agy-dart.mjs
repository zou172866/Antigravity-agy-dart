#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {runTargets} from "../scripts/targets/index.mjs";
const src=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [cmd,...args]=process.argv.slice(2);
async function outline() {
  const {extractSymbolsFromLines,renderOutlineWithinBudget}=await import("../context/lib/code-outline.js");
  const {collectSourceFiles}=await import("../context/lib/repo-skeleton.js");
  if(!args[0] || args[0].startsWith("--")) throw Error("outline <path> [--depth N] [--map] [--json]");
  const root=path.resolve(args[0]), depthAt=args.indexOf("--depth");
  const depth=depthAt<0?8:Number(args[depthAt+1]);
  if(!Number.isInteger(depth)||depth<0) throw Error("Invalid depth");
  const files=fs.statSync(root).isDirectory()?collectSourceFiles(root,120,depth):[root];
  const rows=files.map(file=>{
    const text=fs.readFileSync(file,"utf8"),lines=text.split(/\r?\n/),bytes=Buffer.byteLength(text);
    const row={path:path.relative(process.cwd(),file),lines:lines.length,estimatedTokens:Math.ceil(bytes/4)};
    if(!args.includes("--map")){
      row.outline=renderOutlineWithinBudget(row.path,lines.length,extractSymbolsFromLines(file,lines),null,files.length, {bracketLines:true});
      row.savedPercent=bytes?Math.round(100*(1-Buffer.byteLength(row.outline)/bytes)):0;
    }
    return row;
  });
  console.log(args.includes("--json")?JSON.stringify(rows,null,2):rows.map(r=>r.outline?r.outline+"\nSavings: "+r.savedPercent+"%":r.path+"  "+r.lines+" lines  ~"+r.estimatedTokens+" tokens").join("\n"));
}
try {
  if(cmd==="outline") await outline();
  else if(cmd==="dashboard") {
    const r=spawnSync(process.execPath,[path.join(src,"sidecars/dashboard/server.mjs"),...args],{stdio:"inherit",windowsHide:true});
    if(r.error) throw r.error;
    process.exitCode=r.status??1;
  }
  else if(["install","uninstall","doctor","status","mode","tool-loading"].includes(cmd)) await runTargets(src,[cmd,...args]);
  else if(["compare","session","cache","audit"].includes(cmd)) {
    let script="fast/benchmark.mjs", pass=[cmd,...args];
    if(cmd==="audit" && args[0]!=="session"){
      if(args[0]==="skills"){
        script="scripts/cache-audit.mjs";
        pass=["--skills-only",...args.slice(1)];
      } else if(args[0]==="safety"){
        script="scripts/cache-audit.mjs";
        pass=["--safety-audit",...args.slice(1)];
      } else if(args[0]==="quota"){
        script="scripts/quota-audit.mjs";
        pass=args.slice(1);
      } else {
        script=args[0]==="prefix"?"scripts/prefix-budget.mjs":"scripts/cache-audit.mjs";
        pass=["prefix","cache"].includes(args[0])?args.slice(1):args;
      }
    } else if(cmd==="audit") pass=args;
    const r=spawnSync(process.execPath,[path.join(src,script),...pass],{stdio:"inherit",windowsHide:true});
    if(r.error) throw r.error;
    process.exitCode=r.status??1;
  } else if(!cmd || cmd==="--help" || cmd==="-h") console.log("agy-dart install|uninstall|doctor|status|mode|tool-loading|dashboard|outline|compare|session|cache|audit");
  else throw Error("Unknown command: "+cmd);
} catch(error) {console.error(error.message);process.exitCode=1;}
