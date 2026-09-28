import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import { launchPersistentContext } from "./launch_context.mjs";

let playwright;
try {
  const moduleDir = process.env.CODEX_NODE_MODULES || path.resolve(path.dirname(process.execPath), "..", "node_modules");
  try {
    playwright = await import("playwright");
  } catch {
    playwright = await import(pathToFileURL(path.join(moduleDir, "playwright", "index.mjs")).href);
  }
} catch (error) {
  console.error(`无法加载 Playwright: ${error.message}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const valueAfter = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};

const profileDir = path.resolve(valueAfter("--profile-dir", "browser/profiles/electricity"));
const outputFile = path.resolve(valueAfter("--output-json", ".local/electricity-result.json"));
const preset = valueAfter("--preset", "today");
const browserChannel = valueAfter("--browser-channel", "");
const explicitStart = valueAfter("--start");
const explicitEnd = valueAfter("--end");
const roomInput = valueAfter("--room");
const recordType = valueAfter("--record-type", "used").toLowerCase();
const publicTarget = "http://10.10.60.223:8010/";
const loggedInTarget = "http://10.10.60.223:8010/usedRecord.aspx";

const pad = (value) => String(value).padStart(2, "0");
const iso = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const normalizeRecordDate = (value) => {
  const text = String(value ?? "").trim();
  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) return `${isoMatch[1]}-${pad(isoMatch[2])}-${pad(isoMatch[3])}`;
  const yearFirstSlash = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s|$)/);
  if (yearFirstSlash) return `${yearFirstSlash[1]}-${pad(yearFirstSlash[2])}-${pad(yearFirstSlash[3])}`;
  const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/);
  if (slashMatch) return `${slashMatch[3]}-${pad(slashMatch[1])}-${pad(slashMatch[2])}`;
  throw new Error(`无法解析记录日期: ${value}`);
};
const parseDate = (value) => {
  const normalized = normalizeRecordDate(value);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`日期格式必须是 YYYY-MM-DD: ${value}`);
  const result = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(result.getTime()) || result.getFullYear() !== Number(match[1]) || result.getMonth() !== Number(match[2]) - 1 || result.getDate() !== Number(match[3])) {
    throw new Error(`日期无效: ${value}`);
  }
  return result;
};
const monthsAgo = (date, months) => {
  const originalDay = date.getDate();
  const result = new Date(date.getFullYear(), date.getMonth(), 1);
  result.setMonth(result.getMonth() - months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(originalDay, lastDay));
  return result;
};
const dateRange = () => {
  if (explicitStart || explicitEnd) {
    if (!explicitStart || !explicitEnd) throw new Error("--start 和 --end 必须同时提供");
    return { start: explicitStart, end: explicitEnd };
  }
  const end = new Date();
  const start = new Date(end);
  if (preset === "today") {
    // Same day.
  } else if (preset === "yesterday") {
    start.setDate(start.getDate() - 1);
    end.setDate(end.getDate() - 1);
  } else if (preset === "7d") {
    start.setDate(start.getDate() - 6);
  } else if (preset === "30d") {
    start.setDate(start.getDate() - 29);
  } else {
    const monthPresets = { "3m": 3, "6m": 6, "1y": 12, "year": 12, "2y": 24, "3y": 36, "4y": 48 };
    const months = monthPresets[preset];
    if (!months) throw new Error(`不支持的查询范围: ${preset}`);
    start = monthsAgo(end, months);
    start.setDate(start.getDate() + 1);
  }
  return { start: iso(start), end: iso(end) };
};

const chineseNumber = (number) => {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (number < 10) return digits[number];
  if (number < 20) return "十" + (number === 10 ? "" : digits[number - 10]);
  const tens = Math.floor(number / 10);
  const ones = number % 10;
  return digits[tens] + "十" + (ones ? digits[ones] : "");
};

const parseRoom = (value) => {
  const original = String(value || "").trim();
  const compact = original.replace(/[\s_-]/g, "");
  const special = compact.match(/^(国交|河滨)(\d{3})$/);
  if (special) {
    const [, building, roomDigits] = special;
    const floor = roomDigits[0];
    const maxFloor = building === "国交" ? 8 : 6;
    if (Number(floor) < 1 || Number(floor) > maxFloor) throw new Error(building + "不存在" + floor + "层，请检查房间号");
    return { input: original, building, buildingLabel: building, buildingValue: "", floor, floorLabel: building + chineseNumber(Number(floor)) + "层", room: roomDigits, roomLabel: building + "-" + roomDigits, roomMatch: building + roomDigits };
  }
  const digits = compact.replace(/^[dD]/, "");
  let buildingDigits;
  let roomDigits;
  if (/^13\d{4}$/.test(digits)) {
    buildingDigits = "13";
    roomDigits = digits.slice(2);
  } else if (/^\d{4,5}$/.test(digits)) {
    buildingDigits = digits.slice(0, -3);
    roomDigits = digits.slice(-3);
    if (buildingDigits === "13") throw new Error("D13 的宿舍号应使用四位房间号，例如 D131402");
  } else {
    throw new Error("宿舍号格式应类似 D7502、D7-502、D131402、国交502 或 河滨502");
  }
  const floor = roomDigits.length === 4 ? roomDigits.slice(0, 2) : roomDigits[0];
  const buildingNumber = Number(buildingDigits);
  const floorNumber = Number(floor);
  if (!Number.isInteger(buildingNumber) || buildingNumber < 1 || buildingNumber > 41) throw new Error("宿舍楼号必须在 D1 到 D41 范围内: D" + buildingDigits);
  if (!Number.isInteger(floorNumber) || floorNumber < 1) throw new Error("无法从房间号识别楼层: " + roomDigits);
  return { input: original, building: "D" + buildingNumber, buildingLabel: "D" + buildingNumber, buildingValue: String(buildingNumber).padStart(2, "0"), floor, floorLabel: "D" + buildingNumber + chineseNumber(floorNumber) + "层", room: roomDigits, roomLabel: "D" + buildingNumber + "-" + roomDigits, roomMatch: "D" + buildingNumber + roomDigits };
};

const range = dateRange();
if (!new Set(["used", "buy", "both"]).has(recordType)) {
  throw new Error("--record-type 只能是 used、buy 或 both");
}
const room = roomInput ? parseRoom(roomInput) : null;

const planFile = valueAfter("--plan-json");
let plan = { ranges: {} };
if (planFile) {
  try {
    plan = JSON.parse(await fs.readFile(path.resolve(planFile), "utf8"));
  } catch (error) {
    console.error(`无法读取查询计划: ${error.message}`);
    process.exit(2);
  }
}
plan.ranges = plan.ranges || {};
await fs.mkdir(profileDir, { recursive: true });
await fs.mkdir(path.dirname(outputFile), { recursive: true });

let browser;
try {
  browser = await launchPersistentContext(playwright, profileDir, browserChannel);
} catch (error) {
  console.error(`浏览器启动失败: ${error.message}`);
  process.exit(2);
}

const page = browser.pages()[0] ?? await browser.newPage();
const rl = readline.createInterface({ input, output });
const ask = async (message) => (await rl.question(`${message}\n> `)).trim();

const waitForPostback = async (action) => {
  const navigation = page.waitForNavigation({ waitUntil: "load", timeout: 15000 }).catch(() => null);
  await action();
  await navigation;
  await page.waitForTimeout(250);
};

const readRemaining = async () => {
  const text = await page.locator("body").innerText();
  const match = text.match(/剩余电量：\s*([0-9.]+)/);
  return match ? Number(match[1]) : null;
};

const readRows = async (kind) => page.locator("table tr").evaluateAll((rows, rowKind) => {
  const cellsFor = (row) => [...row.querySelectorAll("td")].map((cell) => cell.innerText.trim());
  return rows.slice(1).map(cellsFor).filter((cells) => cells[0]).map((cells) => {
    if (rowKind === "buy") {
      return {
        time: cells[0] || "",
        date: cells[0] || "",
        meter: cells[1] || "",
        quantity: cells[2] || "",
        amount: cells[3] || "",
        purchaser: cells[4] || "",
      };
    }
    return {
      date: cells[0] || "",
      meter: cells[1] || "",
      usage: cells[2] || "",
      price: cells[3] || "",
    };
  }).filter((row) => row.date && (rowKind === "buy" ? row.quantity || row.amount : row.usage));
}, kind);

const pageLinks = async () => page.locator("a").evaluateAll((links) => links.map((link) => ({
  text: link.innerText.trim(),
  href: link.href,
})).filter((link) => link.href && !link.href.startsWith("javascript:")));

const filterDate = (value, activeRange = range) => {
  try {
    const date = parseDate(value);
    return date >= parseDate(activeRange.start) && date <= parseDate(activeRange.end);
  } catch {
    return false;
  }
};

const readPaginated = async (kind, activeRange = range) => {
  const rows = [];
  const visited = new Set();
  for (let pageCount = 0; pageCount < 100; pageCount += 1) {
    const currentUrl = await page.url();
    if (visited.has(currentUrl)) break;
    visited.add(currentUrl);
    const pageRows = await readRows(kind);
    rows.push(...pageRows.map((row) => ({ ...row, date: normalizeRecordDate(row.date) })));
    const links = await pageLinks();
    const next = links.find((link) => /^下一页$/.test(link.text) && link.href !== currentUrl);
    if (!next) break;
    await page.goto(next.href, { waitUntil: "domcontentloaded", timeout: 30000 });
  }
  return rows.filter((row) => filterDate(row.date, activeRange));
};

const applyDateRange = async (activeRange = range) => {
  if ((await page.locator("#txtstart").count()) !== 1 || (await page.locator("#txtend").count()) !== 1) {
    throw new Error("未检测到电费日期查询表单");
  }
  await page.locator("#txtstart").fill(activeRange.start);
  await page.locator("#txtend").fill(activeRange.end);
  const query = page.locator("#btnser");
  if (await query.count() !== 1) throw new Error("未检测到唯一的电费查询按钮");
  await waitForPostback(() => query.click());
};

const normalizeOption = (value) => String(value || "").replace(/[\s_-]/g, "").toLowerCase();

const selectExistingOption = async (selector, matcher, errorMessage) => {
  const select = page.locator(selector);
  if (await select.count() !== 1) throw new Error("未检测到" + selector + "选择框");
  const options = await select.locator("option").evaluateAll((items) => items.map((item) => ({
    label: item.textContent?.trim() || "",
    value: item.value || "",
  })));
  const match = options.find(matcher);
  if (!match) throw new Error(errorMessage);
  await select.selectOption(match.value);
};

const queryPublic = async (kind, rangeList) => {
  const queries = rangeList?.length ? rangeList : [{ start: range.start, end: range.end }];
  const readings = [];
  const executedRanges = [];
  for (const item of queries) {
    const activeRange = { start: item.start, end: item.end };
    await page.goto(publicTarget, { waitUntil: "domcontentloaded", timeout: 45000 });
    await waitForPostback(() => selectExistingOption(
      "#drlouming",
      (option) => normalizeOption(option.label) === normalizeOption(room.buildingLabel),
      `不存在宿舍楼 ${room.buildingLabel}`,
    ));
    await waitForPostback(() => selectExistingOption(
      "#drceng",
      (option) => normalizeOption(option.label) === normalizeOption(room.floorLabel),
      `${room.buildingLabel} 不存在 ${room.floor} 层`,
    ));
    await selectExistingOption(
      "#drfangjian",
      (option) => normalizeOption(option.label) === normalizeOption(room.roomMatch)
        || normalizeOption(option.label) === normalizeOption(room.roomLabel),
      `${room.buildingLabel} ${room.floor} 层不存在房间 ${room.room}`,
    );
    const radio = page.locator(kind === "buy" ? "#buyR" : "#usedR");
    if (await radio.count() !== 1) throw new Error(`未检测到${kind === "buy" ? "购电" : "用电"}记录选项`);
    await radio.check();
    const query = page.locator("#ImageButton1");
    if (await query.count() !== 1) throw new Error("未检测到公开电费查询按钮");
    await waitForPostback(() => query.click());
    await applyDateRange(activeRange);
    readings.push(...await readPaginated(kind, activeRange));
    executedRanges.push(activeRange);
  }
  return {
    record_type: kind,
    readings,
    queries: executedRanges,
  };
};
const queryLoggedIn = async () => {
  await page.goto(loggedInTarget, { waitUntil: "domcontentloaded", timeout: 45000 });
  const signedIn = (await page.locator("#txtstart").count()) === 1 && (await page.locator("#txtend").count()) === 1;
  if (!signedIn) {
    console.error("请在打开的电费页面中完成登录，登录后回到这里按回车继续。公开宿舍号查询不需要登录；未提供宿舍号时才使用此登录流程。");
    await ask("登录完成后按回车继续");
    await page.goto(loggedInTarget, { waitUntil: "domcontentloaded", timeout: 45000 });
  }
  if ((await page.locator("#txtstart").count()) !== 1) throw new Error("未检测到已登录的电费查询表单，已停止。");
  await applyDateRange();
  return { record_type: "used", readings: await readPaginated("used") };
};

try {
  let payload;
  if (room) {
    const kinds = recordType === "both" ? ["used", "buy"] : [recordType];
    const records = {};
    for (const kind of kinds) {
      const rangeList = plan.ranges[kind];
      if (Array.isArray(rangeList) && rangeList.length === 0) continue;
      records[kind] = await queryPublic(kind, rangeList);
    }
    payload = {
      source: publicTarget,
      access: "public_room_selector",
      room,
      preset,
      range,
      remaining: await readRemaining(),
      records,
    };
  } else {
    const result = await queryLoggedIn();
    payload = {
      source: loggedInTarget,
      access: "logged_in_date_query",
      preset,
      range,
      remaining: await readRemaining(),
      records: { used: result },
    };
  }
  await fs.writeFile(outputFile, JSON.stringify(payload, null, 2), "utf8");
  const counts = Object.entries(payload.records).map(([kind, result]) => `${kind}=${result.readings.length}`).join(", ");
  console.error(`已读取电费记录（${counts}），结果写入 ${outputFile}`);
} catch (error) {
  console.error(`电费浏览器查询失败: ${error.message}`);
  process.exitCode = 2;
} finally {
  rl.close();
  await browser.close();
}
