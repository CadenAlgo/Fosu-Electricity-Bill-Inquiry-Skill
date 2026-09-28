# 佛山大学宿舍电费查询 Skill

这是一个面向 Codex 的本地 Skill，用于查询佛山大学公开宿舍电费页面的用电记录和购电记录。它只执行只读查询，不需要账号密码，也不会执行购电、缴费或账户修改。

项目当前版本重点是先稳定查出真实结果，再通过本地缓存减少重复查询，并提供不依赖外部 CDN 的 SVG 图表。

## 在 Codex 中使用

把本仓库安装到自己的 Codex skills 目录后，直接用自然语言提问：

```text
帮我查 D7502 最近 30 天的用电和购电记录
帮我查 D7502 最近一年电费并生成图表
查 D131402 从 2026-08-01 到 2026-08-31 的购电记录
```

Skill 会解析宿舍号和时间范围，打开公开查询页面，依次校验楼栋、楼层、房间，读取所有分页，并返回记录、剩余电量和统计摘要。房间号不需要账号或密码。

## 支持范围

- 宿舍楼：D1-D41。
- 普通宿舍号：例如 `D7502`、`D20502`。
- D13：使用四位房间号，例如 `D131402` 表示 D13 十四层 02 室。
- 特殊楼栋：`国交502`、`河滨502`。
- 记录类型：`used` 用电、`buy` 购电、`both` 两者。
- 时间范围：今天、昨天、7 天、30 天、3/6 个月、1-4 年、自定义起止日期。

楼栋、楼层、房间会先按本地规则检查，再以网页实际选项为准。不存在的选项会在点击查询前报错。

## 安装到 Codex

在 Windows PowerShell 中，将仓库复制到个人 Skill 目录：

```powershell
$skillsRoot = Join-Path $env:USERPROFILE ".codex\skills"
New-Item -ItemType Directory -Force -Path $skillsRoot | Out-Null
Copy-Item -Recurse -Force . (Join-Path $skillsRoot "fosu-campus-agent")
```

然后重新打开 Codex，直接使用上面的自然语言示例。也可以在 Codex 的 Skill 管理界面导入本仓库。

运行命令行备用流程前，需要 Python 3.10+、Node.js、Playwright Node 包，以及本机 Chrome 或 Edge。正常 Codex 对话优先使用当前可见的浏览器标签；命令行流程只是 fallback。

## 命令行备用入口

```powershell
python -m fosu_campus_agent electricity --preset 30d --browser --room D7502 --record-type both
python -m fosu_campus_agent electricity --preset 1y --browser --room D7502 --record-type both --chart reports/generated/d7502-1y.svg
python -m fosu_campus_agent electricity --start 2026-08-01 --end 2026-08-31 --browser --room D7502 --record-type buy
```

常用参数：

- `--preset`：快捷范围，如 `7d`、`30d`、`3m`、`6m`、`1y`、`2y`、`3y`、`4y`。
- `--start`、`--end`：自定义 `YYYY-MM-DD` 日期段，必须同时提供。
- `--room`：宿舍号；提供后使用公开选择器，不需要账号密码。
- `--record-type`：`used`、`buy` 或 `both`。
- `--chart`：输出 SVG 图表。
- `--csv`：输出用电记录 CSV。
- `--cache-file`：指定缓存路径；默认是 `.local/electricity-cache.json`。
- `--no-cache`：本次查询不读写缓存。
- `--browser-channel`：`auto`、`chrome` 或 `msedge`。

## 缓存和隐私

查询缓存保留在使用者本机的 `.local/electricity-cache.json`，不会提交到 GitHub。浏览器 profile 保存在 `browser/profiles/`，生成的 CSV/SVG 在 `reports/generated/`，这些目录也已被 Git 忽略。已有的本地缓存不会被本项目发布操作删除。

仓库不包含密码、Cookie、Token、ViewState、浏览器 profile、个人宿舍缓存或个人配置。请不要手动执行 `git add -f` 把这些目录加入提交。

## 原理和开发检查

浏览器流程使用真实页面的级联选择器和分页链接；日期同时支持网页常见的 ISO 格式和 `M/D/YYYY h:mm:ss` 格式。缓存按宿舍、记录类型和已覆盖日期区间增量合并，同一天多笔购电按完整时间保留。

图表由 `reports/chart.py` 直接生成 SVG：蓝色用电折线使用左轴，红色购电散点使用右轴，不依赖 D3、Chart.js 或外部 CDN。

```powershell
python -m unittest discover -s tests -v
python -m compileall -q fosu_campus_agent clients reports
node --check browser/electricity_flow.mjs
git diff --check
```

更详细的运行原理和参数说明见 [工作说明.md](工作说明.md)。

## 项目结构

```text
SKILL.md                         Codex 调用规则
fosu_campus_agent/               Python CLI 入口
clients/                         日期、宿舍号和缓存逻辑
browser/                         Chrome/Edge 浏览器 fallback
reports/                         CSV、统计和零依赖 SVG
skills/electricity/              电费专项说明
tests/                           电费、缓存和图表测试
```

## 许可

本项目暂未声明开源许可证，默认保留所有权利。学校页面的访问和使用请遵守学校规定及相关网络政策。