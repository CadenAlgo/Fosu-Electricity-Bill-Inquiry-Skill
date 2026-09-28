const channels = ["chrome", "msedge"];

export async function launchPersistentContext(playwright, profileDir, requestedChannel = "") {
  const requested = String(requestedChannel || process.env.FOSU_BROWSER_CHANNEL || "auto").toLowerCase();
  const candidates = requested === "auto" ? channels : [requested];
  const errors = [];

  for (const channel of candidates) {
    if (!channels.includes(channel)) {
      throw new Error(`不支持的浏览器通道: ${channel}。可选值为 auto、chrome、msedge。`);
    }
    try {
      return await playwright.chromium.launchPersistentContext(profileDir, {
        headless: false,
        channel,
      });
    } catch (error) {
      errors.push(`${channel}: ${error.message}`);
    }
  }

  throw new Error(
    `无法启动已安装的浏览器（尝试了 ${candidates.join("、")}）。` +
    `这不是要求安装 Playwright Chromium；请确认 Chrome/Edge 未被策略阻止，` +
    `或设置 FOSU_BROWSER_CHANNEL=chrome/msedge。原始错误: ${errors.join(" | ")}`,
  );
}

