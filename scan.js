// scan.js
// Run like:
//   env-auditor /path/to/project /path/to/env.txt
//   env-auditor /path/to/project.zip /path/to/env.txt

const fs = require("fs");
const path = require("path");
const os = require("os");
const fg = require("fast-glob");
const AdmZip = require("adm-zip");

function getLineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

function parseEnvKeys(envText) {
  const keys = new Set();
  for (const raw of envText.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key) keys.add(key);
  }
  return keys;
}

function looksSensitiveName(key) {
  return /KEY|TOKEN|SECRET|PRIVATE|PASSWORD|PASS|AUTH/i.test(key);
}

function isLikelyClientExposedPath(relFile) {
  // Heuristic: files in app/ or pages/ may end up in browser bundles
  // Exclude API routes (server)
  const f = relFile.replaceAll("\\", "/");
  const isAppOrPages =
    f.startsWith("app/") ||
    f.startsWith("pages/") ||
    f.startsWith("src/app/") ||
    f.startsWith("src/pages/");

  const isApi =
    f.startsWith("app/api/") ||
    f.startsWith("src/app/api/") ||
    f.includes("/route.ts") ||
    f.includes("/route.js");

  return isAppOrPages && !isApi;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isZipFile(p) {
  return typeof p === "string" && p.toLowerCase().endsWith(".zip");
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function pickProjectRoot(extractDir) {
  const entries = fs
    .readdirSync(extractDir, { withFileTypes: true })
    .filter((e) => e.name !== "__MACOSX");

  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(extractDir, entries[0].name);
  }
  return extractDir;
}

function prepareTarget(inputPath) {
  const absInput = path.resolve(inputPath);

  if (!exists(absInput)) {
    console.log(`❌ Target not found: ${absInput}`);
    process.exit(1);
  }

  if (isZipFile(absInput)) {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "env-auditor-"));
    const zip = new AdmZip(absInput);
    zip.extractAllTo(tmpBase, true);

    const projectRoot = pickProjectRoot(tmpBase);

    return {
      absTarget: projectRoot,
      displayTarget: absInput,
      cleanup: () => {
        try {
          fs.rmSync(tmpBase, { recursive: true, force: true });
        } catch {}
      },
    };
  }

  return {
    absTarget: absInput,
    displayTarget: absInput,
    cleanup: () => {},
  };
}

