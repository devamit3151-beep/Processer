const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const reportPath = path.join(root, "files", "map-report", "designers-images-formatted.csv");
const templatePath = path.join(root, "files", "import-csv", "designers-template.csv");
const outputDir = path.join(root, "converted");
const outputCsvPath = path.join(outputDir, "designers-template-with-media-gids.csv");
const outputLogPath = path.join(outputDir, "designers-template-with-media-gids.log");
const outputJsonLogPath = path.join(outputDir, "designers-template-with-media-gids.log.json");

function splitCsvRecordsWithRaw(input) {
  const records = [];
  let start = 0;
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      let end = i;
      let newline = char;

      if (char === "\r" && next === "\n") {
        newline = "\r\n";
        i += 1;
      }

      records.push({
        raw: input.slice(start, end),
        newline,
      });
      start = i + 1;
    }
  }

  if (start < input.length) {
    records.push({
      raw: input.slice(start),
      newline: "",
    });
  }

  return records;
}

function parseCsvLineWithSpans(line) {
  const cells = [];
  let value = "";
  let cellStart = 0;
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        value += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ",") {
      cells.push({
        value,
        start: cellStart,
        end: i,
        raw: line.slice(cellStart, i),
      });
      value = "";
      cellStart = i + 1;
      continue;
    }

    value += char;
  }

  cells.push({
    value,
    start: cellStart,
    end: line.length,
    raw: line.slice(cellStart),
  });

  return cells;
}

