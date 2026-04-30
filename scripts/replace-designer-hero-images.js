const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");

const root = path.resolve(__dirname, "..");
const mapReportDir = path.join(root, "files", "map-report");
const importCsvDir = path.join(root, "files", "import-csv");
const outputDir = path.join(root, "converted");
const defaultReportFile = "designers-images-formatted.csv";
const defaultTemplateFile = "designers-template.csv";
const defaultOutputFile = "designers-template-with-media-gids.csv";
const defaultRunFolder = "converted-files";
const defaultTargetField = "hero_image";

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

function replaceTemplateFieldImages(templateRecords, mediaMaps, targetField) {
  const headerCells = parseCsvLineWithSpans(templateRecords[0].raw);
  const header = indexHeaders(headerCells);
  const required = ["Handle", "Field", "Value"];
  const missing = required.filter((name) => header[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`Template CSV is missing required column(s): ${missing.join(", ")}`);
  }

  const logs = [];
  const output = [templateRecords[0].raw + templateRecords[0].newline];
  let totalTargetRows = 0;
  let found = 0;
  let alreadyGid = 0;
  let notFound = 0;
  let empty = 0;

  for (let i = 1; i < templateRecords.length; i += 1) {
    const record = templateRecords[i];
    const cells = parseCsvLineWithSpans(record.raw);
    const rowNumber = i + 1;
    const field = cells[header.Field]?.value || "";

    if (field !== targetField) {
      output.push(record.raw + record.newline);
      continue;
    }

    totalTargetRows += 1;
    const handle = cells[header.Handle]?.value || "";
    const valueCell = cells[header.Value];
    const currentValue = valueCell?.value || "";

    if (!currentValue) {
      empty += 1;
      notFound += 1;
      logs.push({ status: "NOT FOUND", rowNumber, handle, field, currentValue, reason: `empty ${targetField} value` });
      output.push(record.raw + record.newline);
      continue;
    }

    if (currentValue.startsWith("gid://shopify/MediaImage/")) {
      alreadyGid += 1;
      found += 1;
      logs.push({ status: "FOUND", rowNumber, handle, field, currentValue, replacement: currentValue, matchType: "already gid" });
      output.push(record.raw + record.newline);
      continue;
    }

    const exactMatch = mediaMaps.byLink.get(currentValue);
    const fileNameMatch = mediaMaps.byFileName.get(fileNameFromUrl(currentValue));
    const match = exactMatch || fileNameMatch;

    if (!match) {
      notFound += 1;
      logs.push({ status: "NOT FOUND", rowNumber, handle, field, currentValue, reason: "no report match by URL or file name" });
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
      field,
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
      totalTargetRows,
      targetField,
      found,
      alreadyGid,
      replaced: found - alreadyGid,
      notFound,
      empty,
    },
  };
}

