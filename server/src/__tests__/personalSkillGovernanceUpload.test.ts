import { existsSync, mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillGovernanceInvariantError } from '../data/skillGovernance/index.js';
import { createPersonalSkillGovernanceUpload, personalSkillResourceId } from '../services/tenantSkillGovernanceUpload.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function uploadBuffer(buffer: Buffer, originalname: string): Express.Multer.File { return { fieldname:'files', originalname, encoding:'7bit', mimetype:'application/octet-stream', size:buffer.length, buffer, destination:'', filename:'', path:'', stream:undefined as never }; }
function file(content: string): Express.Multer.File { return uploadBuffer(Buffer.from(content), 'SKILL.md'); }
interface ZipEntry { name: string; content: string; mode?: number; declaredSize?: number }
function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.content);
    const declaredSize = entry.declaredSize ?? data.length;
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    data.copy(local, 30 + name.length);
    locals.push(local);

    const directory = Buffer.alloc(46 + name.length);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(declaredSize, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    name.copy(directory, 46);
    central.push(directory);
    offset += local.length;
  }
  const centralSize = central.reduce((total, entry) => total + entry.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, eocd]);
}
const md=(name:string)=>`---\nname: ${name}\ndescription: governed upload\n---\nbody`;
function rig(input:{tenantId?:string; publish?:ReturnType<typeof vi.fn>; restore?:ReturnType<typeof vi.fn>; getResource?:ReturnType<typeof vi.fn>; select?:ReturnType<typeof vi.fn>; selectionError?:Error; selected?:boolean}={}) {
  const root=mkdtempSync(join(tmpdir(),'personal-skill-governance-')); roots.push(root);
  const actor={id:'user-1',username:'alice',tenantId:input.tenantId??'tenant-a',role:'user'};
  const publish=input.publish??vi.fn().mockImplementation(async value=>({resource:{skillId:value.skillId,tenantId:value.tenantId,scope:'personal',ownerUserId:value.ownerUserId,status:'published',currentVersionId:'v1',revision:2,createdAt:'x',createdBy:value.createdBy,updatedAt:'x',updatedBy:value.createdBy},version:{versionId:'v1',skillId:value.skillId,versionNumber:1,definition:value.definition,digest:'d',publishedAt:'x',publishedBy:value.createdBy},created:true}));
  const restore=input.restore??vi.fn().mockImplementation(async value=>({resource:{skillId:value.skillId,tenantId:value.tenantId,scope:'personal',ownerUserId:value.ownerUserId,status:'published',currentVersionId:'v2',revision:value.expectedRevision+1,createdAt:'x',createdBy:value.publishedBy,updatedAt:'x',updatedBy:value.publishedBy},version:{versionId:'v2',skillId:value.skillId,versionNumber:2,definition:value.definition,digest:'d2',publishedAt:'x',publishedBy:value.publishedBy},created:true}));
  const getResource=input.getResource??vi.fn().mockResolvedValue(null);
  const select=input.select??(input.selectionError?vi.fn().mockRejectedValue(input.selectionError):vi.fn().mockResolvedValue(undefined));
  const upload=createPersonalSkillGovernanceUpload({skills:{getResource,createAndPublishResource:publish,restoreAndPublishResource:restore} as never,skillConfigStore:{getPoolVisibility:()=>({}),getUserSelectedSkills:()=>input.selected?['rollback-restore']:[],setUserSkillSelected:select} as never,userStore:{findById:(id:string)=>id===actor.id?actor:undefined} as never,agentCwd:join(root,'agents'),sharedDir:join(root,'shared'),tenantSkillsRootDir:join(root,'tenants')});
  return {upload,publish,restore,select,getResource,dir:(id:string)=>join(root,'agents','tenant-a','user-1','.ky-agent','skills',id)};
}
describe('个人 Skill 治理上传服务',()=>{
  it('强绑定 owner/tenant，发布 v1、落盘并默认启用',async()=>{const x=rig(); const r=await x.upload({tenantId:'tenant-a',actorUserId:'user-1',files:[file(md('personal-tool'))]}); expect(r).toMatchObject({status:'succeeded',selected:true,resource:{tenantId:'tenant-a',scope:'personal',ownerUserId:'user-1'},version:{versionNumber:1}}); expect(r.resource.skillId).toBe(personalSkillResourceId('user-1','personal-tool')); expect(await readFile(join(x.dir('personal-tool'),'SKILL.md'),'utf8')).toContain('governed upload'); expect(x.select).toHaveBeenCalledWith('alice','personal-tool',true);});
  it('删除遗留治理资源后同名重导会恢复原资源并发布下一版本',async()=>{const resourceId=personalSkillResourceId('user-1','personal-tool'); const x=rig({getResource:vi.fn().mockResolvedValue({skillId:resourceId,tenantId:'tenant-a',scope:'personal',ownerUserId:'user-1',status:'published',currentVersionId:'v1',revision:2,createdAt:'x',createdBy:'user-1',updatedAt:'x',updatedBy:'user-1'})}); const r=await x.upload({tenantId:'tenant-a',actorUserId:'user-1',files:[file(md('personal-tool'))]}); expect(r).toMatchObject({status:'succeeded',selected:true,resource:{skillId:resourceId,status:'published'},version:{versionNumber:2}}); expect(x.restore).toHaveBeenCalledWith(expect.objectContaining({skillId:resourceId,scope:'personal',ownerUserId:'user-1',expectedRevision:2})); expect(x.publish).not.toHaveBeenCalled(); expect(existsSync(join(x.dir('personal-tool'),'SKILL.md'))).toBe(true);});
  it('同名重导恢复失败时回滚目录与默认选择',async()=>{const resourceId=personalSkillResourceId('user-1','rollback-restore'); const select=vi.fn().mockResolvedValue(undefined); const x=rig({getResource:vi.fn().mockResolvedValue({skillId:resourceId,tenantId:'tenant-a',scope:'personal',ownerUserId:'user-1',status:'retired',revision:3}),restore:vi.fn().mockRejectedValue(new SkillGovernanceInvariantError('SKILL_RESOURCE_VERSION_CONFLICT')),select,selected:true}); await expect(x.upload({tenantId:'tenant-a',actorUserId:'user-1',files:[file(md('rollback-restore'))]})).rejects.toMatchObject({code:'SKILL_VERSION_CONFLICT'}); expect(existsSync(x.dir('rollback-restore'))).toBe(false); expect(select).toHaveBeenNthCalledWith(1,'alice','rollback-restore',true); expect(select).toHaveBeenNthCalledWith(2,'alice','rollback-restore',true);});
  it('忽略 macOS ZIP 元数据后发布个人 Skill，且不落盘 __MACOSX',async()=>{const x=rig(); const archive=zip([{name:'__MACOSX/._SKILL.md',content:'metadata'},{name:'__MACOSX/personal-tool/._helper.py',content:'metadata'},{name:'SKILL.md',content:md('macos-personal')}]); const r=await x.upload({tenantId:'tenant-a',actorUserId:'user-1',files:[uploadBuffer(archive,'macos-personal.zip')]}); expect(r).toMatchObject({status:'succeeded',selected:true,skill:{id:'macos-personal'}}); expect(existsSync(join(x.dir('macos-personal'),'__MACOSX'))).toBe(false);});
  it.each([
    ['路径穿越','__MACOSX/../evil.txt',0o100644],
    ['反斜杠路径穿越','__MACOSX\\..\\evil.txt',0o100644],
    ['绝对路径','/__MACOSX/._evil.txt',0o100644],
    ['路径深度超限',`__MACOSX/${Array.from({length:16},()=> 'nested').join('/')}/._evil.txt`,0o100644],
    ['符号链接','__MACOSX/._leak',0o120777],
  ])('macOS 元数据例外不放宽%s校验',async(_label,name,mode)=>{const x=rig(); const archive=zip([{name,content:'/etc/passwd',mode},{name:'SKILL.md',content:md('unsafe-macos')}]); await expect(x.upload({tenantId:'tenant-a',actorUserId:'user-1',files:[uploadBuffer(archive,'unsafe.zip')]})).rejects.toMatchObject({code:'SKILL_PACKAGE_UNSAFE',status:400}); expect(x.publish).not.toHaveBeenCalled();});
  it('macOS 元数据仍计入文件数与大小配额',async()=>{const count=rig(); const tooMany=zip([...Array.from({length:300},(_,index)=>({name:`__MACOSX/._${index}`,content:'x'})),{name:'SKILL.md',content:md('too-many')}]); await expect(count.upload({tenantId:'tenant-a',actorUserId:'user-1',files:[uploadBuffer(tooMany,'too-many.zip')]})).rejects.toMatchObject({code:'SKILL_PACKAGE_LIMIT_EXCEEDED',status:413}); const size=rig(); const tooLarge=zip([{name:'__MACOSX/._large',content:'x',declaredSize:26*1024*1024},{name:'SKILL.md',content:md('too-large')}]); await expect(size.upload({tenantId:'tenant-a',actorUserId:'user-1',files:[uploadBuffer(tooLarge,'too-large.zip')]})).rejects.toMatchObject({code:'SKILL_PACKAGE_LIMIT_EXCEEDED',status:413});});
  it('跨 tenant 拒绝；治理失败回滚；偏好失败不返回假成功',async()=>{const denied=rig({tenantId:'tenant-b'}); await expect(denied.upload({tenantId:'tenant-a',actorUserId:'user-1',files:[file(md('denied'))]})).rejects.toMatchObject({code:'SKILL_OWNER_SCOPE_DENIED',status:403}); const failed=rig({publish:vi.fn().mockRejectedValue(new SkillGovernanceInvariantError('SKILL_RESOURCE_VERSION_CONFLICT'))}); await expect(failed.upload({tenantId:'tenant-a',actorUserId:'user-1',files:[file(md('rollback'))]})).rejects.toMatchObject({code:'SKILL_VERSION_CONFLICT'}); expect(existsSync(failed.dir('rollback'))).toBe(false); const selected=rig({selectionError:new Error('down')}); await expect(selected.upload({tenantId:'tenant-a',actorUserId:'user-1',files:[file(md('selection'))]})).rejects.toThrow('down'); expect(existsSync(selected.dir('selection'))).toBe(false);});
  it('首次默认启用失败不发布治理资源，二次重试可成功',async()=>{const resources=new Map<string,unknown>(); let fail=true; const publish=vi.fn().mockImplementation(async value=>{const resource={skillId:value.skillId,tenantId:value.tenantId,scope:'personal',ownerUserId:value.ownerUserId,status:'published',currentVersionId:'v1',revision:2,createdAt:'x',createdBy:value.createdBy,updatedAt:'x',updatedBy:value.createdBy}; resources.set(value.skillId,resource); return {resource,version:{versionId:'v1',skillId:value.skillId,versionNumber:1,definition:value.definition,digest:'d',publishedAt:'x',publishedBy:value.createdBy},created:true};}); const getResource=vi.fn().mockImplementation(async id=>resources.get(id)??null); const select=vi.fn().mockImplementation(async (_username:string,_skillId:string,enabled:boolean)=>{if(enabled&&fail){fail=false; throw new Error('selection-store-down');}}); const x=rig({publish,getResource,select}); const input={tenantId:'tenant-a',actorUserId:'user-1',files:[file(md('retryable'))]}; const resourceId=personalSkillResourceId('user-1','retryable'); await expect(x.upload(input)).rejects.toThrow('selection-store-down'); expect(resources.has(resourceId)).toBe(false); expect(publish).not.toHaveBeenCalled(); expect(existsSync(x.dir('retryable'))).toBe(false); const result=await x.upload(input); expect(result).toMatchObject({status:'succeeded',selected:true}); expect(resources.has(resourceId)).toBe(true); expect(publish).toHaveBeenCalledTimes(1); expect(select).toHaveBeenCalledTimes(2); expect(select).toHaveBeenNthCalledWith(1,'alice','retryable',true); expect(select).toHaveBeenNthCalledWith(2,'alice','retryable',true);});
});