function csvEscape(value) {
  const stringValue = String(value ?? "");
  if (/[",\r\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function indexHeaders(headerCells) {
  return headerCells.reduce((index, cell, position) => {
    index[cell.value.replace(/^\uFEFF/, "")] = position;
    return index;
  }, {});
}

function fileNameFromUrl(value) {
  if (!value) return "";
  const withoutQuery = value.split("?")[0];
  return path.basename(withoutQuery).toLowerCase();
}

function readCsvRecords(filePath) {
  return splitCsvRecordsWithRaw(fs.readFileSync(filePath, "utf8")).filter(
    (record) => record.raw.length > 0,
  );
}

function buildMediaMaps(reportRecords) {
  const header = indexHeaders(parseCsvLineWithSpans(reportRecords[0].raw));
  const required = ["File Name", "Link", "ID (Ref)", "Import Result"];
  const missing = required.filter((name) => header[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`Report CSV is missing required column(s): ${missing.join(", ")}`);
  }

  const byLink = new Map();
  const byFileName = new Map();
  const duplicates = [];
  const skipped = [];

  for (let i = 1; i < reportRecords.length; i += 1) {
    const rowNumber = i + 1;
    const cells = parseCsvLineWithSpans(reportRecords[i].raw);
    const fileName = cells[header["File Name"]]?.value || "";
    const link = cells[header.Link]?.value || "";
    const gid = cells[header["ID (Ref)"]]?.value || "";
    const importResult = cells[header["Import Result"]]?.value || "";

    if (!gid || !gid.startsWith("gid://shopify/MediaImage/")) {
      skipped.push({ rowNumber, fileName, link, importResult, reason: "missing media gid" });
      continue;
    }

    if (link) {
      if (byLink.has(link) && byLink.get(link).gid !== gid) {
        duplicates.push({ type: "Link", key: link, existing: byLink.get(link).gid, duplicate: gid, rowNumber });
      } else {
        byLink.set(link, { gid, fileName, rowNumber });
      }
    }

    const normalizedFileName = fileName.toLowerCase();
    if (normalizedFileName) {
      if (byFileName.has(normalizedFileName) && byFileName.get(normalizedFileName).gid !== gid) {
        duplicates.push({
          type: "File Name",
          key: fileName,
          existing: byFileName.get(normalizedFileName).gid,
          duplicate: gid,
          rowNumber,
        });
      } else {
        byFileName.set(normalizedFileName, { gid, fileName, rowNumber });
      }
    }
  }

  return { byLink, byFileName, duplicates, skipped };
}

function replaceTemplateHeroImages(templateRecords, mediaMaps) {
  const headerCells = parseCsvLineWithSpans(templateRecords[0].raw);
  const header = indexHeaders(headerCells);
  const required = ["Handle", "Field", "Value"];
  const missing = required.filter((name) => header[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`Template CSV is missing required column(s): ${missing.join(", ")}`);
  }

  const logs = [];
  const output = [templateRecords[0].raw + templateRecords[0].newline];
  let totalHeroRows = 0;
  let found = 0;
  let alreadyGid = 0;
  let notFound = 0;
  let empty = 0;

  for (let i = 1; i < templateRecords.length; i += 1) {
    const record = templateRecords[i];
    const cells = parseCsvLineWithSpans(record.raw);
    const rowNumber = i + 1;
    const field = cells[header.Field]?.value || "";

    if (field !== "hero_image") {
      output.push(record.raw + record.newline);
      continue;
    }

    totalHeroRows += 1;
    const handle = cells[header.Handle]?.value || "";
    const valueCell = cells[header.Value];
    const currentValue = valueCell?.value || "";

    if (!currentValue) {
      empty += 1;
      notFound += 1;
      logs.push({ status: "NOT FOUND", rowNumber, handle, currentValue, reason: "empty hero_image value" });
      output.push(record.raw + record.newline);
      continue;
    }

    if (currentValue.startsWith("gid://shopify/MediaImage/")) {
      alreadyGid += 1;
      found += 1;
      logs.push({ status: "FOUND", rowNumber, handle, currentValue, replacement: currentValue, matchType: "already gid" });
      output.push(record.raw + record.newline);
      continue;
    }

    const exactMatch = mediaMaps.byLink.get(currentValue);
    const fileNameMatch = mediaMaps.byFileName.get(fileNameFromUrl(currentValue));
    const match = exactMatch || fileNameMatch;

    if (!match) {
      notFound += 1;
      logs.push({ status: "NOT FOUND", rowNumber, handle, currentValue, reason: "no report match by URL or file name" });
      output.push(record.raw + record.newline);
      continue;
    }

    found += 1;
    const replacement = csvEscape(match.gid);
    const nextRaw =
      record.raw.slice(0, valueCell.start) +
      replacement +
      record.raw.slice(valueCell.end);

    logs.push({
      status: "FOUND",
      rowNumber,
      handle,
      currentValue,
      replacement: match.gid,
      matchType: exactMatch ? "exact URL" : "file name fallback",
      reportRowNumber: match.rowNumber,
      reportFileName: match.fileName,
    });
    output.push(nextRaw + record.newline);
  }

  return {
    csv: output.join(""),
    logs,
    summary: {
      totalTemplateRows: templateRecords.length - 1,
      totalHeroRows,
      found,
      alreadyGid,
      replaced: found - alreadyGid,
      notFound,
      empty,
    },
  };
}

function formatTextLog(summary, logs, mediaMaps) {
  const lines = [
    "Designer hero image replacement log",
    `Generated: ${new Date().toISOString()}`,
    "",
    "Summary",
    `- Template rows: ${summary.totalTemplateRows}`,
    `- Hero image rows: ${summary.totalHeroRows}`,
    `- Found: ${summary.found}`,
    `- Replaced: ${summary.replaced}`,
    `- Already GID: ${summary.alreadyGid}`,
    `- Not found: ${summary.notFound}`,
    `- Empty hero_image values: ${summary.empty}`,
    `- Report duplicate warnings: ${mediaMaps.duplicates.length}`,
    `- Report skipped rows: ${mediaMaps.skipped.length}`,
    "",
    "Hero image row details",
  ];

  for (const item of logs) {
    if (item.status === "FOUND") {
      lines.push(
        `[FOUND] row=${item.rowNumber} handle=${item.handle} match=${item.matchType} value="${item.currentValue}" -> "${item.replacement}"`,
      );
    } else {
      lines.push(
        `[NOT FOUND] row=${item.rowNumber} handle=${item.handle} reason="${item.reason}" value="${item.currentValue}"`,
      );
    }
  }

  if (mediaMaps.duplicates.length > 0) {
    lines.push("", "Report duplicate warnings");
    for (const item of mediaMaps.duplicates) {
      lines.push(
        `[DUPLICATE] type=${item.type} key="${item.key}" existing="${item.existing}" duplicate="${item.duplicate}" row=${item.rowNumber}`,
      );
    }
  }

  if (mediaMaps.skipped.length > 0) {
    lines.push("", "Report skipped rows");
    for (const item of mediaMaps.skipped) {
      lines.push(
        `[SKIPPED] row=${item.rowNumber} file="${item.fileName}" result="${item.importResult}" reason="${item.reason}" link="${item.link}"`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function main() {
  fs.mkdirSync(outputDir, { recursive: true });

  const reportRecords = readCsvRecords(reportPath);
  const templateRecords = readCsvRecords(templatePath);

  if (reportRecords.length === 0) throw new Error("Report CSV is empty.");
  if (templateRecords.length === 0) throw new Error("Template CSV is empty.");

  const mediaMaps = buildMediaMaps(reportRecords);
  const result = replaceTemplateHeroImages(templateRecords, mediaMaps);

  fs.writeFileSync(outputCsvPath, result.csv, "utf8");
  fs.writeFileSync(outputLogPath, formatTextLog(result.summary, result.logs, mediaMaps), "utf8");
  fs.writeFileSync(
    outputJsonLogPath,
    JSON.stringify(
      {
        summary: result.summary,
        heroImageRows: result.logs,
        reportDuplicateWarnings: mediaMaps.duplicates,
        reportSkippedRows: mediaMaps.skipped,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log("Designer hero image replacement complete.");
  console.log(`CSV: ${path.relative(root, outputCsvPath)}`);
  console.log(`Log: ${path.relative(root, outputLogPath)}`);
  console.log(`JSON log: ${path.relative(root, outputJsonLogPath)}`);
  console.log(
    `Hero rows=${result.summary.totalHeroRows}, found=${result.summary.found}, replaced=${result.summary.replaced}, notFound=${result.summary.notFound}`,
  );

  if (result.summary.notFound > 0 || mediaMaps.duplicates.length > 0 || mediaMaps.skipped.length > 0) {
    process.exitCode = 1;
  }
}

main();
