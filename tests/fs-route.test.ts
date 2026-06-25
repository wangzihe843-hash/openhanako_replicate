import fs from "fs";
import os from "os";
import path from "path";
import ExcelJS from "exceljs";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFsRoute } from "../server/routes/fs.ts";

describe("fs route", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-fs-route-"));

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
  });

  function buildApp({ hanakoHome, workspace }) {
    const app = new Hono();
    const engine = {
      hanakoHome,
      currentAgentId: "hana",
      getHomeCwd: vi.fn((agentId) => agentId === "hana" ? workspace : null),
      getAgent(id) {
        if (id !== "hana") return null;
        return {
          id: "hana",
          config: { desk: { home_folder: workspace } },
          deskManager: {},
        };
      },
    };
    app.route("/api", createFsRoute(engine));
    return app;
  }

  // Real fs.symlinkSync requires admin/Developer Mode on Windows; covered on POSIX runners.
  it.skipIf(process.platform === "win32")("rejects symlink escapes from an allowed workspace", async () => {
    const hanakoHome = path.join(tempRoot, "hanako");
    const workspace = path.join(tempRoot, "workspace");
    const outsideDir = path.join(tempRoot, "outside");
    fs.mkdirSync(path.join(hanakoHome, "user"), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const outsideFile = path.join(outsideDir, "secret.txt");
    const linkedFile = path.join(workspace, "secret-link.txt");
    fs.writeFileSync(outsideFile, "top secret", "utf-8");
    fs.symlinkSync(outsideFile, linkedFile);

    const app = buildApp({ hanakoHome, workspace });
    const res = await app.request(`/api/fs/read?path=${encodeURIComponent(linkedFile)}`);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "path not allowed" });
  });

  it("keeps missing files inside the workspace as 404 instead of 403", async () => {
    const hanakoHome = path.join(tempRoot, "hanako");
    const workspace = path.join(tempRoot, "workspace");
    fs.mkdirSync(path.join(hanakoHome, "user"), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });

    const missingFile = path.join(workspace, "missing.txt");
    const app = buildApp({ hanakoHome, workspace });
    const res = await app.request(`/api/fs/read?path=${encodeURIComponent(missingFile)}`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "file not found" });
  });

  it("renders allowed xlsx files as HTML for the web preview fallback", async () => {
    const hanakoHome = path.join(tempRoot, "hanako");
    const workspace = path.join(tempRoot, "workspace");
    fs.mkdirSync(path.join(hanakoHome, "user"), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });

    const workbookPath = path.join(workspace, "budget.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Budget");
    sheet.addRow(["Name", "Value"]);
    sheet.addRow(["A&B", "<42>"]);
    await workbook.xlsx.writeFile(workbookPath);

    const app = buildApp({ hanakoHome, workspace });
    const res = await app.request(`/api/fs/xlsx-html?path=${encodeURIComponent(workbookPath)}`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<table><tr><td>Name</td><td>Value</td></tr><tr><td>A&amp;B</td><td>&lt;42&gt;</td></tr></table>");
  });
});