function formatTextLog(summary, logs, mediaMaps, config) {
  const lines = [
    "Shopify media GID replacement log",
    `Generated: ${new Date().toISOString()}`,
    `Map report: ${path.relative(root, config.reportPath)}`,
    `Import CSV: ${path.relative(root, config.templatePath)}`,
    `Run folder: ${path.relative(root, config.outputRunDir)}`,
    `Output CSV: ${path.relative(root, config.outputCsvPath)}`,
    `Target field: ${config.targetField}`,
    "",
    "Summary",
    `- Template rows: ${summary.totalTemplateRows}`,
    `- Target field rows: ${summary.totalTargetRows}`,
    `- Found: ${summary.found}`,
    `- Replaced: ${summary.replaced}`,
    `- Already GID: ${summary.alreadyGid}`,
    `- Not found: ${summary.notFound}`,
    `- Empty target field values: ${summary.empty}`,
    `- Report duplicate warnings: ${mediaMaps.duplicates.length}`,
    `- Report skipped rows: ${mediaMaps.skipped.length}`,
    "",
    "Target field row details",
  ];

  for (const item of logs) {
    if (item.status === "FOUND") {
      lines.push(
        `[FOUND] row=${item.rowNumber} handle=${item.handle} field=${item.field} match=${item.matchType} value="${item.currentValue}" -> "${item.replacement}"`,
      );
    } else {
      lines.push(
        `[NOT FOUND] row=${item.rowNumber} handle=${item.handle} field=${item.field} reason="${item.reason}" value="${item.currentValue}"`,
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

function printUsage() {
  console.log(`
Usage:
  node scripts/replace-designer-hero-images.js
  node scripts/replace-designer-hero-images.js --report designers-images-formatted.csv --template designers-template.csv --field hero_image --folder converted-files --output designers-template-with-media-gids.csv

Options:
  --report    CSV from files/map-report, or a full/relative path
  --template  Import CSV from files/import-csv, or a full/relative path
  --field     Field column value to replace, for example hero_image
  --folder    Run folder name in converted. Defaults to converted-files
  --output    Output CSV filename inside the run folder
  --yes       Use defaults for missing options without prompting
  --strict    Exit with code 1 when not found / duplicate / skipped rows exist
  --help      Show this help
`);
}

function parseArgs(argv) {
  const options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--report") options.report = argv[++i];
    else if (arg.startsWith("--report=")) options.report = arg.slice("--report=".length);
    else if (arg === "--template") options.template = argv[++i];
    else if (arg.startsWith("--template=")) options.template = arg.slice("--template=".length);
    else if (arg === "--field") options.field = argv[++i];
    else if (arg.startsWith("--field=")) options.field = arg.slice("--field=".length);
    else if (arg === "--folder") options.folder = argv[++i];
    else if (arg.startsWith("--folder=")) options.folder = arg.slice("--folder=".length);
    else if (arg === "--output") options.output = argv[++i];
    else if (arg.startsWith("--output=")) options.output = arg.slice("--output=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function resolveInputPath(value, defaultDir) {
  if (path.isAbsolute(value)) return value;

  const directPath = path.resolve(root, value);
  if (fs.existsSync(directPath)) return directPath;

  return path.join(defaultDir, value);
}

function resolveRunFolderParentAndName(value) {
  if (path.isAbsolute(value)) return value;
  if (value.includes("/") || value.includes("\\")) return path.resolve(root, value);
  return path.join(outputDir, value);
}

function uniqueDirectory(parentDir, folderName) {
  const safeFolderName = folderName || "converted-output";
  let candidate = path.join(parentDir, safeFolderName);
  let counter = 1;

  while (fs.existsSync(candidate)) {
    candidate = path.join(parentDir, `${safeFolderName}-${counter}`);
    counter += 1;
  }

  return candidate;
}

function buildRunOutputPaths(folderValue, outputValue) {
  const requestedFolderPath = resolveRunFolderParentAndName(folderValue);
  const parsedFolder = path.parse(requestedFolderPath);
  const outputFileName = path.basename(outputValue || defaultOutputFile);
  const finalOutputFileName = path.extname(outputFileName) ? outputFileName : `${outputFileName}.csv`;
  const outputRunDir = uniqueDirectory(parsedFolder.dir, parsedFolder.base);
  const outputCsvPath = path.join(outputRunDir, finalOutputFileName);
  const outputBase = path.join(outputRunDir, path.parse(finalOutputFileName).name);

  return {
    outputRunDir,
    outputCsvPath,
    outputLogPath: `${outputBase}.log`,
    outputJsonLogPath: `${outputBase}.log.json`,
  };
}

async function askForMissingOptions(options) {
  if (options.yes) {
    return {
      report: options.report || defaultReportFile,
      template: options.template || defaultTemplateFile,
      field: options.field || defaultTargetField,
      folder: options.folder || defaultRunFolder,
      output: options.output || defaultOutputFile,
      strict: options.strict,
    };
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const report =
      options.report ||
      (await rl.question(`Map report CSV in files/map-report [${defaultReportFile}]: `)) ||
      defaultReportFile;
    const template =
      options.template ||
      (await rl.question(`Import CSV in files/import-csv [${defaultTemplateFile}]: `)) ||
      defaultTemplateFile;
    const field =
      options.field ||
      (await rl.question(`Field value to replace [${defaultTargetField}]: `)) ||
      defaultTargetField;
    const output =
      options.output ||
      (await rl.question(`Output CSV filename [${defaultOutputFile}]: `)) ||
      defaultOutputFile;
    const folder =
      options.folder ||
      (await rl.question(`Run folder in converted [${defaultRunFolder}]: `)) ||
      defaultRunFolder;

    return { report, template, field, folder, output, strict: options.strict };
  } finally {
    rl.close();
  }

  if (!config.outputRunDir.startsWith(outputDir) && !path.isAbsolute(config.outputRunDir)) {
    throw new Error("Run folder could not be resolved.");
  }
}

function validateConfig(config) {
  if (!fs.existsSync(config.reportPath)) {
    throw new Error(`Map report CSV not found: ${config.reportPath}`);
  }

  if (!fs.existsSync(config.templatePath)) {
    throw new Error(`Import CSV not found: ${config.templatePath}`);
  }

  if (!config.targetField) {
    throw new Error("Target field cannot be empty.");
  }
}

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));
  if (cliOptions.help) {
    printUsage();
    return;
  }

  const chosen = await askForMissingOptions(cliOptions);
  const outputPaths = buildRunOutputPaths(chosen.folder, chosen.output);
  const config = {
    reportPath: resolveInputPath(chosen.report, mapReportDir),
    templatePath: resolveInputPath(chosen.template, importCsvDir),
    targetField: chosen.field,
    strict: chosen.strict,
    ...outputPaths,
  };

  validateConfig(config);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(config.outputRunDir, { recursive: true });

  const reportRecords = readCsvRecords(config.reportPath);
  const templateRecords = readCsvRecords(config.templatePath);

  if (reportRecords.length === 0) throw new Error("Report CSV is empty.");
  if (templateRecords.length === 0) throw new Error("Template CSV is empty.");

  const mediaMaps = buildMediaMaps(reportRecords);
  const result = replaceTemplateFieldImages(templateRecords, mediaMaps, config.targetField);

  fs.writeFileSync(config.outputCsvPath, result.csv, "utf8");
  fs.writeFileSync(config.outputLogPath, formatTextLog(result.summary, result.logs, mediaMaps, config), "utf8");
  fs.writeFileSync(
    config.outputJsonLogPath,
    JSON.stringify(
      {
        config: {
          mapReport: path.relative(root, config.reportPath),
          importCsv: path.relative(root, config.templatePath),
          outputCsv: path.relative(root, config.outputCsvPath),
          targetField: config.targetField,
        },
        summary: result.summary,
        targetFieldRows: result.logs,
        reportDuplicateWarnings: mediaMaps.duplicates,
        reportSkippedRows: mediaMaps.skipped,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log("Shopify media GID replacement complete.");
  console.log(`Map report: ${path.relative(root, config.reportPath)}`);
  console.log(`Import CSV: ${path.relative(root, config.templatePath)}`);
  console.log(`Target field: ${config.targetField}`);
  console.log(`Run folder: ${path.relative(root, config.outputRunDir)}`);
  console.log(`CSV: ${path.relative(root, config.outputCsvPath)}`);
  console.log(`Log: ${path.relative(root, config.outputLogPath)}`);
  console.log(`JSON log: ${path.relative(root, config.outputJsonLogPath)}`);
  console.log(
    `Target rows=${result.summary.totalTargetRows}, found=${result.summary.found}, replaced=${result.summary.replaced}, notFound=${result.summary.notFound}`,
  );

  if (
    config.strict &&
    (result.summary.notFound > 0 || mediaMaps.duplicates.length > 0 || mediaMaps.skipped.length > 0)
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
