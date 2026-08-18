function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function cleanText(value, max = 4000) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function normalize(value) {
  return String(value || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

function attribute(attrs, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(attrs || "").match(new RegExp(`(?:^|\\s)${escaped}=["']([^"']*)["']`, "i"));
  return match ? decodeXml(match[1]) : null;
}

function textNodes(xml) {
  const values = [];
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/gi;
  let match;
  while ((match = re.exec(String(xml || "")))) values.push(decodeXml(match[1]));
  return values.join("");
}

function firstValue(xml) {
  const match = String(xml || "").match(/<v\b[^>]*>([\s\S]*?)<\/v>/i);
  return match ? decodeXml(match[1]) : null;
}

function columnNumber(ref) {
  const match = String(ref || "").match(/^([A-Z]+)/i);
  if (!match) return null;
  let value = 0;
  for (const char of match[1].toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64;
  return value;
}

function parseSharedStrings(xml) {
  const values = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/gi;
  let match;
  while ((match = re.exec(String(xml || "")))) values.push(textNodes(match[1]));
  return values;
}

function parseWorksheetRows(xml, sharedStrings) {
  const rows = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(String(xml || "")))) {
    const rowNumber = Number.parseInt(attribute(rowMatch[1], "r"), 10) || rows.length + 1;
    const cells = new Map();
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[2]))) {
      const col = columnNumber(attribute(cellMatch[1], "r"));
      if (!col) continue;
      const type = attribute(cellMatch[1], "t");
      let value = null;
      if (type === "inlineStr") value = textNodes(cellMatch[2]);
      else {
        const raw = firstValue(cellMatch[2]);
        if (raw !== null) value = type === "s" ? sharedStrings[Number.parseInt(raw, 10)] ?? null : raw;
      }
      if (value !== null) cells.set(col, value);
    }
    rows.push({ rowNumber, cells });
  }
  return rows;
}

function resolveFirstSheetPath(files) {
  const decoder = new TextDecoder();
  const workbookBytes = files["xl/workbook.xml"];
  const relBytes = files["xl/_rels/workbook.xml.rels"];
  if (!workbookBytes || !relBytes) return "xl/worksheets/sheet1.xml";
  const workbook = decoder.decode(workbookBytes);
  const rels = decoder.decode(relBytes);
  const sheet = workbook.match(/<sheet\b[^>]*\br:id=["']([^"']+)["'][^>]*>/i);
  if (!sheet) return "xl/worksheets/sheet1.xml";
  const relRe = /<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/gi;
  let match;
  while ((match = relRe.exec(rels))) {
    if (attribute(match[1], "Id") !== sheet[1]) continue;
    const target = attribute(match[1], "Target");
    if (!target) break;
    if (target.startsWith("/")) return target.slice(1);
    if (target.startsWith("xl/")) return target;
    return `xl/${target.replace(/^\.\//, "")}`;
  }
  return "xl/worksheets/sheet1.xml";
}

function findEndOfCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.length - 65557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("Ugyldig XLSX/ZIP: fant ikke sentralkatalogen");
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzipXlsx(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes);
  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const files = {};

  for (let index = 0; index < entries; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Ugyldig ZIP-katalog i XLSX-filen");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    if (!name.endsWith("/")) {
      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`Ugyldig lokal ZIP-header for ${name}`);
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
      if (method === 0) files[name] = compressed.slice();
      else if (method === 8) files[name] = await inflateRaw(compressed);
      else throw new Error(`XLSX inneholder ZIP-komprimering som ikke støttes (${method})`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function parseXlsxRows(arrayBuffer) {
  const files = await unzipXlsx(arrayBuffer);
  const decoder = new TextDecoder();
  const shared = files["xl/sharedStrings.xml"]
    ? parseSharedStrings(decoder.decode(files["xl/sharedStrings.xml"]))
    : [];
  const sheetPath = resolveFirstSheetPath(files);
  const sheetBytes = files[sheetPath] || files["xl/worksheets/sheet1.xml"];
  if (!sheetBytes) throw new Error("Fant ikke første regneark i XLSX-filen");
  return parseWorksheetRows(decoder.decode(sheetBytes), shared);
}

function cell(row, col) {
  return row?.cells?.get(col) ?? null;
}

function findHeaderRow(rows, requiredText) {
  const needle = normalize(requiredText);
  for (const row of rows.slice(0, 25)) {
    for (const value of row.cells.values()) if (normalize(value) === needle) return row;
  }
  return null;
}

function headerMap(row) {
  const map = new Map();
  for (const [col, value] of row?.cells || []) map.set(normalize(value), col);
  return map;
}

function findColumn(headers, candidates) {
  const entries = [...headers.entries()];
  for (const candidate of candidates) {
    const wanted = normalize(candidate);
    const exact = headers.get(wanted);
    if (exact) return exact;
    const partial = entries.find(([label]) => label.includes(wanted) || wanted.includes(label));
    if (partial) return partial[1];
  }
  return null;
}

function numberValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function excelDate(value) {
  const text = cleanText(value, 100);
  if (!text) return null;
  const iso = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`;
  const serial = Number(text.replace(",", "."));
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return null;
  const date = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
  return date.toISOString().slice(0, 10);
}

function extractSourceDate(rows) {
  for (const row of rows.slice(0, 12)) {
    for (const value of row.cells.values()) {
      const match = String(value || "").match(/(?:uppdateringsdatum[^0-9]*)?(20\d{2})[-/.](\d{2})[-/.](\d{2})/i);
      if (match) return `${match[1]}-${match[2]}-${match[3]}`;
    }
  }
  return null;
}

function isTerranor(value) {
  return /\bterranor\b/i.test(String(value || ""));
}

export async function parseAwardWorkbook(arrayBuffer) {
  const rows = await parseXlsxRows(arrayBuffer);
  const header = findHeaderRow(rows, "Procurement ID");
  if (!header) throw new Error("Fant ikke kolonneoverskriftene i Trafikverkets kontraktsfil");
  const headers = headerMap(header);
  const col = {
    id: findColumn(headers, ["Procurement ID"]),
    purchaser: findColumn(headers, ["Purchasers Organization"]),
    region: findColumn(headers, ["Geografical area", "Geographical area"]),
    category: findColumn(headers, ["Purchase category"]),
    type: findColumn(headers, ["Procurement type"]),
    name: findColumn(headers, ["Procurement name"]),
    tenderer: findColumn(headers, ["Tenderer"]),
    orgno: findColumn(headers, ["Organization number"]),
    tenderSum: findColumn(headers, ["Tender Sum"]),
    contractNo: findColumn(headers, ["Contract number"]),
    start: findColumn(headers, ["Start of contract"]),
    end: findColumn(headers, ["End of contract"]),
    contractValue: findColumn(headers, ["Contract value"]),
  };
  if (!col.id || !col.name || !col.tenderer) throw new Error("Trafikverkets kontraktsfil har et ukjent kolonneoppsett");

  const groups = [];
  let current = null;
  for (const row of rows) {
    if (row.rowNumber <= header.rowNumber) continue;
    const id = cleanText(cell(row, col.id), 120);
    if (id) {
      current = {
        procurement_id: id,
        purchaser_org: cleanText(cell(row, col.purchaser), 300),
        region: cleanText(cell(row, col.region), 250),
        purchase_category: cleanText(cell(row, col.category), 250),
        procurement_type: cleanText(cell(row, col.type), 250),
        procurement_name: cleanText(cell(row, col.name), 800) || id,
        bids: [],
      };
      groups.push(current);
    }
    if (!current) continue;
    const tenderer = cleanText(cell(row, col.tenderer), 500);
    if (!tenderer) continue;
    current.bids.push({
      tenderer_name: tenderer,
      organization_number: cleanText(cell(row, col.orgno), 120),
      tender_sum_sek: numberValue(cell(row, col.tenderSum)),
      contract_number: cleanText(cell(row, col.contractNo), 160),
      contract_start: excelDate(cell(row, col.start)),
      contract_end: excelDate(cell(row, col.end)),
      contract_value_sek: numberValue(cell(row, col.contractValue)),
    });
  }

  const relevant = groups.filter((group) => group.bids.some((bid) => isTerranor(bid.tenderer_name)));
  const awards = relevant.map((group) => {
    const terranor = group.bids.find((bid) => isTerranor(bid.tenderer_name)) || null;
    const winner = group.bids.find((bid) => bid.contract_number) || null;
    return {
      ...group,
      terranor_bid_sek: terranor?.tender_sum_sek ?? null,
      terranor_won: Boolean(terranor?.contract_number),
      winner_name: winner?.tenderer_name ?? null,
      winner_orgno: winner?.organization_number ?? null,
      winner_tender_sek: winner?.tender_sum_sek ?? null,
      contract_number: winner?.contract_number ?? null,
      contract_start: winner?.contract_start ?? null,
      contract_end: winner?.contract_end ?? null,
      contract_value_sek: winner?.contract_value_sek ?? null,
    };
  });
  return { rowsSeen: rows.length, groupsSeen: groups.length, sourceUpdatedAt: extractSourceDate(rows), awards };
}

function parseCostRange(value) {
  const text = cleanText(value, 200);
  if (!text) return { low: null, high: null };
  const normalized = text.replace(/,/g, ".");
  const range = normalized.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/);
  if (range) return { low: Number(range[1]), high: Number(range[2]) };
  const below = normalized.match(/<\s*(\d+(?:\.\d+)?)/);
  if (below) return { low: 0, high: Number(below[1]) };
  const above = normalized.match(/>\s*(\d+(?:\.\d+)?)/);
  if (above) return { low: Number(above[1]), high: null };
  const single = normalized.match(/(\d+(?:\.\d+)?)/);
  return single ? { low: Number(single[1]), high: Number(single[1]) } : { low: null, high: null };
}

function looksLikeCoreRoadOm(row) {
  const combined = `${normalize(row.procurement_name)} ${normalize(row.description)} ${normalize(row.purchase_category)}`;
  if (/\bbyggledare\b|\bkonsult\b/.test(combined)) return false;
  return normalize(row.purchase_category).includes("basunderhall vag")
    || /\bbasunderhall vag\b|\bbas underhall vag\b|\bbasunderhallvag\b|\bbas vag\b/.test(combined);
}

function canonicalAreaKey(value) {
  const generic = new Set([
    "utforande", "utforandeentreprenad", "for", "av", "basunderhall", "basunderhallvag", "bas",
    "underhall", "vag", "vagar", "allmanna", "pa", "inom", "omrade", "lan", "i", "samt", "och",
  ]);
  const tokens = normalize(value).split(" ").filter(Boolean).filter((token) => !generic.has(token));
  return tokens.join(" ").slice(0, 220) || normalize(value).slice(0, 220);
}

export async function parsePlanWorkbook(arrayBuffer) {
  const rows = await parseXlsxRows(arrayBuffer);
  const header = findHeaderRow(rows, "JournalID");
  if (!header) throw new Error("Fant ikke kolonneoverskriftene i Trafikverkets innkjøpsplan");
  const headers = headerMap(header);
  const col = {
    id: findColumn(headers, ["JournalID"]), business: findColumn(headers, ["Verksamhet"]),
    name: findColumn(headers, ["Benämning upphandling"]), description: findColumn(headers, ["Beskrivning upphandling"]),
    cpv: findColumn(headers, ["CPV kod"]), area: findColumn(headers, ["Upphandlingsområde"]),
    agreement: findColumn(headers, ["Upphandlingstyp/Avtalstyp"]), traffic: findColumn(headers, ["Trafikslag"]),
    category: findColumn(headers, ["Inköpskategori"]), region: findColumn(headers, ["Geografiskt område"]),
    adStart: findColumn(headers, ["Planerad annonseringsstart"]), deadline: findColumn(headers, ["Planerad sista anbudsdag"]),
    contractStart: findColumn(headers, ["Planerad avtalsstart"]),
    status: findColumn(headers, ["Status på uppgifter, planering", "Status på uppgifter planering"]),
    cost: findColumn(headers, ["Bedömd kostnad, miljoner SEK"]), years: findColumn(headers, ["Bedömd Kontraktstid, år"]),
    contact: findColumn(headers, ["Kontaktperson"]), information: findColumn(headers, ["Information"]),
  };
  if (!col.id || !col.name) throw new Error("Trafikverkets innkjøpsplan har et ukjent kolonneoppsett");

  const plan = [];
  for (const row of rows) {
    if (row.rowNumber <= header.rowNumber) continue;
    const journalId = cleanText(cell(row, col.id), 120);
    const name = cleanText(cell(row, col.name), 900);
    if (!journalId || !name) continue;
    const item = {
      journal_id: journalId,
      business_area: cleanText(cell(row, col.business), 200),
      procurement_name: name,
      description: cleanText(cell(row, col.description), 2400),
      cpv_code: cleanText(cell(row, col.cpv), 1000),
      procurement_area: cleanText(cell(row, col.area), 240),
      agreement_type: cleanText(cell(row, col.agreement), 240),
      traffic_mode: cleanText(cell(row, col.traffic), 160),
      purchase_category: cleanText(cell(row, col.category), 240),
      region: cleanText(cell(row, col.region), 240),
      planned_ad_start: excelDate(cell(row, col.adStart)),
      planned_bid_deadline: excelDate(cell(row, col.deadline)),
      planned_contract_start: excelDate(cell(row, col.contractStart)),
      planning_status: cleanText(cell(row, col.status), 120),
      estimated_cost_text: cleanText(cell(row, col.cost), 200),
      estimated_contract_years: numberValue(cell(row, col.years)),
      contact_person: cleanText(cell(row, col.contact), 240),
      information: cleanText(cell(row, col.information), 1200),
    };
    if (!looksLikeCoreRoadOm(item)) continue;
    const cost = parseCostRange(item.estimated_cost_text);
    item.estimated_cost_low_msek = cost.low;
    item.estimated_cost_high_msek = cost.high;
    item.duplicate_key = `${canonicalAreaKey(item.procurement_name)}|${item.planned_contract_start || "ukjent"}`;
    plan.push(item);
  }
  return { rowsSeen: rows.length, sourceUpdatedAt: extractSourceDate(rows), plan };
}
