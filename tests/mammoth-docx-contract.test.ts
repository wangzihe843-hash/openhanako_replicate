import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute as readDocument } from "../plugins/office/tools/read-document.ts";
import { createEnhancedReadFile } from "../lib/sandbox/read-enhanced.ts";
import { extractDocxEmbeddedImages, wrapReadOfficeMedia } from "../lib/sandbox/read-office-media.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const drawing = `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="image"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="image1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

async function writeDocx(filePath: string, body: string, options: { externalImage?: string; styles?: string; styleMap?: string } = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${options.externalImage || "media/image.png"}"${options.externalImage ? ' TargetMode="External"' : ""}/><Relationship Id="link1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/><Relationship Id="link2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://untrusted.invalid/document" TargetMode="External"/><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="numbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`);
  const documentBody = options.externalImage ? body.replaceAll('r:embed="image1"', 'r:link="image1"') : body;
  zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${documentBody}</w:body></w:document>`);
  zip.file("word/styles.xml", `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${options.styles || ""}</w:styles>`);
  zip.file("word/numbering.xml", `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
  zip.file("word/media/image.png", PNG);
  if (options.styleMap) zip.file("mammoth/style-map", options.styleMap);
  await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }));
}

describe("Mammoth DOCX application contracts (real package, local files)", () => {
  let tempDir: string;
  let network: ReturnType<typeof vi.fn<() => never>>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hana-mammoth-contract-"));
    network = vi.fn(() => { throw new Error("DOCX parsing must stay offline"); });
    vi.stubGlobal("fetch", network);
    vi.spyOn(http, "request").mockImplementation(network);
    vi.spyOn(https, "request").mockImplementation(network);
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(network);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await fs.rm(tempDir, { recursive: true, force: true });
    expect(network).not.toHaveBeenCalled();
  });

  it("preserves Office text/HTML/table/numbering and enhanced UTF-8 Buffer output", async () => {
    const filePath = path.join(tempDir, "representative.docx");
    await writeDocx(filePath, paragraph("Hello 中文 &amp; &lt;tag&gt;") + `<w:tbl><w:tr><w:tc>${paragraph("Cell A")}</w:tc><w:tc>${paragraph("Cell B")}</w:tc></w:tr></w:tbl><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First item</w:t></w:r></w:p>`);
    const text = await readDocument({ filePath });
    expect(text.details.office).toMatchObject({ kind: "docx", format: "text", filePath, filename: "representative.docx", ext: ".docx", truncated: false, warnings: [] });
    expect(text.content[0].text).toBe("Hello 中文 & <tag>\n\nCell A\n\nCell B\n\nFirst item\n\n");
    const buffer = await createEnhancedReadFile()(filePath);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString("utf8")).toBe(text.content[0].text);
    const html = await readDocument({ filePath, outputFormat: "html" });
    expect(html.details.office).toMatchObject({ kind: "docx", format: "html", warnings: [] });
    expect(html.content[0].text).toBe("<p>Hello 中文 &amp; &lt;tag&gt;</p><table><tr><td><p>Cell A</p></td><td><p>Cell B</p></td></tr></table><ol><li>First item</li></ol>");
    const truncated = await readDocument({ filePath, maxChars: 5 });
    expect(truncated.details.office.truncated).toBe(true);
    expect(truncated.content[0].text).toBe("Hello\n[Truncated at 5 characters]");
    for (const outputFormat of ["json", "markdown"]) {
      expect((await readDocument({ filePath, outputFormat })).details.error.code).toBe("OFFICE_READ_FAILED");
    }
  });

  it("reads customXml and tracked moved content with the new parser", async () => {
    const filePath = path.join(tempDir, "revision.docx");
    await writeDocx(filePath, `<w:customXml>${paragraph("Custom paragraph")}</w:customXml><w:moveFrom>${paragraph("Old location")}</w:moveFrom><w:moveTo>${paragraph("New location")}</w:moveTo><w:p><w:moveTo><w:r><w:t>Moved run</w:t></w:r></w:moveTo></w:p>`);
    const result = await readDocument({ filePath });
    expect(result.content[0].text).toBe("Custom paragraph\n\nNew location\n\nMoved run\n\n");
    expect((await createEnhancedReadFile()(filePath)).toString()).toBe(result.content[0].text);
  });

  it("keeps async embedded image bytes/hash and SessionFile ownership", async () => {
    const filePath = path.join(tempDir, "embedded.docx");
    await writeDocx(filePath, paragraph("Image text") + drawing);
    const hash = crypto.createHash("sha256").update(PNG).digest("hex");
    expect(await extractDocxEmbeddedImages(filePath)).toEqual([{ index: 1, mimeType: "image/png", buffer: PNG, base64: PNG.toString("base64"), hash }]);
    const sessionPath = path.join(tempDir, "sessions", "one.jsonl");
    const recordFileOperation = vi.fn((entry) => ({ ...entry, fileId: "image-one", id: "image-one", kind: "image", mime: "image/png", status: "available", filename: entry.label }));
    const wrapped = wrapReadOfficeMedia({ name: "read", execute: async () => ({ content: [{ type: "text", text: "Image text" }] }) }, tempDir, { hanakoHome: tempDir, getSessionPath: () => sessionPath, getSessionIdForPath: () => "session-one", recordFileOperation, getVisionBridge: () => null, isVisionAuxiliaryEnabled: () => false });
    const ctx = { model: { input: ["text", "image"] } };
    const first = await wrapped.execute("read-1", { path: filePath }, null, null, ctx);
    const second = await wrapped.execute("read-2", { path: filePath }, null, null, ctx);
    const registration = recordFileOperation.mock.calls[0][0];
    expect(registration).toMatchObject({ sessionId: "session-one", sessionPath, origin: "agent_read_docx_media", storageKind: "managed_cache", operation: "read" });
    expect(path.relative(tempDir, registration.filePath).startsWith("..")).toBe(false);
    expect(await fs.readFile(registration.filePath)).toEqual(PNG);
    expect(first.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: PNG.toString("base64") });
    expect(first.details.media.items[0]).toMatchObject({ type: "session_file", fileId: "image-one", sessionId: "session-one", sessionPath });
    expect(first.details.officeMedia.resourceKeys).toEqual(second.details.officeMedia.resourceKeys);
  });

  it("retains untrusted links as unsanitized HTML without fetching them", async () => {
    const filePath = path.join(tempDir, "untrusted-links.docx");
    await writeDocx(filePath, `<w:p><w:hyperlink r:id="link1"><w:r><w:t>Unsafe link</w:t></w:r></w:hyperlink><w:hyperlink r:id="link2"><w:r><w:t>External link</w:t></w:r></w:hyperlink></w:p>`);
    const result = await readDocument({ filePath, outputFormat: "html" });
    // This is a parser-output contract, not approval to render this HTML.
    expect(result.content[0].text).toContain('href="javascript:alert(1)"');
    expect(result.content[0].text).toContain('href="https://untrusted.invalid/document"');
    expect((await createEnhancedReadFile()(filePath)).toString()).toBe("Unsafe linkExternal link\n\n");
  });

  it("does not read linked files outside the ZIP, including reserved style IDs", async () => {
    const sentinel = path.join(tempDir, "private.png");
    await fs.writeFile(sentinel, PNG);
    const filePath = path.join(tempDir, "external.docx");
    await writeDocx(filePath, paragraph("Local only") + drawing, { externalImage: pathToFileURL(sentinel).href, styles: '<w:style w:type="paragraph" w:styleId="__proto__"><w:name w:val="externalFileAccess"/></w:style><w:style w:type="paragraph" w:styleId="constructor"><w:name w:val="constructor"/></w:style>' });
    const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
    expect(await extractDocxEmbeddedImages(filePath)).toEqual([]);
    const result = await readDocument({ filePath, outputFormat: "html" });
    expect(result.content[0].text).not.toContain(PNG.toString("base64"));
    expect(result.details.office.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ type: "error", message: expect.stringContaining("external file access is disabled") })]));
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototype);
  });

  it("preserves bad ZIP error contracts and stops when materialization/read is denied", async () => {
    const filePath = path.join(tempDir, "bad.docx");
    await fs.writeFile(filePath, "PK\u0003\u0004truncated");
    expect((await readDocument({ filePath })).details.error.code).toBe("OFFICE_READ_FAILED");
    expect((await createEnhancedReadFile()(filePath)).toString()).toMatch(/^\[.+\]$/);
    await expect(extractDocxEmbeddedImages(filePath)).rejects.toThrow();
    const recordFileOperation = vi.fn();
    const denied = wrapReadOfficeMedia({ name: "read", execute: async () => { throw new Error("access denied"); } }, tempDir, { hanakoHome: tempDir, recordFileOperation });
    await expect(denied.execute("denied", { path: filePath }, null, null, {})).rejects.toThrow("access denied");
    expect(recordFileOperation).not.toHaveBeenCalled();
    const materialize = vi.fn(async () => { throw new Error("resource denied"); });
    const result = await readDocument({ resource: { kind: "local-file", path: filePath }, filePath }, { resources: { materialize } });
    expect(result.details.error).toMatchObject({ code: "OFFICE_READ_FAILED", message: "resource denied" });
    expect(materialize).toHaveBeenCalledOnce();
    expect((await readDocument({ filePath: "relative.docx" })).details.error.code).toBe("OFFICE_READ_FAILED");
  });

  it("does not let style types pollute options or enable a later external image read", async () => {
    const poisoned = path.join(tempDir, "style-types.docx");
    const linked = path.join(tempDir, "linked.docx");
    const sentinel = path.join(tempDir, "private.png");
    await fs.writeFile(sentinel, PNG);
    await writeDocx(poisoned, paragraph("Style types"), { styles: '<w:style w:type="__proto__" w:styleId="externalFileAccess"><w:name w:val="synthetic-style"/></w:style>' });
    await writeDocx(linked, drawing, { externalImage: pathToFileURL(sentinel).href });
    // Keep even the vulnerable baseline's prototype mutations in a short-lived process.
    const script = `const fs=require('node:fs');const allowed=process.argv.slice(1);const reads=[];const original=fs.readFile;fs.readFile=function(p,...args){reads.push(String(p));if(!allowed.includes(String(p)))throw Error('Unexpected file read: '+p);return original.call(this,p,...args)};const originalAsync=fs.promises.readFile;fs.promises.readFile=async function(p,...args){reads.push(String(p));if(!allowed.includes(String(p)))throw Error('Unexpected file read: '+p);return originalAsync.call(this,p,...args)};let network=0;const block=()=>{network++;throw Error('Network forbidden')};global.fetch=block;require('node:http').request=block;require('node:https').request=block;require('node:net').Socket.prototype.connect=block;const mammoth=require('mammoth');const assert=require('node:assert/strict');const proto=Object.getOwnPropertyDescriptors(Object.prototype);(async()=>{await mammoth.convertToHtml({path:allowed[0]});assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype),proto);const result=await mammoth.convertToHtml({path:allowed[1]});assert(result.messages.some(m=>m.message.includes('external file access is disabled')));console.log(JSON.stringify({network,reads}))})().catch(e=>{console.error(e);process.exitCode=1});`;
    const result = spawnSync(process.execPath, ["--max-old-space-size=128", "-e", script, poisoned, linked], { cwd: process.cwd(), timeout: 5000, encoding: "utf8", maxBuffer: 1024 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ network: 0, reads: [poisoned, linked] });
  });

  it("bounds malformed embedded style-map parsing in an isolated process", async () => {
    const filePath = path.join(tempDir, "escaped.docx");
    await writeDocx(filePath, paragraph("Still readable"), { styleMap: "'" + "\\a".repeat(50) });
    const script = `const fs=require('node:fs');const allowed=process.argv[1];let reads=[];const original=fs.readFile;fs.readFile=function(p,...args){reads.push(String(p));if(String(p)!==allowed)throw Error('Unexpected file read: '+p);return original.call(this,p,...args)};const originalAsync=fs.promises.readFile;fs.promises.readFile=async function(p,...args){reads.push(String(p));if(String(p)!==allowed)throw Error('Unexpected file read: '+p);return originalAsync.call(this,p,...args)};let network=0;const block=()=>{network++;throw Error('Network forbidden')};global.fetch=block;require('node:http').request=block;require('node:https').request=block;require('node:net').Socket.prototype.connect=block;const mammoth=require('mammoth');const proto=Object.getOwnPropertyDescriptors(Object.prototype);mammoth.convertToHtml({path:allowed}).then(r=>{require('node:assert/strict').deepEqual(Object.getOwnPropertyDescriptors(Object.prototype),proto);console.log(JSON.stringify({value:r.value,warnings:r.messages.length,network,reads}))}).catch(e=>{console.error(e);process.exitCode=1});`;
    const result = spawnSync(process.execPath, ["--max-old-space-size=128", "-e", script, filePath], { cwd: process.cwd(), timeout: 5000, encoding: "utf8", maxBuffer: 1024 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ value: "<p>Still readable</p>", network: 0, reads: [filePath] });
    expect(parsed.warnings).toBeGreaterThan(0);
  });
});
