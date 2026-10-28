import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.PRISM_READY_FIXTURE === "1") {
  let requests = 0;
  globalThis.fetch = async (input, options = {}) => {
    if (++requests > 100) throw new Error("Fixture request bound exceeded");
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = options.method ?? "GET";
    appendFileSync(process.env.PRISM_READY_TRACE, `${method} ${url.pathname}\n`);
    let data, headers = {};
    if (url.origin === "https://embedding.invalid" && url.pathname === "/v1/embeddings" && method === "POST") {
      const body = JSON.parse(options.body);
      data = {data: body.input.map((_, index) => ({index,embedding:[1,0,0,0]}))};
    } else {
      assert.equal(method,"GET","Generative inference and GitHub mutations are forbidden");
      assert.equal(url.origin,"https://api.github.com");
      const kind=process.env.PRISM_READY_KIND;
      if(kind) {
        assert.equal(url.pathname,`/repos/example/project/${kind === "pr" ? "pulls" : "issues"}`);
        const count=kind === "pr" ? 451 : 1158;
        const records=Array.from({length:count},(_,i)=>({id:i+1,number:i+1,state:"open",title:`Fixture ${i+1}`,body:"body",user:{login:"fixture"},labels:[],created_at:"2026-01-01T00:00:00Z",updated_at:"2026-01-02T00:00:00Z",...(kind==="pr"?{head:{sha:"head"},base:{sha:"base"}}:{})}));
        const page=Number(url.searchParams.get("page")??1);
        data=url.searchParams.has("since")?[]:records.slice((page-1)*100,page*100);
        if(!url.searchParams.has("since")&&page*100<count){const next=new URL(url);next.searchParams.set("page",String(page+1));headers={link:`<${next}>; rel="next"`};}
      } else if(url.pathname==="/repos/example/project/pulls") data=Number(url.searchParams.get("page")??1)>1?[]:[1,2].map(number=>({id:number,number,title:"Same fixture",body:"Same body",state:"open",user:{login:"fixture"},labels:[],created_at:"2026-01-01T00:00:00Z",updated_at:"2026-01-02T00:00:00Z",head:{sha:`h${number}`},base:{sha:"base"},additions:1,deletions:1,changed_files:1}));
      else if(url.pathname==="/repos/example/project/issues") data=[];
      else throw new Error(`Unexpected route ${url}`);
    }
    return new Response(JSON.stringify(data),{headers:{"content-type":"application/json",...headers}});
  };
} else {
  const cli=resolve(process.argv[2]);
  const dir=mkdtempSync(join(tmpdir(),"prism-ready-package-"));
  const trace=join(dir,"trace.log");writeFileSync(trace,"");
  const env={PATH:process.env.PATH,HOME:dir,PRISM_DATA_DIR:dir,PRISM_READY_FIXTURE:"1",PRISM_READY_TRACE:trace,GITHUB_TOKEN:"fixture",EMBEDDING_PROVIDER:"openai",EMBEDDING_API_KEY:"fixture",EMBEDDING_MODEL:"fixture",EMBEDDING_DIMENSIONS:"4",EMBEDDING_BASE_URL:"https://embedding.invalid/v1"};
  writeFileSync(join(dir,"prism.config.yaml"),"repo: example/project\n");
  const base=["--import",fileURLToPath(import.meta.url),cli];
  const invoke=(args,extra={})=>execFileSync(process.execPath,[...base,...args],{cwd:dir,env:{...env,...extra},encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:30000});
  invoke(["scan","--repo","example/project","--rest","--json"]);
  const scanTrace=readFileSync(trace,"utf8");
  assert.equal(scanTrace.split("\n").filter(s=>s.startsWith("POST ")).length,1);
  const dupes=invoke(["dupes","--repo","example/project","--json"]);
  assert.ok(dupes.includes("Same fixture"));
  const housekeeping=join(dir,"housekeeping.md");
  invoke(["dupes","--repo","example/project","--housekeeping",housekeeping]);
  assert.ok(readFileSync(housekeeping,"utf8").length>0);
  invoke(["review","--queue-db",join(dir,"v4.sqlite"),"--status","--json"]);
  invoke(["review","--repo","example/project","--show","1"]);
  assert.equal(readFileSync(trace,"utf8"),scanTrace,"dupes/housekeeping/history/status must be offline");
  const cases=[];
  for(const [kind,count,cold] of [["issue",1158,24],["pr",451,10]]) {
    writeFileSync(trace,"");
    const extra={PRISM_READY_KIND:kind};
    const args=["review","--repo","example/project","--type",kind,"--operations-db",join(dir,`${kind}.sqlite`),"--json"];
    const snapshot=JSON.parse(invoke([...args,"--all-open","--dry-run"],extra));
    assert.equal(snapshot.totalOpen,count);assert.equal(snapshot.inventoryKnown,count);assert.equal(snapshot.requests.reserved,0);
    assert.equal(readFileSync(trace,"utf8").trim().split("\n").length,cold);
    invoke([...args,"--all-open","--dry-run"],extra);
    assert.equal(readFileSync(trace,"utf8").trim().split("\n").length,cold+1);
    for(const mode of ["--status","--dashboard","--recover"]) invoke([...args,mode],extra);
    assert.equal(readFileSync(trace,"utf8").trim().split("\n").length,cold+1);
    assert.ok(!readFileSync(trace,"utf8").includes("POST"));
    cases.push({kind,count,cold,warm:1,paidCalls:0,inspectionCalls:0});
  }
  const error=spawnSync(process.execPath,[...base,"review","--status"],{cwd:dir,env,encoding:"utf8"});
  assert.equal(error.status,1);assert.match(error.stderr,/queue-db.*operations/);
  console.log(JSON.stringify({runtime:process.version,result:"PASS",scanItems:2,embeddingFakeRequests:1,generativeCalls:0,githubWrites:0,dupesAndHousekeeping:"PASS",legacyQueueAndHistory:"PASS",cases,directory:dir}));
}
