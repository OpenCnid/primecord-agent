import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableDiscordTurnStore } from "../src/modes/daemon/durable-turn-store.js";
const roots: string[]=[]; afterEach(()=>roots.splice(0).forEach((p)=>rmSync(p,{recursive:true,force:true})));
function store(){const root=mkdtempSync(join(tmpdir(),"prime-turn-store-"));roots.push(root);const path=join(root,"turns.jsonl");return {path,store:new DurableDiscordTurnStore(path)};}
describe("DurableDiscordTurnStore",()=>{
 it("deduplicates an immutable turn across restart and persists its exact result",()=>{const {path,store:first}=store();const r=first.reserve("t1","session-file","digest");expect(first.reserve("t1","session-file","digest")).toEqual(r);first.advance("t1",r.fence,"accepted");first.advance("t1",r.fence,"completed","exact result");expect(new DurableDiscordTurnStore(path).get("t1")).toEqual(expect.objectContaining({status:"completed",terminalResult:"exact result"}));});
 it("makes cancellation absorbing so a stale completion cannot resurrect output",()=>{const {store: turns}=store();const r=turns.reserve("t1","session","digest");turns.advance("t1",r.fence,"running");const cancelled=turns.cancel("t1");expect(turns.advance("t1",r.fence,"completed","stale")).toEqual(cancelled);expect(turns.get("t1")).toEqual(expect.objectContaining({status:"cancelled",terminalResult:undefined}));});
 it("rejects a duplicate turn id with different immutable input",()=>{const {store: turns}=store();turns.reserve("t1","session","digest");expect(()=>turns.reserve("t1","other","digest")).toThrow("conflict");});
});