async function main() {
  const targetArg = process.argv[2];
  const envFilePath = process.argv[3]; // optional

  if (!targetArg) {
    console.log("Usage:");
    console.log("  env-auditor /path/to/project /path/to/env.txt");
    console.log("  env-auditor /path/to/project.zip /path/to/env.txt");
    process.exit(1);
  }

  const { absTarget, displayTarget, cleanup } = prepareTarget(targetArg);

  try {
    const files = await fg(["**/*.{js,jsx,ts,tsx}"], {
      cwd: absTarget,
      dot: true,
      ignore: [
        "**/node_modules/**",
        "**/.next/**",
        "**/dist/**",
        "**/build/**",
        "**/.git/**",
      ],
    });

    const used = new Map(); // envKey -> [{file,line,isClient,isServerFile}]

    for (const relFile of files) {
      const absFile = path.join(absTarget, relFile);

      let text;
      try {
        text = fs.readFileSync(absFile, "utf8");
      } catch {
        continue;
      }

      const isClient =
        text.includes('"use client"') || text.includes("'use client'");

      const isServerFile =
        relFile.startsWith("app/api/") ||
        relFile.startsWith("src/app/api/") ||
        relFile.includes("/route.ts") ||
        relFile.includes("/route.js");

      // New regex objects per file (avoids state issues)
      const reDot = /process\.env\.([A-Z0-9_]+)/g;
      const reBracket = /process\.env\[['"]([A-Z0-9_]+)['"]\]/g;

      for (const match of text.matchAll(reDot)) {
        const key = match[1];
        const idx = match.index ?? 0;
        const line = getLineNumber(text, idx);
        if (!used.has(key)) used.set(key, []);
        used.get(key).push({ file: relFile, line, isClient, isServerFile });
      }

      for (const match of text.matchAll(reBracket)) {
        const key = match[1];
        const idx = match.index ?? 0;
        const line = getLineNumber(text, idx);
        if (!used.has(key)) used.set(key, []);
        used.get(key).push({ file: relFile, line, isClient, isServerFile });
      }
    }

    let providedKeys = new Set();
    if (envFilePath) {
      const envText = fs.readFileSync(path.resolve(envFilePath), "utf8");
      providedKeys = parseEnvKeys(envText);
    }

    const usedKeys = new Set([...used.keys()]);
    const missing = [];
    const unused = [];

    if (providedKeys.size > 0) {
      for (const k of usedKeys) if (!providedKeys.has(k)) missing.push(k);
      for (const k of providedKeys) if (!usedKeys.has(k)) unused.push(k);
    }

    const missingSet = new Set(missing);

    // Risk checks (dedupe: don’t warn about vars that are missing anyway)
    const risky = [];
    for (const [key, locations] of used.entries()) {
      // Heuristic Risk: secret-like env referenced in code that might be client-exposed
      if (!missingSet.has(key) && looksSensitiveName(key)) {
        const ex = locations.find((x) => isLikelyClientExposedPath(x.file));
        if (ex) {
          risky.push({
            type: "Secret-like env used in potentially client-exposed code (heuristic)",
            key,
            file: ex.file,
            line: ex.line,
            why: "Name looks like a secret (KEY/TOKEN/SECRET/PASSWORD). Because it’s referenced in app/ or pages/, it may end up in browser code depending on how the component is used.",
          });
        }
      }

      // Risk 1: NEXT_PUBLIC that looks sensitive
      if (
        !missingSet.has(key) &&
        key.startsWith("NEXT_PUBLIC_") &&
        looksSensitiveName(key)
      ) {
        const ex = locations[0];
        risky.push({
          type: "Public env name looks sensitive",
          key,
          file: ex.file,
          line: ex.line,
          why: "NEXT_PUBLIC_* can be exposed to the browser; this looks like it might be a secret.",
        });
      }

      // Risk 2: non-NEXT_PUBLIC used inside a client component
      const usedInClient = locations.some((x) => x.isClient);
      if (
        !missingSet.has(key) &&
        usedInClient &&
        !key.startsWith("NEXT_PUBLIC_")
      ) {
        const ex = locations.find((x) => x.isClient) || locations[0];
        risky.push({
          type: "Possible secret used in client component",
          key,
          file: ex.file,
          line: ex.line,
          why: "Referenced inside a file marked 'use client'. Secrets should not be used in client components.",
        });
      }

      // Risk 3: NEXT_PUBLIC used only in server routes (often misnamed)
      const usedOnlyInServer = locations.every((x) => x.isServerFile);
      if (
        !missingSet.has(key) &&
        key.startsWith("NEXT_PUBLIC_") &&
        usedOnlyInServer
      ) {
        const ex = locations[0];
        risky.push({
          type: "NEXT_PUBLIC_ used only in server code",
          key,
          file: ex.file,
          line: ex.line,
          why: "NEXT_PUBLIC_* is meant for browser-exposed vars. If it's only used in server routes, it may be misnamed or unintended.",
        });
      }
    }

    const report = {
      scannedInput: displayTarget,
      totals: {
        filesScanned: files.length,
        envVarsFound: usedKeys.size,
        missingCount: missing.length,
        unusedCount: unused.length,
        riskyCount: risky.length,
      },
      envVarsUsed: [...usedKeys].sort(),
      missing: missing.sort(),
      unused: unused.sort(),
      risky,
      locationsByEnvVar: Object.fromEntries([...used.entries()]),
    };

    fs.writeFileSync("report.json", JSON.stringify(report, null, 2), "utf8");
    console.log("✅ Wrote report.json");
    console.log("Summary:", report.totals);

    console.log("\n=== ENV AUDIT REPORT ===");

    if (missing.length) {
      console.log("\nCRITICAL (will likely break something):");
      for (const k of missing) {
        const ex = (used.get(k) || [])[0];
        const where = ex ? ` (${ex.file}:${ex.line})` : "";
        console.log(` - Missing in env list: ${k}${where}`);
      }
    }

    if (risky.length) {
      console.log("\nWARNINGS (possible security issue):");
      for (const r of risky) {
        console.log(` - ${r.type}: ${r.key} (${r.file}:${r.line})`);
      }
    }

    if (unused.length) {
      console.log("\nINFO (cleanup):");
      for (const k of unused) console.log(` - Set but not used in code: ${k}`);
    }

    if (!missing.length && !risky.length && !unused.length) {
      console.log("\nNo issues found 🎉");
    }

    // Generate .env.example
    const exampleLines = [...usedKeys].sort().map((k) => `${k}=`).join("\n");
    fs.writeFileSync(".env.example.generated", exampleLines + "\n", "utf8");
    console.log("\n✅ Wrote .env.example.generated");

    // Generate report.html
    const missingItems = missing
      .map((k) => {
        const ex = (used.get(k) || [])[0];
        const where = ex ? `${ex.file}:${ex.line}` : "";
        return `<li><b>${escapeHtml(k)}</b> <span style="color:#666">${escapeHtml(where)}</span></li>`;
      })
      .join("");

    const riskyItems = risky
      .map(
        (r) =>
          `<li><b>${escapeHtml(r.key)}</b> — ${escapeHtml(r.type)} <span style="color:#666">(${escapeHtml(
            r.file
          )}:${escapeHtml(r.line)})</span><div style="color:#666;margin-top:4px">${escapeHtml(
            r.why || ""
          )}</div></li>`
      )
      .join("");

    const unusedItems = unused
      .map((k) => `<li><b>${escapeHtml(k)}</b></li>`)
      .join("");

    const html = `<!doctype html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Env Audit Report</title></head>
<body style="font-family: system-ui, -apple-system; margin: 24px; max-width: 900px;">
<h1 style="margin:0 0 6px 0;">Env Audit Report</h1>
<div style="color:#666;margin-bottom:16px;">Input: ${escapeHtml(report.scannedInput)}</div>

<div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:18px;">
  <div style="padding:10px 12px;border:1px solid #ddd;border-radius:10px;">Files: <b>${report.totals.filesScanned}</b></div>
  <div style="padding:10px 12px;border:1px solid #ddd;border-radius:10px;">Env vars: <b>${report.totals.envVarsFound}</b></div>
  <div style="padding:10px 12px;border:1px solid #ddd;border-radius:10px;">Missing: <b>${report.totals.missingCount}</b></div>
  <div style="padding:10px 12px;border:1px solid #ddd;border-radius:10px;">Risky: <b>${report.totals.riskyCount}</b></div>
  <div style="padding:10px 12px;border:1px solid #ddd;border-radius:10px;">Unused: <b>${report.totals.unusedCount}</b></div>
</div>

<h2>Critical: Missing env vars</h2>
<ul>${missingItems || "<li>None 🎉</li>"}</ul>

<h2>Warnings: Risky usage</h2>
<ul>${riskyItems || "<li>None 🎉</li>"}</ul>

<h2>Info: Unused env vars</h2>
<ul>${unusedItems || "<li>None 🎉</li>"}</ul>

<hr style="margin:24px 0;border:none;border-top:1px solid #eee;" />
<div style="color:#666;font-size:14px;">Generated by env-auditor</div>
</body></html>`;

    fs.writeFileSync("report.html", html, "utf8");
    console.log("✅ Wrote report.html");
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
