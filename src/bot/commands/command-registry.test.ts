import {describe,expect,it} from "vitest";
import {commands} from "../client.js";
describe("channel framework command surface",()=>{
 it("registers only the channel conversation controls and both bulk commands",()=>{
  const names=commands.map(c=>c.data.name);
  expect(names).toContain("sessions");expect(names).toContain("restore");expect(names).toContain("multi-delete");expect(names).toContain("multi-archive");
  for(const removed of ["register","unregister","switch","clear-sessions"])expect(names).not.toContain(removed);
  expect(new Set(names).size).toBe(names.length);expect(names).toHaveLength(16);
  for(const command of commands)expect(command.data.toJSON().description.length).toBeLessThanOrEqual(100);
 });
});
