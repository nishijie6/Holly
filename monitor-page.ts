// 监控页：一整张 HTML + CSS + Vue，作为模板字符串原样留在 TypeScript 里。
//
// 为什么不做成 .html 文件：监控页没有构建步骤，进程起来就能开。放成静态文件就要解析
// 路径、在打包时把它复制进 dist、再处理找不到文件的情形——为了省掉这些，它一直内嵌在
// 代码里。这条理由没有变，变的只是它内嵌在哪个文件：tsc 编译所有 *.ts，搬到这里照样
// 没有额外的构建步骤，而 main.ts 不必再背着两千行不是 TypeScript 的东西。
//
// 整页只有一个运行时变量，就是下面这个参数；其余每个字节都是静态的。所以这里是一个
// 函数而不是常量：注入点显式地摆在签名上，不靠闭包去捞 main.ts 的模块级变量。
//
// 注意：整页是一个模板字符串。往里写注释时不能出现反引号，也不能出现 ${ 开头的序列，
// 否则会提前结束字符串或者变成一次插值。

export function renderMonitorPage(wsTargetUrl: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Holly</title>
  <!-- 拉丁字体走 Google Fonts；CJK 交给系统宋体 / 黑体（不拉 Noto SC 的大字重包）。
       离线时整条 link 静默失败，回落到 Georgia / PingFang / SF Mono，版式不塌。 -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Literata:wght@400;600;700&family=JetBrains+Mono:wght@400;700&display=swap">
  <!-- 主题在首帧前定下来，避免深色用户看到一闪的浅色画布 -->
  <script>
    (function () {
      try {
        var saved = localStorage.getItem('holly-theme');
        var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      } catch (e) {
        document.documentElement.setAttribute('data-theme', 'light');
      }
    })();
  </script>
  <style>
    /* ==========================================================
       Holly · The Painted Ledger
       视觉语言移植自 kagami 的设计系统（kagami/DESIGN.md）：
       蒙德里安骨架 —— 2px 骨黑硬线 / 0 圆角 / 饱和原色填实块。
       颜料盘按 HSL 通道三元组存放，用 hsl(var(--x) / a) 取透明度。
       颜色是结构不是配给：语义色以填实块 + 大号 mono 数字上墙，
       中性只留给底色与长正文；色块内永不渐变、不加阴影。

       Holly 的语义映射（一块色 = 一种含义）：
         正红 signal    错误 · 主动事件 · Holly 发言
         正蓝 llm       LLM 推理 · assistant 输出 · context
         正黄 scheduler 等待 · pending · 每分钟自主检查 · 选中
         正绿 story     记忆 · recall · 归档 · 已连接
         玫红 cost      token 成本 · 用量
       ========================================================== */
    /* ==========================================================
       两套皮肤共用一份骨架：颜色与「形」都收在变量里。

       日间 = Slate Glass（重设计之前的旧观感）
         冷灰蓝渐变画布 · 白色半透明毛玻璃面板 · 14px 圆角
         1px 淡线 · 胶囊按钮 · teal #0f766e 主色 · 条目用淡色底区分

       夜间 = The Painted Ledger（移植自 kagami/DESIGN.md）
         蒙德里安骨架 —— 2px 骨黑硬线 / 0 圆角 / 饱和原色填实块
         一块色 = 一种含义：
           正红 signal / 正蓝 llm / 正黄 scheduler / 正绿 story / 玫红 cost

       约定：三元组变量（H S% L%）配 hsl(var(--x) / a) 取透明度；
       名字带 -fill / -on-fill / -tint 的是成品色值，直接 var() 用。
       ========================================================== */
    :root {
      /* ---- 中性：冷灰蓝画布 + 白面板 ---- */
      --background: 210 36.4% 95.7%;
      --background-2: 212.3 39.4% 93.5%;
      --canvas: linear-gradient(135deg, hsl(var(--background)), hsl(var(--background-2)));
      --foreground: 217.2 32.6% 17.5%;
      --card: 0 0% 100%;
      --card-a: 0.92;
      --raised: 210 40% 98%;
      --raised-a: 0.9;
      --muted-foreground: 215.4 16.3% 46.9%;
      --hairline: 215 20.2% 65.1%;

      /* 边线：日间是淡灰细线，夜间是骨黑硬线 */
      --edge-c: var(--hairline);
      --edge-a: 0.28;
      --edge-soft-c: var(--hairline);
      --edge-soft-a: 0.28;

      /* ---- 语义实色（点 / 左条 / 小强调）---- */
      --signal: 0 84.2% 60.2%;
      --signal-foreground: 0 0% 100%;
      --llm: 258.3 89.5% 66.3%;
      --llm-foreground: 0 0% 100%;
      --scheduler: 45.4 93.4% 47.5%;
      --scheduler-foreground: 217.2 32.6% 17.5%;
      --story: 142.1 70.6% 45.3%;
      --story-foreground: 0 0% 100%;
      --cost: 175.4 77.5% 26.1%;
      --cost-foreground: 0 0% 100%;

      /* ---- 语义色块：日间是淡底深字，夜间才填实原色 ---- */
      --signal-fill: #ffe4e6;      --signal-on-fill: #be123c;
      --llm-fill: #f5f3ff;         --llm-on-fill: #6d28d9;
      --scheduler-fill: #fef3c7;   --scheduler-on-fill: #92400e;
      --story-fill: #dcfce7;       --story-on-fill: #166534;
      --cost-fill: rgba(248,250,252,0.9); --cost-on-fill: #1e293b;
      --neutral-fill: #e2e8f0;     --neutral-on-fill: #334155;

      /* ---- 主色 / 交互 ---- */
      --accent: #0f766e;
      --link: #0f766e;
      --focus: #0f766e;
      --bar-fill: #0f766e;
      --btn-bg: #0f766e;
      --btn-fg: #ffffff;
      --btn-bd: transparent;
      --btn-hover-bg: #0d5e57;
      --btn-hover-fg: #ffffff;
      --btn-sec-bg: #e2e8f0;
      --btn-sec-fg: #1e293b;
      --btn-sec-hover-bg: #cbd5e1;
      --btn-sec-hover-fg: #1e293b;
      --field-bg: rgba(255,255,255,0.94);

      /* ---- 条目底色：日间靠淡色块分辨，夜间靠左侧颜料条 ---- */
      --tint-in: #ecfeff;
      --tint-out: #ecfdf5;
      --tint-status: #eff6ff;
      --tint-error: #fff1f2;
      --tint-error-fg: hsl(var(--foreground));
      --tint-assistant: #f5f3ff;
      --tint-user: rgba(224,242,254,0.9);
      --tint-ci-system: rgba(240,249,255,0.9);
      --tint-empty: rgba(255,255,255,0.6);
      --entry-bg: #ffffff;
      --entry-bd-c: var(--edge-c);
      --entry-bd-a: var(--edge-a);
      --bar-in: hsl(var(--edge-c) / var(--edge-a));
      --bar-out: hsl(var(--edge-c) / var(--edge-a));
      --bar-assistant: hsl(var(--edge-c) / var(--edge-a));
      --bar-status: hsl(var(--edge-c) / var(--edge-a));
      --bar-story: hsl(var(--edge-c) / var(--edge-a));
      --th-bar-w: 4px;
      --gap-sm: 5px;
      --gi-active-bg: #ecfeff;
      --gi-active-fg: hsl(var(--foreground));
      --gi-active-bd: #67e8f9;

      /* 思考卡左条：沿用旧版那五支笔 */
      --th-default: #8b5cf6;
      --th-bootstrap: #0f766e;
      --th-qq: #0284c7;
      --th-proactive: #d97706;
      --th-autonomy: #16a34a;
      /* 判断卡专用的第六、七支：开口用玫红压住整栏，沉默退成灰。
         灰是有意的——一屏里大部分判断都是沉默，让它们安静地退到背景，
         剩下的玫红就是「这一轮她说话了」，扫一眼就能挑出来。 */
      --th-reply: #db2777;
      --th-silent: #94a3b8;

      /* Live Messages 里判断条目的颜色，和思考卡那两支分开定义，因为环境不同：
         流水在日间只靠 -50 级淡底色区分各类条目，左条退化成 1px 边框。拿同一支灰去标
         「沉默」会直接混进满屏的 status 里。所以这里用深一档的 -100 级底色，外加一条
         4px 左条，让判断从例行噪声里浮出来。沉默选琥珀：流水里没有任何 kind 用暖色，
         它不会和收发消息、错误撞色。
         夜间那支沉默是绿的，和这里不同族，是有意的，别去统一：两张皮靠完全相反的通道
         分辨条目。日间分辨靠底色，青绿蓝红紫各被一个 kind 占着，暖底是仅剩的空位；
         夜间分辨靠左条，而那张皮整个是暖的，暖色恰恰是唯一撞车的那支。同一支颜料
         在两边的处境正好颠倒，所以只能各挑各的。 */
      --oc-bar-w: 4px;
      --oc-reply-bar: #db2777;    --oc-reply-tint: #fce7f3;   --oc-reply-fg: #be185d;
      --oc-reply-badge-bg: #fff;  --oc-reply-badge-fg: #be185d;
      --oc-silent-bar: #d97706;   --oc-silent-tint: #fef3c7;  --oc-silent-fg: #92400e;
      --oc-silent-badge-bg: #fff; --oc-silent-badge-fg: #b45309;

      /* 群聊消息行 */
      --msg-user-bg: #f0f9ff;      --msg-user-bar: #38bdf8;  --msg-user-fg: #0369a1;
      --msg-asst-bg: #f5f3ff;      --msg-asst-bar: #a78bfa;  --msg-asst-fg: #7c3aed;
      --msg-sys-bg: #f8fafc;       --msg-sys-bar: #94a3b8;   --msg-sys-fg: #64748b;
      --msg-bar-w: 3px;

      /* 侧栏：深蓝灰竖栏 + 半透明白选中块 */
      --sidebar: 218.2 31.4% 13.7%;
      --sidebar-foreground: 214.5 20.2% 61.2%;
      --sidebar-brand: 0 0% 100%;
      --sidebar-hover-fg: 211 35.8% 84.1%;
      --sidebar-active: 216 16.9% 23.1%;
      --sidebar-active-foreground: 0 0% 100%;
      --sidebar-border: 218.2 31.4% 13.7%;
      --sidebar-line: rgba(255,255,255,0.07);
      --nav-pad: 14px 10px;
      --nav-gap: 3px;
      --nav-item-pad: 10px 12px;
      --nav-bar-w: 0px;
      --brand-size: 18px;
      --brand-weight: 800;
      --brand-sub-size: 11px;
      --brand-sub-track: 0;
      --brand-sub-case: none;
      --switch-w: 30px;
      --switch-h: 16px;
      --switch-knob: 12px;
      --switch-x: 16px;
      --switch-bd: 0px;
      --switch-bg: #334155;
      --switch-on-bg: #b45309;
      --switch-knob-c: #94a3b8;
      --switch-on-knob-c: #fde68a;
      --mode-on-fg: #fbbf24;
      --radius-bar: 2px;
      --usage-accent: var(--accent);
      --resizer-on: #6366f1;
      --pill-fg: var(--neutral-on-fill);
      --pill-on-bg: #ccfbf1;
      --pill-on-fg: #0f766e;

      /* 统计卡：日间一律白卡淡边，语义只走数字与眉字，不填实块 */
      --statcard-bg: rgba(255,255,255,0.72);
      --statcard-fg: hsl(var(--foreground));
      --statcard-label-fg: hsl(var(--muted-foreground));
      --statcard-sub-a: 1;
      --cache-track: rgba(226,232,240,0.55);
      --cache-track-idle: rgba(226,232,240,0.5);

      /* 元信息小标签：日间是无边淡灰药丸 */
      --tag-bg: #eef2f7;
      --tag-bd: transparent;
      --tag-fg: hsl(var(--muted-foreground));

      /* 面板头：日间不另铺底，跟卡面共用同一张白 */
      --ph2-bg: transparent;

      /* 拟回复：日间是淡紫笺，夜间才上正红 */
      --answer-bg: #f5f3ff;
      --answer-bd: #ede9fe;
      --answer-bd-w: var(--rule);
      --answer-bar: #ede9fe;
      --answer-bar-w: var(--rule);
      --answer-fg: #7c3aed;

      /* ---- 形：圆角 / 线宽 / 阴影 / 间距 ---- */
      --sidebar-w: 220px;
      --rule: 1px;
      --radius: 14px;
      --radius-sm: 9px;
      --radius-xs: 10px;
      --radius-pill: 999px;
      --panel-shadow: 0 2px 8px rgba(0,0,0,0.05);
      --panel-blur: blur(8px);
      --bite: 0px;                        /* 夜间用负边距让相邻块共享一条黑线 */
      --gap: 8px;
      --gap-lg: 16px;
      --bar-w: var(--rule);               /* 左侧颜料条：日间不用，退回普通边框 */
      --bar-w-sm: var(--rule);
      --main-pad: 24px;
      --main-max: none;

      /* ---- 字号 / 字体 ---- */
      --h1-size: 24px;
      --h1-weight: 800;
      --h2-size: 14px;
      --h2-weight: 700;
      --stat-size: 20px;
      --stat-big: 24px;
      --title-size: 14px;
      --title-weight: 800;
      --eye-bg: transparent;
      --eye-fg: #0f766e;
      --eye-pad: 0;
      --eye-track: 0.1em;
      --th-head-bg: transparent;
      --th-head-fg: hsl(var(--muted-foreground));
      --font-serif: "Segoe UI", system-ui, sans-serif;
      --font-sans: "Segoe UI", system-ui, sans-serif;
      --font-mono: Consolas, ui-monospace, "SF Mono", Menlo, monospace;
      --font-read: Georgia, "Noto Serif SC", serif;
      color-scheme: light;
    }

    /* 守夜 · 夜间画室：黑底点亮原色（非反相），亮原色一律配骨黑字 */
    [data-theme="dark"] {
      --background: 33.3 27.3% 6.5%;
      --background-2: 33.3 27.3% 6.5%;
      --canvas: hsl(var(--background));
      --foreground: 41.5 40.6% 87.5%;
      --card: 35 23.1% 10.2%;
      --card-a: 1;
      --raised: 33.3 27.3% 12.9%;
      --raised-a: 1;
      --muted-foreground: 34 11.8% 49.8%;
      --hairline: 32.7 24.4% 17.6%;

      --edge-c: var(--foreground);
      --edge-a: 1;
      --edge-soft-c: var(--hairline);
      --edge-soft-a: 1;

      --signal: 6.1 80.2% 54.5%;
      --signal-foreground: 33.3 27.3% 6.5%;
      --llm: 223.2 73.5% 62.9%;
      --llm-foreground: 33.3 27.3% 6.5%;
      --scheduler: 46.2 96.5% 55.1%;
      --scheduler-foreground: 33.3 27.3% 6.5%;
      --story: 140 45.5% 45.3%;
      --story-foreground: 33.3 27.3% 6.5%;
      --cost: 345 67.4% 65.1%;
      --cost-foreground: 33.3 27.3% 6.5%;

      --signal-fill: hsl(var(--signal));       --signal-on-fill: hsl(var(--signal-foreground));
      --llm-fill: hsl(var(--llm));             --llm-on-fill: hsl(var(--llm-foreground));
      --scheduler-fill: hsl(var(--scheduler)); --scheduler-on-fill: hsl(var(--scheduler-foreground));
      --story-fill: hsl(var(--story));         --story-on-fill: hsl(var(--story-foreground));
      --cost-fill: hsl(var(--cost));           --cost-on-fill: hsl(var(--cost-foreground));
      --neutral-fill: hsl(var(--raised));      --neutral-on-fill: hsl(var(--foreground));

      --accent: hsl(var(--llm));
      --link: hsl(var(--llm));
      --focus: hsl(var(--llm));
      --bar-fill: hsl(var(--llm));
      --btn-bg: hsl(var(--foreground));
      --btn-fg: hsl(var(--background));
      --btn-bd: hsl(var(--foreground));
      --btn-hover-bg: hsl(var(--llm));
      --btn-hover-fg: hsl(var(--llm-foreground));
      --btn-sec-bg: hsl(var(--card));
      --btn-sec-fg: hsl(var(--foreground));
      --btn-sec-hover-bg: hsl(var(--scheduler));
      --btn-sec-hover-fg: hsl(var(--scheduler-foreground));
      --field-bg: hsl(var(--card));

      --tint-in: hsl(var(--card));
      --tint-out: hsl(var(--card));
      --tint-status: hsl(var(--raised));
      --tint-error: hsl(var(--signal));
      --tint-error-fg: hsl(var(--signal-foreground));
      --tint-assistant: hsl(var(--card));
      --tint-user: hsl(var(--card));
      --tint-ci-system: hsl(var(--raised));
      --tint-empty: transparent;
      --entry-bg: hsl(var(--card));
      --entry-bd-c: var(--foreground);
      --entry-bd-a: 1;
      --bar-in: hsl(var(--foreground));
      --bar-out: hsl(var(--signal));
      --bar-assistant: hsl(var(--llm));
      --bar-status: hsl(var(--hairline));
      --bar-story: hsl(var(--story));
      --th-bar-w: 10px;
      --gap-sm: 0px;
      --gi-active-bg: hsl(var(--scheduler));
      --gi-active-fg: hsl(var(--scheduler-foreground));
      --gi-active-bd: hsl(var(--foreground));

      --th-default: hsl(var(--llm));
      --th-bootstrap: hsl(var(--story));
      --th-qq: hsl(var(--foreground));
      --th-proactive: hsl(var(--signal));
      --th-autonomy: hsl(var(--scheduler));
      /* --cost 是这套色板里唯一没被任何 kind 认领的一支，拿来当「开口」不会撞色；
         沉默退到 muted-foreground，和日间那支灰同一个用意。 */
      --th-reply: hsl(var(--cost));
      --th-silent: hsl(var(--muted-foreground));
      /* 夜间流水是一摞共用黑线的实心块，左条本来就有 10px，底色是无色相的 card/raised。
         判断条目沿用这条左条，底色叠一层自身色相的透明度，徽标按夜间惯例整块填实。
         选色判据是「在流水里没有 kind 认领」：--cost 没有，拿来标开口。
         沉默原本给了 --scheduler，那是个错——判据只查了 kind，没查 --foreground。
         夜间这张皮整个是暖的，incoming 的左条就是 hsl(var(--foreground))，41.5°，
         而 --scheduler 是 46.2°，两根 10px 的条并排差不到五度，都读作「暖色亮条」。
         偏偏最常带 silent 的 kind 就是 incoming 和 status，要分的两头反而同色。
         所以退回判据本身，在五支里挑真正没被流水认领的那支：--story。它离最近的
         assistant（223.2°）还有 83°，而 --bar-story 只出现在 Reflect 和 Memory 的卡片上，
         那两个 tab 与 Group Talk 由 v-else-if 互斥，绿条永远不会和这里同屏。 */
      --oc-bar-w: var(--bar-w);
      --oc-reply-bar: hsl(var(--cost));       --oc-reply-tint: hsl(var(--cost) / 0.16);       --oc-reply-fg: hsl(var(--cost));
      --oc-reply-badge-bg: hsl(var(--cost));  --oc-reply-badge-fg: hsl(var(--cost-foreground));
      --oc-silent-bar: hsl(var(--story));     --oc-silent-tint: hsl(var(--story) / 0.14);     --oc-silent-fg: hsl(var(--story));
      --oc-silent-badge-bg: hsl(var(--story)); --oc-silent-badge-fg: hsl(var(--story-foreground));

      --msg-user-bg: hsl(var(--card));   --msg-user-bar: hsl(var(--foreground)); --msg-user-fg: hsl(var(--foreground));
      --msg-asst-bg: transparent;        --msg-asst-bar: hsl(var(--llm));        --msg-asst-fg: hsl(var(--llm));
      --msg-sys-bg: hsl(var(--raised));  --msg-sys-bar: hsl(var(--hairline));    --msg-sys-fg: hsl(var(--muted-foreground));
      --msg-bar-w: 6px;

      --sidebar: 35 23.1% 10.2%;
      --sidebar-foreground: 37.1 16.3% 59.2%;
      --sidebar-brand: 41.5 40.6% 87.5%;
      --sidebar-hover-fg: 41.5 40.6% 87.5%;
      --sidebar-active: 46.2 96.5% 55.1%;
      --sidebar-active-foreground: 33.3 27.3% 6.5%;
      --sidebar-border: 32.7 24.4% 17.6%;
      --sidebar-line: hsl(var(--sidebar-foreground) / 0.24);
      --nav-pad: 10px 0;
      --nav-gap: 0px;
      --nav-item-pad: 10px 16px;
      --nav-bar-w: 4px;
      --brand-size: 26px;
      --brand-weight: 600;
      --brand-sub-size: 10px;
      --brand-sub-track: 0.14em;
      --brand-sub-case: uppercase;
      --switch-w: 28px;
      --switch-h: 14px;
      --switch-knob: 8px;
      --switch-x: 15px;
      --switch-bd: var(--rule);
      --switch-bg: transparent;
      --switch-on-bg: hsl(var(--sidebar-active) / 0.28);
      --switch-knob-c: currentColor;
      --switch-on-knob-c: currentColor;
      --mode-on-fg: hsl(var(--sidebar-active));
      --radius-bar: 0px;
      --usage-accent: hsl(var(--cost));
      --resizer-on: hsl(var(--scheduler));
      --pill-fg: hsl(var(--muted-foreground));
      --pill-on-bg: var(--story-fill);
      --pill-on-fg: var(--story-on-fill);

      --statcard-bg: var(--neutral-fill);
      --statcard-fg: var(--neutral-on-fill);
      --statcard-label-fg: currentColor;
      --statcard-sub-a: 0.85;
      --cache-track: hsl(var(--raised) / var(--raised-a));
      --cache-track-idle: hsl(var(--hairline) / 0.5);

      --tag-bg: hsl(var(--raised) / var(--raised-a));
      --tag-bd: hsl(var(--edge-soft-c) / var(--edge-soft-a));
      --tag-fg: hsl(var(--muted-foreground));

      --ph2-bg: hsl(var(--raised) / var(--raised-a));

      --answer-bg: hsl(var(--signal) / 0.09);
      --answer-bd: transparent;
      --answer-bd-w: 0px;
      --answer-bar: hsl(var(--signal));
      --answer-bar-w: 3px;
      --answer-fg: hsl(var(--signal));

      --sidebar-w: 208px;
      --rule: 2px;
      --radius: 0px;
      --radius-sm: 0px;
      --radius-xs: 0px;
      --radius-pill: 0px;
      --panel-shadow: none;
      --panel-blur: none;
      --bite: calc(var(--rule) * -1);
      --gap: 0px;
      --gap-lg: 0px;
      --bar-w: 10px;
      --bar-w-sm: 8px;
      --main-pad: 28px;
      --main-max: 1236px;

      --h1-size: 34px;
      --h1-weight: 600;
      --h2-size: 17px;
      --h2-weight: 600;
      --stat-size: 34px;
      --stat-big: 34px;
      --title-size: 20px;
      --title-weight: 600;
      --eye-bg: hsl(var(--foreground));
      --eye-fg: hsl(var(--background));
      --eye-pad: 3px 8px;
      --eye-track: 0.14em;
      --th-head-bg: hsl(var(--foreground));
      --th-head-fg: hsl(var(--background));
      --font-serif: "Fraunces", "Noto Serif SC", "Songti SC", "STSong", Georgia, serif;
      --font-sans: "Literata", "Noto Sans SC", "PingFang SC", system-ui, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      --font-read: var(--font-serif);
      color-scheme: dark;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      display: flex; min-height: 100vh; width: 100%;
      font-family: var(--font-sans);
      font-size: 13px;
      color: hsl(var(--foreground));
      background: var(--canvas);
      background-attachment: fixed;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    /* 标题走衬线：拉丁 Fraunces，中文宋体——像 Holly 在写日记 */
    h1, .ph-title, .ph2-title, .brand-name, .thought-title, .reflect-topic, .usage-date {
      font-family: var(--font-serif);
    }
    /* 数据是笔触：所有等宽一律 tabular-nums，ID / token / 时间戳列不抖动 */
    pre, code, .mono, input, select,
    .ph-eye, .entry-h, .ci-h, .mi-h, .msg-name, .msg-time, .badge, .thought-time,
    .reflect-time, .reflect-stat b, .cache-head b, .cache-axis, .usage-table,
    .meta-tag, .gi-meta, .brand-sub {
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
    }

    #app { flex: 1; display: flex; flex-direction: column; min-width: 0; }

    /* ---------- 侧栏：钉在画布边上的黑竖栏 ---------- */
    .sidebar {
      width: var(--sidebar-w); min-height: 100vh;
      background: hsl(var(--sidebar));
      border-right: var(--rule) solid hsl(var(--sidebar-border));
      display: flex; flex-direction: column; flex-shrink: 0;
      position: fixed; left: 0; top: 0; bottom: 0; z-index: 10;
    }
    .brand { padding: 22px 16px 18px; border-bottom: var(--rule) solid var(--sidebar-line); }
    .brand-name { font-size: var(--brand-size); font-weight: var(--brand-weight); color: hsl(var(--sidebar-brand)); letter-spacing: -0.01em; line-height: 1.1; }
    .brand-sub { font-size: var(--brand-sub-size); color: hsl(var(--sidebar-foreground)); margin-top: 4px; letter-spacing: var(--brand-sub-track); text-transform: var(--brand-sub-case); }
    .nav { flex: 1; padding: var(--nav-pad); display: flex; flex-direction: column; gap: var(--nav-gap); list-style: none; }
    .nav-item {
      display: flex; align-items: center; gap: 10px;
      padding: var(--nav-item-pad); cursor: pointer; border-radius: var(--radius-sm);
      color: hsl(var(--sidebar-foreground)); font-size: 13px; font-weight: 500;
      transition: background 80ms ease-out, color 80ms ease-out; user-select: none;
      border-left: var(--nav-bar-w) solid transparent;
    }
    .nav-item:hover { background: hsl(var(--sidebar-foreground) / 0.1); color: hsl(var(--sidebar-hover-fg)); }
    /* 日间 = 半透明白块，夜间 = 钉在黑栏上的正黄填实块（黑字） */
    .nav-item.active,
    .nav-item.active:hover {
      background: hsl(var(--sidebar-active));
      color: hsl(var(--sidebar-active-foreground));
      border-left-color: hsl(var(--sidebar-active-foreground));
      font-weight: 700;
    }
    .nav-item svg { width: 16px; height: 16px; flex-shrink: 0; }
    .mode-row, .theme-row {
      padding: 11px 16px; border-top: var(--rule) solid var(--sidebar-line);
      display: flex; align-items: center; gap: 9px;
      font-size: 11px; color: hsl(var(--sidebar-foreground));
      cursor: pointer; user-select: none;
      transition: color 80ms ease-out;
    }
    .mode-row:hover, .theme-row:hover { color: hsl(var(--sidebar-hover-fg)); }
    .mode-row.on { color: var(--mode-on-fg); }
    /* 日间是胶囊拨杆，夜间是矩形：蒙德里安不做胶囊 */
    .mode-switch {
      width: var(--switch-w); height: var(--switch-h); position: relative; flex-shrink: 0;
      background: var(--switch-bg); border-radius: var(--radius-pill);
      border: var(--switch-bd) solid currentColor; transition: background 100ms ease-out;
    }
    .mode-switch::after {
      content: ''; position: absolute; top: 1px; left: 1px;
      width: var(--switch-knob); height: var(--switch-knob);
      background: var(--switch-knob-c); border-radius: var(--radius-pill);
      transition: left 100ms ease-in-out, background 100ms ease-out;
    }
    .mode-switch.on { background: var(--switch-on-bg); }
    .mode-switch.on::after { left: var(--switch-x); background: var(--switch-on-knob-c); }
    .ws-status {
      padding: 13px 16px; border-top: var(--rule) solid var(--sidebar-line);
      display: flex; align-items: center; gap: 9px;
      font-size: 11px; color: hsl(var(--sidebar-foreground));
    }
    /* 日间是圆点，夜间是方块 */
    .dot { width: 9px; height: 9px; border-radius: var(--radius-pill); background: hsl(var(--sidebar-foreground) / 0.5); flex-shrink: 0; }
    .dot.open { background: hsl(var(--story)); }
    .dot.connecting { background: hsl(var(--scheduler)); animation: pulse 1.2s steps(2, end) infinite; }
    .dot.error { background: hsl(var(--signal)); }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

    /* ---------- 画布 ---------- */
    .main {
      margin-left: var(--sidebar-w); flex: 1; padding: var(--main-pad);
      min-height: 100vh; min-width: 0; width: calc(100% - var(--sidebar-w)); max-width: var(--main-max);
    }
    .ph { margin-bottom: 16px; }
    /* 日间是 teal 小眉字，夜间是一枚填实颜料块 */
    .ph-eye {
      display: inline-block; margin-bottom: 4px; padding: var(--eye-pad);
      font-size: 10px; font-weight: 700; letter-spacing: var(--eye-track); text-transform: uppercase;
      background: var(--eye-bg); color: var(--eye-fg);
    }
    /* 语义填实块是夜间的语言；日间眉字一律留 teal 细字 */
    [data-theme="dark"] .ph-eye.llm { background: var(--llm-fill); color: var(--llm-on-fill); }
    [data-theme="dark"] .ph-eye.story { background: var(--story-fill); color: var(--story-on-fill); }
    [data-theme="dark"] .ph-eye.signal { background: var(--signal-fill); color: var(--signal-on-fill); }
    [data-theme="dark"] .ph-eye.scheduler { background: var(--scheduler-fill); color: var(--scheduler-on-fill); }
    [data-theme="dark"] .ph-eye.cost { background: var(--cost-fill); color: var(--cost-on-fill); }
    .ph-title { font-size: var(--h1-size); font-weight: var(--h1-weight); letter-spacing: -0.02em; line-height: 1.2; }
    .ph-desc { font-size: 13px; color: hsl(var(--muted-foreground)); margin-top: 4px; max-width: 76ch; line-height: 1.6; }

    /* 日间是毛玻璃圆角卡，夜间面板边界即构图：2px 骨黑硬线，0 圆角 */
    .panel {
      background: hsl(var(--card) / var(--card-a));
      border: var(--rule) solid hsl(var(--edge-c) / var(--edge-a));
      border-radius: var(--radius);
      backdrop-filter: var(--panel-blur);
      box-shadow: var(--panel-shadow);
    }
    .ph2 {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 12px 16px; background: var(--ph2-bg);
      border-bottom: var(--rule) solid hsl(var(--edge-c) / var(--edge-a));
      border-radius: var(--radius) var(--radius) 0 0;
    }
    .ph2-title { font-size: var(--h2-size); font-weight: var(--h2-weight); }
    .pb { padding: 16px; }
    .g2l { display: grid; grid-template-columns: 216px minmax(0, 1fr); gap: var(--gap-lg); }
    /* 夜间相邻面板共享同一条黑线：负外边距咬合，不留缝 */
    .g2l > .panel + .panel { margin-left: var(--bite); }

    .badge {
      display: inline-flex; align-items: center; padding: 4px 10px;
      border: var(--rule) solid transparent; border-radius: var(--radius-pill);
      font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
      background: var(--neutral-fill); color: var(--neutral-on-fill);
    }
    .badge.open { background: var(--story-fill); color: var(--story-on-fill); }
    .badge.connecting { background: var(--scheduler-fill); color: var(--scheduler-on-fill); }
    .badge.error { background: var(--signal-fill); color: var(--signal-on-fill); }

    button {
      border: var(--rule) solid var(--btn-bd); border-radius: var(--radius-pill);
      padding: 9px 15px; font: inherit; font-family: var(--font-sans);
      font-size: 12px; font-weight: 700; letter-spacing: 0.04em; cursor: pointer;
      color: var(--btn-fg); background: var(--btn-bg);
      transition: background 80ms ease-out, color 80ms ease-out;
    }
    button:hover { background: var(--btn-hover-bg); color: var(--btn-hover-fg); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button:disabled:hover { background: var(--btn-bg); color: var(--btn-fg); }
    button.sec { color: var(--btn-sec-fg); background: var(--btn-sec-bg); }
    button.sec:hover { background: var(--btn-sec-hover-bg); color: var(--btn-sec-hover-fg); }
    button.sm { padding: 6px 11px; font-size: 11px; }
    .bc-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .bc-table th { text-align: left; padding: 8px 10px; font-size: 11px; opacity: 0.7; font-weight: 600; }
    .bc-table th:not(:first-child), .bc-table td:not(:first-child) { text-align: center; width: 92px; }
    .bc-table td { padding: 6px 10px; border-top: 1px solid hsl(var(--edge-soft-c) / var(--edge-soft-a)); }
    .bc-name span { display: block; }
    .bc-name small { opacity: 0.55; font-size: 11px; }
    .bc-cell { padding: 4px 8px; }
    .bc-cell .mode-switch { pointer-events: none; }
    .bc-hint { padding: 12px 10px 2px; font-size: 11px; opacity: 0.6; line-height: 1.7; }

    input, select {
      width: 100%; border-radius: var(--radius-sm);
      border: var(--rule) solid hsl(var(--edge-c) / var(--edge-a));
      padding: 9px 11px; font-size: 13px;
      color: hsl(var(--foreground)); background: var(--field-bg);
    }
    input:focus-visible, select:focus-visible, button:focus-visible, .nav-item:focus-visible {
      outline: 2px solid var(--focus); outline-offset: 2px;
    }
    label { display: flex; flex-direction: column; gap: 5px; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: hsl(var(--muted-foreground)); }

    /* ---------- 读取流：日间是淡色圆角条，夜间是账簿式咬合堆叠 ---------- */
    .stack { display: flex; flex-direction: column; gap: var(--gap); }
    .entry {
      border: var(--rule) solid hsl(var(--entry-bd-c) / var(--entry-bd-a));
      border-left-width: var(--bar-w); border-radius: var(--radius-xs);
      padding: 10px 13px; background: var(--entry-bg); flex-shrink: 0;
      margin-bottom: var(--bite);
    }
    .entry.incoming { border-left-color: var(--bar-in); background: var(--tint-in); }
    .entry.outgoing { border-left-color: var(--bar-out); background: var(--tint-out); }
    .entry.assistant { border-left-color: var(--bar-assistant); background: var(--tint-assistant); }
    .entry.status { border-left-color: var(--bar-status); background: var(--tint-status); }
    /* 日间是淡红底，夜间直接上墙：整块填实正红 */
    .entry.error { background: var(--tint-error); color: var(--tint-error-fg); }
    .entry.error .entry-h { color: var(--tint-error-fg); }
    /* 判断条目按结局上色，压过 kind 给的颜色，所以放在 kind 规则之后。错误条目除外：
       撞到轮次上限的循环哪怕发过话，它首先是个故障，红色不能被盖掉，徽标照样标出结局。 */
    .entry.oc-reply:not(.error) {
      border-left-width: var(--oc-bar-w); border-left-color: var(--oc-reply-bar); background: var(--oc-reply-tint);
    }
    .entry.oc-silent:not(.error) {
      border-left-width: var(--oc-bar-w); border-left-color: var(--oc-silent-bar); background: var(--oc-silent-tint);
    }
    /* 「想说被拦」是从沉默里拆出来的一支，共用沉默那支颜料，只把左条实线换成虚线。
       没给它第七种颜色，是因为确实没有了：日间流水靠底色分辨，青绿蓝红紫玫红琥珀
       七个位置已经各归其主；夜间靠左条分辨，五支语义色也全被认领完了。
       而且同色系本来就更准——它首先是「这一轮没开口」，和沉默同类；虚线补上的是
       剩下那半句「这次不是她选的」。断开的条子对应断开的话，扫一眼就知道该去查
       qq_mode 还是 read_only，而不是去读模型想了什么。 */
    .entry.oc-suppressed:not(.error) {
      border-left-width: var(--oc-bar-w); border-left-color: var(--oc-silent-bar);
      border-left-style: dashed; background: var(--oc-silent-tint);
    }
    .entry.oc-reply:not(.error) .entry-h { color: var(--oc-reply-fg); }
    .entry.oc-silent:not(.error) .entry-h { color: var(--oc-silent-fg); }
    .entry.oc-suppressed:not(.error) .entry-h { color: var(--oc-silent-fg); }
    .oc-badge {
      display: inline-block; margin-left: 8px; padding: 1px 7px; vertical-align: 1px;
      border: 1px solid currentColor; border-radius: var(--radius-pill);
      font-size: 10px; letter-spacing: 0.04em;
    }
    .oc-badge.oc-reply { background: var(--oc-reply-badge-bg); color: var(--oc-reply-badge-fg); border-color: var(--oc-reply-bar); }
    .oc-badge.oc-silent { background: var(--oc-silent-badge-bg); color: var(--oc-silent-badge-fg); border-color: var(--oc-silent-bar); }
    .oc-badge.oc-suppressed { background: var(--oc-silent-badge-bg); color: var(--oc-silent-badge-fg); border-color: var(--oc-silent-bar); border-style: dashed; }
    .entry-h {
      display: flex; justify-content: space-between; gap: 8px; margin-bottom: 5px;
      font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
      color: hsl(var(--muted-foreground));
    }
    .entry pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.55; }
    .empty {
      border: var(--rule) dashed hsl(var(--edge-soft-c) / var(--edge-soft-a)); padding: 18px;
      border-radius: var(--radius-xs);
      color: hsl(var(--muted-foreground)); background: var(--tint-empty); text-align: center;
      font-family: var(--font-mono); font-size: 12px;
    }
    .meta-tag {
      padding: 8px 11px; background: hsl(var(--raised) / var(--raised-a));
      border: var(--rule) solid hsl(var(--edge-soft-c) / var(--edge-soft-a));
      border-radius: var(--radius-sm);
      font-size: 11px; color: hsl(var(--foreground)); word-break: break-all;
    }
    .conv-box { border-top: var(--rule) solid hsl(var(--edge-soft-c) / var(--edge-soft-a)); margin-top: 10px; padding-top: 12px; }
    .conv-log { display: flex; flex-direction: column; gap: var(--gap); max-height: 260px; overflow-y: auto; margin-top: 8px; }
    .ci {
      border: var(--rule) solid hsl(var(--entry-bd-c) / var(--entry-bd-a));
      border-left-width: var(--bar-w-sm); border-radius: var(--radius-sm);
      padding: 9px 11px; background: var(--entry-bg);
      margin-bottom: var(--bite);
    }
    .ci.user { border-left-color: var(--bar-in); background: var(--tint-user); }
    .ci.assistant { border-left-color: var(--bar-assistant); background: var(--tint-assistant); }
    .ci.system { border-left-color: var(--bar-status); background: var(--tint-ci-system); }
    .ci-h {
      display: flex; justify-content: space-between; font-size: 10px; font-weight: 700;
      letter-spacing: 0.08em; text-transform: uppercase; color: hsl(var(--muted-foreground)); margin-bottom: 4px;
    }
    .ci pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 11px; line-height: 1.45; }

    /* ---------- Usage：日间是浅底统计条，夜间一律做成填实大色块 ---------- */
    .usage-total-row {
      display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
      padding: 14px 18px; margin-bottom: 14px; border-radius: var(--radius-xs);
      background: var(--cost-fill); color: var(--cost-on-fill);
      border: var(--rule) solid hsl(var(--edge-c) / var(--edge-a));
      font-size: 14px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    }
    .usage-total-row b { font-family: var(--font-mono); font-size: var(--stat-big); font-weight: 700; letter-spacing: -0.02em; }
    .usage-day {
      border: var(--rule) solid hsl(var(--edge-c) / var(--edge-a)); border-radius: var(--radius-xs);
      padding: 12px 14px; margin-bottom: var(--bite); background: hsl(var(--card) / var(--card-a));
    }
    .usage-day-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
    .usage-date { font-size: var(--title-size); font-weight: var(--title-weight); }
    .usage-day-total { font-family: var(--font-mono); font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--usage-accent); }
    .usage-table { width: 100%; border-collapse: collapse; font-size: 11px; }
    /* 日间是淡线表头，夜间是一条黑带 */
    .usage-table th {
      text-align: right; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
      color: var(--th-head-fg); background: var(--th-head-bg); padding: 6px 7px;
      border-bottom: var(--rule) solid hsl(var(--edge-c) / var(--edge-a));
    }
    .usage-table th:first-child { text-align: left; }
    .usage-table td { text-align: right; padding: 5px 7px; color: hsl(var(--foreground)); border-bottom: 1px solid hsl(var(--edge-soft-c) / var(--edge-soft-a)); }
    .usage-table td:first-child { text-align: left; color: hsl(var(--muted-foreground)); word-break: break-all; }
    .usage-table tr:last-child td { border-bottom: 0; }

    .cache-bars {
      display: flex; align-items: flex-end; gap: 2px; height: 108px; padding: 10px;
      border: var(--rule) solid hsl(var(--edge-c) / var(--edge-a)); border-radius: var(--radius-xs);
      background: hsl(var(--card) / var(--card-a)); overflow-x: auto;
    }
    .cache-bar { flex: 1 0 5px; min-width: 5px; display: flex; align-items: flex-end; height: 100%; background: var(--cache-track); border-radius: var(--radius-bar); }
    .cache-bar i { display: block; width: 100%; background: var(--bar-fill); border-radius: var(--radius-bar); }
    .cache-bar.idle { background: repeating-linear-gradient(45deg, var(--cache-track-idle) 0 3px, transparent 3px 6px); }
    .cache-axis { display: flex; justify-content: space-between; margin-top: 6px; font-size: 10px; color: hsl(var(--muted-foreground)); }
    /* 日间是三格浅底卡，夜间是填实块咬合成一条色带 */
    .cache-heads { display: flex; flex-wrap: wrap; gap: var(--gap-lg); margin-bottom: 14px; }
    .cache-head {
      flex: 1 1 150px; border: var(--rule) solid hsl(var(--edge-c) / var(--edge-a));
      border-radius: var(--radius-xs);
      padding: 12px 14px; margin-right: var(--bite);
      background: var(--statcard-bg); color: var(--statcard-fg);
    }
    [data-theme="dark"] .cache-head.llm { background: var(--llm-fill); color: var(--llm-on-fill); }
    [data-theme="dark"] .cache-head.scheduler { background: var(--scheduler-fill); color: var(--scheduler-on-fill); }
    [data-theme="dark"] .cache-head.cost { background: var(--cost-fill); color: var(--cost-on-fill); }
    .cache-head span { display: block; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--statcard-label-fg); opacity: var(--statcard-sub-a); margin-bottom: 6px; }
    .cache-head b { font-size: var(--stat-size); font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; }
    .cache-head small { display: block; margin-top: 4px; font-size: 11px; color: var(--statcard-label-fg); opacity: var(--statcard-sub-a); }

    /* ---------- Reflect：日间是四张浅底卡，夜间是四块大色块 ---------- */
    .reflect-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--gap-lg); margin-bottom: 16px; }
    .reflect-stat {
      border: var(--rule) solid hsl(var(--edge-c) / var(--edge-a)); padding: 12px 14px;
      border-radius: var(--radius-xs); margin-right: var(--bite);
      background: var(--statcard-bg); color: var(--statcard-fg);
    }
    [data-theme="dark"] .reflect-stat.scheduler { background: var(--scheduler-fill); color: var(--scheduler-on-fill); }
    [data-theme="dark"] .reflect-stat.story { background: var(--story-fill); color: var(--story-on-fill); }
    [data-theme="dark"] .reflect-stat.llm { background: var(--llm-fill); color: var(--llm-on-fill); }
    [data-theme="dark"] .reflect-stat.signal { background: var(--signal-fill); color: var(--signal-on-fill); }
    .reflect-stat-label { display: block; margin-bottom: 5px; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--statcard-label-fg); opacity: var(--statcard-sub-a); }
    .reflect-stat b { display: block; font-size: var(--stat-size); font-weight: 700; line-height: 1.2; letter-spacing: -0.02em; }
    .reflect-stat small { display: block; margin-top: 4px; font-size: 11px; color: var(--statcard-label-fg); opacity: var(--statcard-sub-a); line-height: 1.4; word-break: break-word; }
    .reflect-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--gap-lg); }
    .reflect-split > .panel + .panel { margin-left: var(--bite); }
    .reflect-list { display: flex; flex-direction: column; gap: var(--gap); }
    .reflect-card {
      border: var(--rule) solid hsl(var(--edge-c) / var(--edge-a));
      border-left-width: var(--bar-w-sm); border-left-color: var(--bar-story);
      border-radius: var(--radius-sm);
      padding: 12px 14px; background: hsl(var(--card) / var(--card-a));
      margin-bottom: var(--bite);
    }
    .reflect-card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 8px; }
    .reflect-topic { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--h2-size); font-weight: var(--title-weight); }
    .reflect-time { flex-shrink: 0; color: hsl(var(--muted-foreground)); font-size: 11px; }
    .reflect-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; font-size: 11px; }
    .reflect-meta span { padding: 3px 8px; border-radius: var(--radius-pill); background: var(--tag-bg); border: 1px solid var(--tag-bd); color: var(--tag-fg); }
    .reflect-body { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.65; }
    .reflect-links { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; }
    .reflect-links a { color: var(--link); font-family: var(--font-mono); font-size: 11px; word-break: break-all; text-decoration: none; }
    .reflect-links a:hover { text-decoration: underline; }
    .reflect-pill {
      padding: 4px 10px; font-family: var(--font-mono); font-size: 11px; font-weight: 700;
      letter-spacing: 0.06em; text-transform: uppercase; border-radius: var(--radius-pill);
      border: var(--rule) solid transparent;
      background: var(--neutral-fill); color: var(--pill-fg);
    }
    .reflect-pill.on { background: var(--pill-on-bg); color: var(--pill-on-fg); }

    /* ---------- Thoughts：左侧颜料条 = 这一轮在想什么 ---------- */
    .thought-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
    .thought-toolbar select { width: auto; min-width: 170px; }
    .thought-list { display: flex; flex-direction: column; gap: var(--gap); }
    .thought-card {
      border: var(--rule) solid hsl(var(--edge-c) / var(--edge-a));
      border-left: var(--th-bar-w) solid var(--th-default);
      border-radius: var(--radius-sm);
      padding: 14px 16px; background: hsl(var(--card) / var(--card-a));
      margin-bottom: var(--bite);
    }
    .thought-card.bootstrap { border-left-color: var(--th-bootstrap); }
    .thought-card.qq_mode { border-left-color: var(--th-qq); }
    .thought-card.proactive { border-left-color: var(--th-proactive); }
    .thought-card.autonomy { border-left-color: var(--th-autonomy); }
    /* 判断卡（reactive）的左条改由「开没开口」决定，而不是 kind。
       别的 kind 各自只有一种结局，颜色回答「这是哪一类思考」就够了；判断卡不是——
       同样是判断，说了和没说是两件事，而那正是翻这一栏时要找的东西。
       reactive 原本没有自己的笔（落在 --th-default 上），所以这里改的是一支没人用的颜色。 */
    .thought-card.reactive.oc-reply { border-left-color: var(--th-reply); }
    .thought-card.reactive.oc-silent { border-left-color: var(--th-silent); }
    /* 跟流水同一套记号：被拦下的沉默共用沉默那支笔，断成虚线。 */
    .thought-card.reactive.oc-suppressed { border-left-color: var(--th-silent); border-left-style: dashed; }
    /* 胶囊跟着上色，兼顾只看得见颜色差异不够的情况：文字本身也说了结论。
       不限定 reactive——主动开口判断也有同一组结局，标签语言应当一致。 */
    .thought-meta span.oc-reply { border-color: var(--th-reply); color: var(--th-reply); }
    .thought-meta span.oc-silent { border-color: var(--th-silent); color: var(--th-silent); }
    .thought-meta span.oc-suppressed { border-color: var(--th-silent); color: var(--th-silent); border-style: dashed; }
    .thought-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 9px; }
    .thought-title { font-size: var(--title-size); font-weight: var(--title-weight); line-height: 1.3; }
    .thought-time { flex-shrink: 0; font-size: 11px; color: hsl(var(--muted-foreground)); }
    .thought-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
    .thought-meta span {
      padding: 3px 8px; border-radius: var(--radius-pill);
      background: var(--tag-bg); border: 1px solid var(--tag-bd);
      color: var(--tag-fg); font-family: var(--font-mono); font-size: 11px;
    }
    .thought-summary { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.7; }
    /* 拟回复 = Holly 要说的话：日间是淡紫笺，夜间才上正红 */
    .thought-answer {
      margin-top: 12px; padding: 10px 12px; border-radius: var(--radius-sm);
      background: var(--answer-bg);
      border: var(--answer-bd-w) solid var(--answer-bd);
      border-left: var(--answer-bar-w) solid var(--answer-bar);
    }
    .thought-answer-label { display: block; margin-bottom: 5px; color: var(--answer-fg); font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
    .thought-answer-body { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.6; }
    .archive-body { font-family: var(--font-read); font-size: 15px; line-height: 1.9; max-height: 340px; overflow-y: auto; }

    /* ---------- Memory ---------- */
    .fgrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) auto; gap: 10px; align-items: end; }
    .mem-meta { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; color: hsl(var(--muted-foreground)); font-size: 11px; margin-top: 12px; }
    .mem-list { display: flex; flex-direction: column; gap: var(--gap); }
    .mi {
      border: var(--rule) solid hsl(var(--edge-c) / var(--edge-a));
      border-left-width: var(--bar-w-sm); border-left-color: var(--bar-story);
      border-radius: var(--radius-sm);
      padding: 13px 15px; background: hsl(var(--card) / var(--card-a));
      margin-bottom: var(--bite);
    }
    .mi-h { display: flex; flex-wrap: wrap; gap: 6px; justify-content: space-between; margin-bottom: 7px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: hsl(var(--muted-foreground)); }
    .mi-m { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 7px; color: hsl(var(--muted-foreground)); font-size: 11px; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono); font-size: 12px; line-height: 1.55; }
    .hint { font-size: 12px; color: hsl(var(--muted-foreground)); line-height: 1.65; }

    /* ---------- Group Talk ---------- */
    .glist { display: flex; flex-direction: column; gap: var(--gap-sm); }
    .gi {
      padding: 11px 13px; border: var(--rule) solid hsl(var(--edge-c) / var(--edge-a));
      border-radius: var(--radius-sm);
      background: hsl(var(--card) / var(--card-a)); cursor: pointer;
      margin-bottom: var(--bite);
      transition: background 80ms ease-out;
    }
    .gi:hover { background: hsl(var(--raised) / var(--raised-a)); }
    /* 日间是淡青选中块，夜间是正黄块——与侧栏同一套语言 */
    .gi.active, .gi.active:hover { background: var(--gi-active-bg); color: var(--gi-active-fg); border-color: var(--gi-active-bd); }
    .gi-name { font-size: 13px; font-weight: 700; }
    .gi-meta { font-size: 11px; color: hsl(var(--muted-foreground)); margin-top: 3px; }
    .gi.active .gi-meta { color: var(--gi-active-fg); opacity: 0.75; }
    .group-view { display: flex; flex-direction: column; height: calc(100vh - 56px); gap: 0; width: 100%; }
    .gp-live { flex: none; min-height: 80px; }
    .gp-resizer { flex: none; height: 10px; cursor: row-resize; background: transparent; position: relative; z-index: 10; }
    .gp-resizer::before {
      content: ''; position: absolute; left: 0; right: 0; top: 4px; height: var(--rule);
      background: hsl(var(--edge-soft-c) / var(--edge-soft-a)); pointer-events: none; transition: background 80ms ease-out;
    }
    .gp-resizer:hover::before, .gp-resizer.dragging::before { background: var(--resizer-on); }
    .gp-bottom { flex: 1; min-height: 0; width: 100%; grid-template-rows: 1fr; margin-top: 6px; }
    .gp-panel { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
    .gp-scroll { flex: 1; overflow-y: auto; padding: 12px; min-height: 0; }
    .chat-scroll { flex: 1; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; }
    /* 整行消息：左侧颜料条分辨说话的人 */
    .msg-entry {
      width: 100%; padding: 10px 16px;
      border-left: var(--msg-bar-w) solid transparent;
      border-bottom: 1px solid hsl(var(--edge-soft-c) / var(--edge-soft-a));
      transition: background 100ms ease-out;
    }
    .msg-entry:hover { filter: brightness(0.985); }
    .msg-entry.user { background: var(--msg-user-bg); border-left-color: var(--msg-user-bar); }
    .msg-entry.assistant { background: var(--msg-asst-bg); border-left-color: var(--msg-asst-bar); }
    .msg-entry.system { background: var(--msg-sys-bg); border-left-color: var(--msg-sys-bar); }
    .msg-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 4px; }
    .msg-name { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
    .msg-entry.user .msg-name { color: var(--msg-user-fg); }
    .msg-entry.assistant .msg-name { color: var(--msg-asst-fg); }
    .msg-entry.system .msg-name { color: var(--msg-sys-fg); }
    .msg-time { font-size: 11px; color: hsl(var(--muted-foreground)); flex-shrink: 0; }
    .msg-body { font-size: 15px; line-height: 1.65; word-break: break-word; white-space: pre-wrap; color: hsl(var(--foreground)); }

    /* 滚动条也归到颜料盘里 */
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-track { background: hsl(var(--raised) / var(--raised-a)); }
    ::-webkit-scrollbar-thumb {
      background: hsl(var(--foreground) / 0.35); border-radius: var(--radius-pill);
      border: 2px solid hsl(var(--raised) / var(--raised-a));
    }
    ::-webkit-scrollbar-thumb:hover { background: hsl(var(--foreground) / 0.6); }

    @media (max-width: 900px) {
      .g2l, .reflect-split { grid-template-columns: 1fr; }
      .g2l > .panel + .panel, .reflect-split > .panel + .panel { margin-left: 0; margin-top: var(--bite); }
      .reflect-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .fgrid { grid-template-columns: 1fr 1fr; }
      .ph-title { font-size: calc(var(--h1-size) * 0.8); }
    }
    @media (max-width: 640px) {
      :root { --sidebar-w: 56px; }
      .brand-name { font-size: 18px; }
      .brand-sub, .nav-label, .mode-label, .theme-label, .ws-status span:last-child { display: none; }
      .nav-item { justify-content: center; padding: 12px 0; border-left-width: 0; }
      .reflect-grid { grid-template-columns: 1fr; }
      .reflect-stat { margin-right: 0; margin-bottom: var(--bite); }
      .fgrid { grid-template-columns: 1fr; }
      .main { padding: 16px; }
    }
    /* 尊重系统「减少动态效果」：动效是 minimal-functional，可安全关停 */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important; animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important; scroll-behavior: auto !important;
      }
    }
  </style>
</head>
<body>
<div id="app">
  <nav class="sidebar">
    <div class="brand">
      <div class="brand-name">Holly</div>
      <div class="brand-sub">WS Monitor</div>
    </div>
    <ul class="nav">
      <li class="nav-item" :class="{active: tab === 'agent'}" @click="tab = 'agent'">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="7" height="7" rx="1" stroke-linecap="round" stroke-linejoin="round"/>
          <rect x="14" y="3" width="7" height="7" rx="1" stroke-linecap="round" stroke-linejoin="round"/>
          <rect x="3" y="14" width="7" height="7" rx="1" stroke-linecap="round" stroke-linejoin="round"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M14 17.5h7M17.5 14v7"/>
        </svg>
        <span class="nav-label">Agent</span>
      </li>
      <li class="nav-item" :class="{active: tab === 'thoughts'}" @click="tab = 'thoughts'">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9.5 4.5A3.5 3.5 0 006 8v1a3 3 0 00-2 2.8A3.2 3.2 0 006.8 15v1A3.5 3.5 0 0010 19.5"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M14.5 4.5A3.5 3.5 0 0118 8v1a3 3 0 012 2.8A3.2 3.2 0 0117.2 15v1a3.5 3.5 0 01-3.2 3.5M12 4v16M9 9h3M12 14h3"/>
        </svg>
        <span class="nav-label">Thoughts</span>
      </li>
      <li class="nav-item" :class="{active: tab === 'memory'}" @click="tab = 'memory'">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <ellipse cx="12" cy="5" rx="9" ry="3"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 5v14c0 1.657 4.03 3 9 3s9-1.343 9-3V5"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 12c0 1.657 4.03 3 9 3s9-1.343 9-3"/>
        </svg>
        <span class="nav-label">Memory</span>
      </li>
      <li class="nav-item" :class="{active: tab === 'group'}" @click="tab = 'group'">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v3l-3-3H9a2 2 0 01-2-2v-1"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 8a2 2 0 012-2h10a2 2 0 012 2v5a2 2 0 01-2 2H8l-3 3V8z"/>
        </svg>
        <span class="nav-label">Group Talk</span>
      </li>
      <li class="nav-item" :class="{active: tab === 'reflect'}" @click="tab = 'reflect'">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v6h6"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M20 20v-6h-6"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M5.5 9A7 7 0 0117 5.6L20 8.5"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M18.5 15A7 7 0 017 18.4L4 15.5"/>
        </svg>
        <span class="nav-label">Reflect</span>
      </li>
      <li class="nav-item" :class="{active: tab === 'broadcast'}" @click="tab = 'broadcast'; loadWorldBroadcast()">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M8.1 8.1a5.5 5.5 0 000 7.8"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M15.9 15.9a5.5 5.5 0 000-7.8"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M5.3 5.3a9.5 9.5 0 000 13.4"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M18.7 18.7a9.5 9.5 0 000-13.4"/>
        </svg>
        <span class="nav-label">Broadcast</span>
      </li>
      <li class="nav-item" :class="{active: tab === 'archive'}" @click="tab = 'archive'">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 19.5A2.5 2.5 0 016.5 17H20"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>
        </svg>
        <span class="nav-label">Archive</span>
      </li>
      <li class="nav-item" :class="{active: tab === 'usage'}" @click="tab = 'usage'">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 3v18h18"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M7 14l3-3 3 3 4-5"/>
        </svg>
        <span class="nav-label">Usage</span>
      </li>
    </ul>
    <div class="mode-row" :class="{on: readOnly}" @click="toggleReadOnly"
      :title="readOnly ? '只读模式：不回复群消息，仍会观察世界、反思记忆和写作' : '正常模式：正常回复群消息'">
      <span class="mode-switch" :class="{on: readOnly}"></span>
      <span class="mode-label">{{ readOnly ? '只读模式' : '正常模式' }}{{ modeSwitching ? ' …' : '' }}</span>
    </div>
    <div class="theme-row" @click="toggleTheme"
      :title="theme === 'dark' ? '守夜：黑底上点亮原色' : '日间：石膏暖白底上的原色块'">
      <span class="mode-switch" :class="{on: theme === 'dark'}"></span>
      <span class="theme-label">{{ theme === 'dark' ? '守夜 · 深色' : '日间 · 浅色' }}</span>
    </div>
    <div class="ws-status">
      <span class="dot" :class="wsStatus.state"></span>
      <span>{{ wsStatusLabel }}</span>
    </div>
  </nav>

  <main class="main">
    <!-- Agent -->
    <div v-if="tab === 'agent'">
      <div class="ph">
        <div class="ph-eye llm">WebSocket &#8594; LLM</div>
        <div class="ph-title">Agent Monitor</div>
        <div class="ph-desc">Model profile configuration and latest request payload.</div>
      </div>
      <div class="panel">
          <div class="ph2"><span class="ph2-title">Model Settings</span></div>
          <div class="pb">
            <div class="stack">
              <p class="hint">Switch the active LLM profile. Changes apply immediately and are written to config.yaml.</p>
              <div v-if="claudeUsage" style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:hsl(var(--muted-foreground));">
                <span>Subscription Usage</span>
                <div style="display:flex;align-items:center;gap:6px;">
                  <span style="width:18px;">5h</span>
                  <div style="width:110px;height:8px;background:hsl(var(--raised));border:1px solid hsl(var(--hairline));overflow:hidden;">
                    <div :style="{ width: usageWidth(claudeUsage.fiveHourUtilization), height: '100%', background: usageColor(claudeUsage.fiveHourUtilization) }"></div>
                  </div>
                  <span style="font-variant-numeric:tabular-nums;">{{ usagePct(claudeUsage.fiveHourUtilization) }}</span>
                  <span style="opacity:.8;">&middot; resets {{ fmtReset(claudeUsage.fiveHourResetAt) }} &middot; {{ claudeUsage.fiveHourStatus || '-' }}</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                  <span style="width:18px;">7d</span>
                  <div style="width:110px;height:8px;background:hsl(var(--raised));border:1px solid hsl(var(--hairline));overflow:hidden;">
                    <div :style="{ width: usageWidth(claudeUsage.sevenDayUtilization), height: '100%', background: usageColor(claudeUsage.sevenDayUtilization) }"></div>
                  </div>
                  <span style="font-variant-numeric:tabular-nums;">{{ usagePct(claudeUsage.sevenDayUtilization) }}</span>
                  <span style="opacity:.8;">&middot; resets {{ fmtReset(claudeUsage.sevenDayResetAt) }} &middot; {{ claudeUsage.sevenDayStatus || '-' }}</span>
                </div>
                <span style="opacity:.7;">Updated {{ fmtTime(new Date(claudeUsage.capturedAt).toISOString()) }}</span>
              </div>
              <div v-if="tokenStats && tokenStats.models && tokenStats.models.length" style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:hsl(var(--muted-foreground));margin-top:4px;">
                <span>Token Usage &middot; {{ tokenStats.date }}</span>
                <div v-for="m in tokenStats.models" :key="m.model" style="display:flex;justify-content:space-between;gap:8px;">
                  <span style="opacity:.85;">{{ m.model }}</span>
                  <span style="font-variant-numeric:tabular-nums;">{{ fmtNum(m.totalTokens) }}</span>
                </div>
                <div style="display:flex;justify-content:space-between;gap:8px;border-top:1px solid hsl(var(--hairline));padding-top:2px;font-weight:600;">
                  <span>Total</span>
                  <span style="font-variant-numeric:tabular-nums;">{{ fmtNum(tokenStats.totalTokens) }}</span>
                </div>
              </div>
              <select v-model="selProfile">
                <option v-for="p in profiles" :key="p.name" :value="p.name">{{ p.displayName }}</option>
              </select>
              <button @click="switchProfile" :disabled="switching">{{ switching ? 'Switching...' : 'Switch Model' }}</button>
              <div class="meta-tag">{{ profileMeta }}</div>
              <div class="conv-box">
                <p class="hint">Latest <code>messages</code> payload sent to the model.</p>
                <div class="meta-tag" style="margin-top:8px;word-break:break-word;">{{ convMetaText }}</div>
                <div class="conv-log">
                  <div v-if="!convPreview || !convPreview.messages || !convPreview.messages.length" class="empty" style="font-size:11px;">No conversation yet.</div>
                  <template v-else>
                    <article v-for="(m, i) in convPreview.messages" :key="i" class="ci" :class="m.role">
                      <div class="ci-h">
                        <span>{{ m.role === 'assistant' ? 'Holly' : m.role === 'system' ? 'System' : 'User' }}</span>
                        <span>#{{ i + 1 }}</span>
                      </div>
                      <pre>{{ m.content }}</pre>
                    </article>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </div>
    </div>

    <!-- Thoughts -->
    <div v-else-if="tab === 'thoughts'">
      <div class="ph">
        <div class="ph-eye scheduler">Holly · Live</div>
        <div class="ph-title">思考时间线</div>
        <div class="ph-desc">实时展示模型判断摘要和每分钟自主检查结果；不包含模型供应商隐藏的推理链。</div>
      </div>
      <div class="panel">
        <div class="ph2">
          <span class="ph2-title">Thoughts <span style="color:hsl(var(--muted-foreground));font-weight:600;">&middot; {{ filteredThoughts.length }}/{{ thoughts.length }}</span></span>
          <button class="sec sm" @click="loadThoughts">Refresh</button>
        </div>
        <div class="pb">
          <div class="thought-toolbar" style="margin-bottom:14px;">
            <p class="hint">包含每分钟自主检查、启动定向、QQ 模式决策、群消息回复判断和主动开口判断，最新一轮排在最前。</p>
            <select v-model="thoughtKindFilter" aria-label="筛选思考类型">
              <option value="all">全部类型</option>
              <option value="autonomy">每分钟自主检查</option>
              <option value="reactive">群消息判断</option>
              <option value="proactive">主动开口判断</option>
              <option value="bootstrap">启动定向</option>
              <option value="qq_mode">QQ 模式判断</option>
            </select>
          </div>
          <div v-if="!filteredThoughts.length" class="empty">还没有可展示的思考记录。</div>
          <div v-else class="thought-list">
            <article v-for="thought in filteredThoughts" :key="thought.id" class="thought-card" :class="[thought.kind, outcomeClass(thought.outcome)]">
              <div class="thought-head">
                <span class="thought-title">{{ thought.title }}</span>
                <span class="thought-time">{{ fmtDateTime(thought.timestamp) }}</span>
              </div>
              <div class="thought-meta">
                <span>{{ thoughtKindLabel(thought.kind) }}</span>
                <span v-if="thought.groupId">群 {{ thought.groupId }}</span>
                <span v-if="thought.outcome" :class="outcomeClass(thought.outcome)">{{ thoughtOutcomeLabel(thought.outcome) }}</span>
                <span v-if="thought.model">{{ thought.model }}</span>
                <span v-if="typeof thought.durationMs === 'number' && thought.durationMs > 0">{{ fmtDuration(thought.durationMs) }}</span>
              </div>
              <div class="thought-summary">{{ thought.summary }}</div>
              <div v-if="thought.finalAnswer" class="thought-answer">
                <span class="thought-answer-label">拟回复</span>
                <div class="thought-answer-body">{{ thought.finalAnswer }}</div>
              </div>
            </article>
          </div>
        </div>
      </div>
    </div>

    <!-- Memory -->
    <div v-else-if="tab === 'memory'">
      <div class="ph">
        <div class="ph-eye story">Memory</div>
        <div class="ph-title">Memory</div>
        <div class="ph-desc">短期记忆（会话历史·内存，重启会丢） 与 长期记忆（Qdrant·持久化保留）。</div>
      </div>

      <div class="panel" style="margin-bottom:14px;">
        <div class="ph2">
          <span class="ph2-title">短期记忆 &middot; 会话历史</span>
          <button class="sec sm" @click="loadGroups">Refresh</button>
        </div>
        <div class="pb">
          <p class="hint">模型每次回复时直接看到的近期对话上下文，按群存在内存里，重启后丢失。</p>
          <label style="display:block;margin-top:8px;">Group
            <select v-model="selGroupId" @change="onPickShortTermGroup" style="margin-top:4px;">
              <option :value="null">Select a group</option>
              <option v-for="g in groups" :key="g.groupId" :value="g.groupId">{{ g.groupId }} ({{ g.turnCount }} turns)</option>
            </select>
          </label>
          <div class="chat-scroll" style="margin-top:10px;max-height:340px;border:2px solid hsl(var(--foreground));">
            <div v-if="!selGroupId" class="empty" style="margin:16px;">Select a group to view its short-term conversation.</div>
            <div v-else-if="!groupTurns.length" class="empty" style="margin:16px;">No short-term messages for this group.</div>
            <template v-else>
              <div v-for="(t, i) in reversedGroupTurns" :key="i" class="msg-entry" :class="t.role">
                <div class="msg-head">
                  <span class="msg-name">{{ t.role === 'assistant' ? 'Holly' : (t.senderName || t.userId || 'User') }}</span>
                  <span class="msg-time">{{ fmtTime(t.timestamp) }}</span>
                </div>
                <div class="msg-body">{{ t.content }}</div>
              </div>
            </template>
          </div>
        </div>
      </div>

      <div class="ph" style="margin-top:18px;">
        <div class="ph-eye story">Qdrant</div>
        <div class="ph-title">长期记忆 &middot; Stored Memories</div>
        <div class="ph-desc">Browse recent records saved from the upstream WebSocket stream.</div>
      </div>
      <div class="panel" style="margin-bottom:14px;">
        <div class="ph2"><span class="ph2-title">Filters</span></div>
        <div class="pb">
          <form class="fgrid" @submit.prevent="loadMemories">
            <label>Group ID <input v-model="mf.groupId" placeholder="20000002" /></label>
            <label>User ID <input v-model="mf.userId" placeholder="10000003" /></label>
            <label>Type
              <select v-model="mf.messageType">
                <option value="group">group</option>
                <option value="">all</option>
              </select>
            </label>
            <label>Limit <input v-model.number="mf.limit" type="number" min="1" max="100" /></label>
            <button type="submit" style="align-self:flex-end;">Load</button>
          </form>
          <div class="mem-meta">
            <span>{{ memItems.length }} records</span>
            <span>{{ memCollection || 'Qdrant unavailable' }}</span>
            <code style="margin-left:auto;font-size:11px;">{{ memPath }}</code>
          </div>
          <p class="hint" style="margin-top:5px;">{{ memMsg }}</p>
        </div>
      </div>
      <div class="panel">
        <div class="ph2"><span class="ph2-title">Results</span></div>
        <div class="pb">
          <div class="mem-list">
            <div v-if="memLoading" class="empty">Loading...</div>
            <div v-else-if="memErr" class="empty">{{ memErr }}</div>
            <div v-else-if="!memItems.length" class="empty">No memories matched the current filters.</div>
            <template v-else>
              <article v-for="item in memItems" :key="item.sequence" class="mi">
                <div class="mi-h">
                  <span>{{ item.receivedAt || 'unknown' }}</span>
                  <span>seq {{ item.sequence != null ? item.sequence : '-' }}</span>
                </div>
                <div class="mi-m">
                  <span>group: {{ item.groupName || '-' }} ({{ item.groupId || '-' }})</span>
                  <span>user: {{ item.senderName || '-' }} ({{ item.userId || '-' }})</span>
                  <span>type: {{ item.messageType || '-' }}</span>
                </div>
                <pre>{{ item.displayText || item.rawMessage || item.rawContent || '(empty)' }}</pre>
              </article>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- Group Talk -->
    <div v-else-if="tab === 'group'" class="group-view">
      <div class="panel gp-panel gp-live" :style="{ flexBasis: gpLiveHeight + 'px' }">
        <div class="ph2">
          <span class="ph2-title">Live Messages</span>
          <button class="sec sm" @click="clearEntries">Clear</button>
        </div>
        <div class="chat-scroll" style="padding:12px;">
          <div v-if="!entries.length" class="empty" style="margin:8px;">Waiting for messages&hellip;</div>
          <template v-else>
            <article v-for="e in entries" :key="e.id" class="entry" :class="[e.kind, outcomeClass(e.outcome)]">
              <div class="entry-h">
                <span>{{ e.label || e.kind }} &mdash; {{ e.title }}<span v-if="e.outcome" class="oc-badge" :class="outcomeClass(e.outcome)">{{ thoughtOutcomeLabel(e.outcome) }}</span></span>
                <span>{{ fmtTime(e.timestamp) }}</span>
              </div>
              <pre>{{ fmtBody(e.body) }}</pre>
            </article>
          </template>
        </div>
      </div>

      <div class="gp-resizer" :class="{ dragging: gpDragging }" @mousedown="onResizerMousedown"></div>

      <div class="g2l gp-bottom">
        <div class="panel gp-panel">
          <div class="ph2">
            <span class="ph2-title">Groups</span>
            <button class="sec sm" @click="loadGroups">Refresh</button>
          </div>
          <div class="gp-scroll">
            <div v-if="!groups.length" class="empty">No active conversations yet.</div>
            <div class="glist" v-else>
              <div v-for="g in groups" :key="g.groupId"
                class="gi" :class="{active: selGroupId === g.groupId}"
                @click="selectGroup(g.groupId)">
                <div class="gi-name">{{ g.groupId }}</div>
                <div class="gi-meta">{{ g.turnCount }} turns &middot; {{ g.lastTurn ? fmtTime(g.lastTurn.timestamp) : '&ndash;' }}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="panel gp-panel">
          <div class="ph2">
            <span class="ph2-title">{{ selGroupId ? 'Group ' + selGroupId : 'Select a group' }}</span>
            <button v-if="selGroupId" class="sec sm" @click="loadGroupTurns(selGroupId)">Refresh</button>
          </div>
          <div class="chat-scroll">
            <div v-if="!selGroupId" class="empty" style="margin:16px;">Select a group from the list to view its conversation.</div>
            <div v-else-if="!groupTurns.length" class="empty" style="margin:16px;">No messages in this group today.</div>
            <template v-else>
              <div v-for="(t, i) in reversedGroupTurns" :key="i" class="msg-entry" :class="t.role">
                <div class="msg-head">
                  <span class="msg-name">{{ t.role === 'assistant' ? 'Holly' : (t.senderName || t.userId || 'User') }}</span>
                  <span class="msg-time">{{ fmtTime(t.timestamp) }}</span>
                </div>
                <div class="msg-body">{{ t.content }}</div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- Reflect -->
    <div v-else-if="tab === 'broadcast'">
      <div class="panel">
        <div class="ph2">
          <span class="ph2-title">世界观察播报</span>
          <button class="sec sm" @click="loadWorldBroadcast" :disabled="bcLoading">{{ bcLoading ? '读取中…' : '刷新群列表' }}</button>
        </div>
        <div class="pb">
          <div v-if="bcError" class="empty">{{ bcError }}</div>
          <div v-else-if="!bcGroups.length" class="empty">{{ bcLoading ? '正在向 NapCat 要群列表…' : '没拿到群列表，NapCat 可能没连上。' }}</div>
          <table v-else class="bc-table">
            <thead>
              <tr>
                <th>群</th>
                <th v-for="t in bcTopics" :key="t.topic">{{ t.topic }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in bcGroups" :key="g.groupId">
                <td class="bc-name"><span>{{ g.name }}</span><small>{{ g.groupId }}</small></td>
                <td v-for="t in bcTopics" :key="t.topic">
                  <button class="bc-cell" :class="{on: bcChecked(t.topic, g.groupId)}" :disabled="bcSwitching"
                    :title="bcChecked(t.topic, g.groupId) ? '点一下：这个话题不再发到这个群' : '点一下：这个话题发到这个群'"
                    @click="toggleWorldBroadcast(t.topic, g.groupId, !bcChecked(t.topic, g.groupId))">
                    <span class="mode-switch" :class="{on: bcChecked(t.topic, g.groupId)}"></span>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <div class="bc-hint">勾上＝这个话题的世界观察会发到那个群。点一下立刻生效，并写回 config.yaml，重启后还在。一个话题一个群都不勾，它就不播报了。</div>
        </div>
      </div>
    </div>

    <div v-else-if="tab === 'reflect'">
      <div class="ph">
        <div class="ph-eye signal">Holly</div>
        <div class="ph-title">Reflect</div>
        <div class="ph-desc">Autonomy reflection state, recent internal memories, and world observations.</div>
      </div>
      <div v-if="!autonomySidebar" class="empty">Waiting for autonomy snapshot...</div>
      <template v-else>
        <div class="reflect-grid">
          <div class="reflect-stat scheduler">
            <span class="reflect-stat-label">Autonomy</span>
            <b>{{ autonomySidebar.enabled ? 'On' : 'Off' }}</b>
            <small>world {{ autonomySidebar.worldObservationEnabled ? 'on' : 'off' }} &middot; reflect {{ autonomySidebar.memoryReflectionEnabled ? 'on' : 'off' }}</small>
          </div>
          <div class="reflect-stat story">
            <span class="reflect-stat-label">Reflect today</span>
            <b>{{ autonomySidebar.memoryReflectionDailyCount }}</b>
            <small>last {{ autonomySidebar.lastMemoryReflectionAtIso ? fmtTime(autonomySidebar.lastMemoryReflectionAtIso) : '-' }}</small>
          </div>
          <div class="reflect-stat llm">
            <span class="reflect-stat-label">World today</span>
            <b>{{ autonomySidebar.worldObservationDailyCount }}</b>
            <small>last {{ autonomySidebar.lastWorldObservationAtIso ? fmtTime(autonomySidebar.lastWorldObservationAtIso) : '-' }}</small>
          </div>
          <div class="reflect-stat signal">
            <span class="reflect-stat-label">Stored here</span>
            <b>{{ reflectMemories.length + reflectWorldObservations.length }}</b>
            <small>{{ reflectMemories.length }} memories &middot; {{ reflectWorldObservations.length }} observations</small>
          </div>
        </div>

        <div class="reflect-split">
          <div class="panel">
            <div class="ph2">
              <span class="ph2-title">Memory Reflection</span>
              <span class="reflect-pill" :class="{on: autonomySidebar.memoryReflectionEnabled}">{{ autonomySidebar.memoryReflectionEnabled ? 'Enabled' : 'Disabled' }}</span>
            </div>
            <div class="pb">
              <div v-if="!reflectMemories.length" class="empty">No internal memories yet.</div>
              <div v-else class="reflect-list">
                <article v-for="m in reflectMemories" :key="m.ts + m.topic" class="reflect-card">
                  <div class="reflect-card-head">
                    <span class="reflect-topic">{{ m.topic || 'internal memory' }}</span>
                    <span class="reflect-time">{{ fmtTime(m.ts) }}</span>
                  </div>
                  <div class="reflect-meta" v-if="m.reason">
                    <span>{{ m.reason }}</span>
                  </div>
                  <div class="reflect-body">{{ m.content }}</div>
                  <div class="reflect-links" v-if="m.urls && m.urls.length">
                    <a v-for="u in m.urls" :key="u" :href="u" target="_blank" rel="noreferrer">{{ u }}</a>
                  </div>
                </article>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="ph2">
              <span class="ph2-title">World Observations</span>
              <span class="reflect-pill" :class="{on: autonomySidebar.worldObservationEnabled}">{{ autonomySidebar.worldObservationEnabled ? 'Enabled' : 'Disabled' }}</span>
            </div>
            <div class="pb">
              <div v-if="!reflectWorldObservations.length" class="empty">No world observations yet.</div>
              <div v-else class="reflect-list">
                <article v-for="o in reflectWorldObservations" :key="o.observedAt + o.topic" class="reflect-card">
                  <div class="reflect-card-head">
                    <span class="reflect-topic">{{ o.topic || 'world observation' }}</span>
                    <span class="reflect-time">{{ fmtTime(o.observedAt) }}</span>
                  </div>
                  <div class="reflect-meta">
                    <span>{{ o.query || 'no query' }}</span>
                  </div>
                  <div class="reflect-body">{{ o.summary }}</div>
                  <div class="reflect-links" v-if="o.urls && o.urls.length">
                    <a v-for="u in o.urls" :key="u" :href="u" target="_blank" rel="noreferrer">{{ u }}</a>
                  </div>
                </article>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- Archive -->
    <div v-else-if="tab === 'archive'">
      <div class="ph">
        <div class="ph-eye">Holly</div>
        <div class="ph-title">Archive</div>
        <div class="ph-desc">Holly 想写就写的文章与诗，每篇都以独立网页保存在本地 archive/ 目录。</div>
      </div>
      <div class="panel">
        <div class="ph2">
          <span class="ph2-title">Works <span v-if="archiveItems.length" style="color:hsl(var(--muted-foreground));font-weight:600;">&middot; {{ archiveItems.length }}</span></span>
          <button class="sec sm" @click="loadArchive">Refresh</button>
        </div>
        <div class="pb">
          <div v-if="archiveLoading" class="empty">Loading...</div>
          <div v-else-if="archiveErr" class="empty">{{ archiveErr }}</div>
          <div v-else-if="!archiveItems.length" class="empty">Holly 还没有写下任何作品。</div>
          <div v-else class="reflect-list">
            <article v-for="w in archiveItems" :key="w.id" class="reflect-card">
              <div class="reflect-card-head">
                <span class="reflect-topic">{{ w.title }}</span>
                <span class="reflect-time">{{ fmtDateTime(w.ts) }}</span>
              </div>
              <div class="reflect-meta">
                <span>{{ w.kind === 'poem' ? '诗' : '文章' }}</span>
                <span v-if="w.reason">{{ w.reason }}</span>
              </div>
              <div class="reflect-body archive-body">{{ w.content }}</div>
              <div class="reflect-links" v-if="w.file">
                <a :href="'/archive/' + w.file" target="_blank" rel="noreferrer">本地页面 &middot; archive/{{ w.file }}</a>
              </div>
            </article>
          </div>
        </div>
      </div>
    </div>

    <!-- Usage -->
    <div v-else-if="tab === 'usage'">
      <div class="ph">
        <div class="ph-eye llm">Cache</div>
        <div class="ph-title">Prompt Cache 命中率</div>
        <div class="ph-desc">命中率 = 缓存读取 ÷ (读取 + 写入 + 未命中)，由后端统一派生。低于模型最小可缓存长度的请求不进分母，单独计入 Too short。</div>
      </div>
      <div class="panel" style="margin-bottom:16px;">
        <div class="ph2">
          <span class="ph2-title">Hit Rate &middot; 最近 {{ cacheHours.length }} 小时</span>
          <button class="sec sm" @click="loadPromptCache">Refresh</button>
        </div>
        <div class="pb">
          <div v-if="!cacheHours.length" class="empty">No prompt cache samples yet.</div>
          <template v-else>
            <div class="cache-heads">
              <div class="cache-head llm">
                <span>Window hit rate</span>
                <b>{{ fmtPct(cacheWindowHitRate) }}</b>
                <small>{{ fmtNum(cacheWindowCalls) }} calls</small>
              </div>
              <div class="cache-head scheduler">
                <span>Latest hour</span>
                <b>{{ fmtPct(cacheLatestHitRate) }}</b>
                <small>{{ cacheHours.length ? cacheHours[cacheHours.length - 1].bucket : '' }}</small>
              </div>
              <div class="cache-head cost">
                <span>Uncacheable</span>
                <b>{{ fmtNum(cacheWindowUncacheable) }}</b>
                <small>tokens below the model minimum</small>
              </div>
            </div>
            <div class="cache-bars">
              <div v-for="h in cacheHours" :key="h.bucket"
                   class="cache-bar" :class="{ idle: h.hitRate === null }"
                   :title="h.bucket + ' &middot; ' + (h.hitRate === null ? 'no cache-eligible input' : Math.round(h.hitRate * 100) + '% hit') + ' &middot; ' + fmtNum(h.inputTokens) + ' input tokens'">
                <i :style="{ height: (h.hitRate === null ? 0 : Math.max(2, h.hitRate * 100)) + '%' }"></i>
              </div>
            </div>
            <div class="cache-axis">
              <span>{{ cacheHours[0].bucket }}</span>
              <span>{{ cacheHours[cacheHours.length - 1].bucket }}</span>
            </div>
            <table class="usage-table" style="margin-top:14px;" v-if="cachePurposes.length">
              <thead>
                <tr><th>Purpose &middot; {{ cacheDate }}</th><th>Read</th><th>Write</th><th>Miss</th><th>Too short</th><th>Calls</th><th>Hit</th></tr>
              </thead>
              <tbody>
                <tr v-for="p in cachePurposes" :key="p.purpose">
                  <td>{{ p.purpose }}</td>
                  <td>{{ fmtNum(p.cacheReadInputTokens) }}</td>
                  <td>{{ fmtNum(p.cacheCreationInputTokens) }}</td>
                  <td>{{ fmtNum(p.uncachedInputTokens) }}</td>
                  <td>{{ fmtNum(p.uncacheableInputTokens) }}</td>
                  <td>{{ fmtNum(p.calls) }}</td>
                  <td>{{ fmtPct(p.hitRate) }}</td>
                </tr>
              </tbody>
            </table>
          </template>
        </div>
      </div>
      <div class="ph">
        <div class="ph-eye cost">Token</div>
        <div class="ph-title">每日 Token 用量</div>
        <div class="ph-desc">按日期与模型拆分普通输入、缓存写入、缓存读取及输出；历史聚合输入保留为 Unknown。</div>
      </div>
      <div class="panel">
        <div class="ph2">
          <span class="ph2-title">Daily Token Usage</span>
          <button class="sec sm" @click="loadUsageHistory">Refresh</button>
        </div>
        <div class="pb">
          <div v-if="!usageHistory.length" class="empty">No token usage recorded yet.</div>
          <template v-else>
            <div class="usage-total-row">
              <span>合计 &middot; 最近 {{ usageHistory.length }} 天</span>
              <b>{{ fmtNum(usageGrandTotal) }}<span style="font-size:13px;margin-left:6px;">tokens</span></b>
            </div>
            <div v-for="day in usageHistory" :key="day.date" class="usage-day">
              <div class="usage-day-head">
                <span class="usage-date">{{ day.date }}</span>
                <span class="usage-day-total">{{ fmtNum(day.totalTokens) }} tokens</span>
              </div>
              <table class="usage-table">
                <thead>
                  <tr><th>Model</th><th>Uncached</th><th>Cache write</th><th>Cache read</th><th>Too short</th><th>Unknown</th><th>Output</th><th>Total</th><th>Hit</th></tr>
                </thead>
                <tbody>
                  <tr v-for="m in day.models" :key="m.model">
                    <td>{{ m.model }}</td>
                    <td>{{ fmtNum(m.uncachedInputTokens) }}</td>
                    <td>{{ fmtNum(m.cacheCreationInputTokens) }}</td>
                    <td>{{ fmtNum(m.cacheReadInputTokens) }}</td>
                    <td>{{ fmtNum(m.uncacheableInputTokens) }}</td>
                    <td>{{ fmtNum(m.unattributedInputTokens) }}</td>
                    <td>{{ fmtNum(m.outputTokens) }}</td>
                    <td>{{ fmtNum(m.totalTokens) }}</td>
                    <td>{{ fmtPct(m.hitRate) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </div>
      </div>
    </div>
  </main>
</div>

<script src="/vendor/vue.global.prod.js"></script>
<script>
var _wsTarget = ${JSON.stringify(wsTargetUrl)};
var _Vue = Vue;
var createApp = _Vue.createApp;
var ref = _Vue.ref;
var computed = _Vue.computed;
var onMounted = _Vue.onMounted;
var onUnmounted = _Vue.onUnmounted;
var watch = _Vue.watch;

// ---------- 监控页的前端 ----------
//
// 刻意写成 ES5 风格（var / function，没有箭头函数、没有解构、没有构建步骤）：
// 这一整块是拼进 HTML 字符串里直接发给浏览器的，没有转译环节，
// 所以语法必须保守到「任何浏览器打开就能跑」。
//
// 数据流只有一条：后端 SSE 推来 snapshot（补全现状）和一串增量事件，
// handlePayload 按类型分发到各自的 ref。页面自己不保存任何状态——
// 刷新一次就重新从 snapshot 长出来。

createApp({
  setup: function() {
    var tab = ref(window.location.pathname === '/thoughts' ? 'thoughts' : 'agent');

    // Agent state
    var wsTargetUrl = ref(_wsTarget);
    var wsStatus = ref({ state: 'connecting', detail: '', updatedAt: '' });
    var wsStatusLabel = computed(function() {
      var s = wsStatus.value.state;
      if (s === 'open') return 'Connected';
      if (s === 'connecting') return 'Connecting';
      if (s === 'error') return 'Error';
      return 'Disconnected';
    });
    var entries = ref([]);
    var renderedIds = new Set();
    var convPreview = ref(null);
    var claudeUsage = ref(null);
    var tokenStats = ref(null);
    var usageHistory = ref([]);
    var usageGrandTotal = ref(0);
    var cacheHours = ref([]);
    var cachePurposes = ref([]);
    var cacheDate = ref('');
    var groupEntries = computed(function() {
      return entries.value.filter(function(e) {
        return e.kind === 'incoming' || e.kind === 'outgoing' || e.kind === 'assistant';
      });
    });
    var profiles = ref([]);
    var selProfile = ref('');
    var profileMeta = ref('Loading model profiles...');
    var switching = ref(false);
    var convMetaText = computed(function() {
      var p = convPreview.value;
      if (!p) return 'Waiting for the first model request...';
      var g = p.groupId || 'unknown_group';
      var u = p.updatedAt ? new Date(p.updatedAt).toLocaleTimeString() : '?';
      var tok = typeof p.estimatedTokens === 'number' ? p.estimatedTokens : '?';
      var lim = typeof p.contextLimitTokens === 'number' ? p.contextLimitTokens : '?';
      var cmp = typeof p.compressThresholdTokens === 'number' ? p.compressThresholdTokens : '?';
      var msgs = (p.messages && p.messages.length) ? p.messages.length : 0;
      return 'Group: ' + g + '  |  Msgs: ' + msgs + '  |  Tokens: ~' + tok + '/' + lim + '  |  Compress@' + cmp + '  |  ' + (p.compressed ? 'Compressed' : 'Uncompressed') + '  |  ' + u;
    });

    // Thought timeline state
    var thoughts = ref([]);
    var thoughtIds = new Set();
    var thoughtKindFilter = ref('all');
    var filteredThoughts = computed(function() {
      if (thoughtKindFilter.value === 'all') return thoughts.value;
      return thoughts.value.filter(function(item) { return item.kind === thoughtKindFilter.value; });
    });

    // Memory state
    var mf = ref({ groupId: '', userId: '', messageType: 'group', limit: 20 });
    var memItems = ref([]);
    var memCollection = ref('');
    var memLoading = ref(false);
    var memErr = ref('');
    var memMsg = ref('');
    var memPath = ref('/api/memories');

    // Reflect state
    var autonomySidebar = ref(null);
    var reflectMemories = computed(function() {
      var items = autonomySidebar.value && autonomySidebar.value.recentMemories;
      return Array.isArray(items) ? items.slice().reverse() : [];
    });
    var reflectWorldObservations = computed(function() {
      var items = autonomySidebar.value && autonomySidebar.value.recentWorldObservations;
      return Array.isArray(items) ? items.slice().reverse() : [];
    });
    // Broadcast 标签页。群列表要现问 NapCat，所以这一页自己取数据，不搭 autonomy 快照的便车。
    var bcSwitching = ref(false);
    var bcLoading = ref(false);
    var bcError = ref('');
    var bcGroups = ref([]);
    var bcTopics = ref([]);
    function applyBroadcastSettings(d) {
      bcGroups.value = Array.isArray(d.groups) ? d.groups : [];
      bcTopics.value = Array.isArray(d.topics) ? d.topics : [];
    }
    function loadWorldBroadcast() {
      if (bcLoading.value) return;
      bcLoading.value = true;
      bcError.value = '';
      fetch('/api/world-broadcast').then(function(r) {
        return r.json().then(function(d) {
          if (!r.ok) throw new Error(d.error || 'Failed to load broadcast settings');
          applyBroadcastSettings(d);
        });
      }).catch(function(e) {
        bcError.value = e.message;
      }).finally(function() {
        bcLoading.value = false;
      });
    }
    function bcChecked(topic, groupId) {
      var entry = bcTopics.value.find(function(t) { return t.topic === topic; });
      return !!entry && entry.groupIds.indexOf(groupId) >= 0;
    }

    // Archive state
    var archiveItems = ref([]);
    var archiveLoading = ref(false);
    var archiveErr = ref('');

    // Theme state (日间 / 守夜) — 初值由 <head> 的免闪脚本写在 data-theme 上
    var theme = ref(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    function toggleTheme() {
      theme.value = theme.value === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', theme.value);
      try { localStorage.setItem('holly-theme', theme.value); } catch (e) { /* 隐私模式下不持久化，本次会话仍生效 */ }
    }

    // Read-only mode state
    var readOnly = ref(false);
    var modeSwitching = ref(false);

    // Group Talk state
    var groups = ref([]);
    var selGroupId = ref(null);
    var groupTurns = ref([]);
    var reversedGroupTurns = computed(function() { return groupTurns.value.slice().reverse(); });

    // Resizer drag state
    var gpLiveHeight = ref(280);
    var gpDragging = ref(false);
    var _dragStartY = 0;
    var _dragStartH = 0;
    function onResizerMousedown(e) {
      gpDragging.value = true;
      _dragStartY = e.clientY;
      _dragStartH = gpLiveHeight.value;
      e.preventDefault();
      document.addEventListener('mousemove', _onResizerMousemove);
      document.addEventListener('mouseup', _onResizerMouseup);
    }
    function _onResizerMousemove(e) {
      if (!gpDragging.value) return;
      var delta = e.clientY - _dragStartY;
      gpLiveHeight.value = Math.max(80, Math.min(_dragStartH + delta, window.innerHeight - 200));
    }
    function _onResizerMouseup() {
      gpDragging.value = false;
      document.removeEventListener('mousemove', _onResizerMousemove);
      document.removeEventListener('mouseup', _onResizerMouseup);
    }

    // SSE
    var es = null;
    var streamConn = false;

    function clearEntries() {
      entries.value = [];
      renderedIds.clear();
    }

    function fmtTime(ts) {
      if (!ts) return '-';
      try { return new Date(ts).toLocaleTimeString(); } catch(e) { return String(ts); }
    }

    function fmtDateTime(ts) {
      if (!ts) return '-';
      try { return new Date(ts).toLocaleString(); } catch(e) { return String(ts); }
    }

    function fmtDuration(ms) {
      if (typeof ms !== 'number' || !isFinite(ms)) return '-';
      return ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : Math.round(ms) + 'ms';
    }

    function thoughtKindLabel(kind) {
      if (kind === 'bootstrap') return '启动定向';
      if (kind === 'qq_mode') return 'QQ 模式';
      if (kind === 'proactive') return '主动判断';
      if (kind === 'autonomy') return '每分钟检查';
      return '群消息判断';
    }

    // 只有「开口 / 沉默」这一组结局值得上色。其余 outcome（写入记忆、完成观察……）
    // 各自属于只有一种结局的 kind，给它们上色只会把这一栏变成调色板。
    // 思考卡和 Live Messages 的判断条目共用它：类名两处一致，颜色各自定义。
    function outcomeClass(outcome) {
      if (outcome === 'reply' || outcome === 'proactive_live') return 'oc-reply';
      if (outcome === 'silent' || outcome === 'proactive_shadow') return 'oc-silent';
      if (outcome === 'suppressed') return 'oc-suppressed';
      return '';
    }

    function thoughtOutcomeLabel(outcome) {
      var labels = {
        reply: '选择回复', silent: '保持沉默', suppressed: '话没出去', active: '主动接入', observe: '仅观察', offline: '离线',
        memory_written: '写入记忆', no_memory: '未写记忆', idle: '未行动', disabled: '已关闭',
        world_observed: '完成观察', world_empty: '观察无结果', archive_written: '完成创作',
        proactive_shadow: '影子动作', proactive_live: '主动发言', failed: '检查失败'
      };
      return labels[outcome] || outcome;
    }

    function fmtBody(body) {
      if (typeof body !== 'string') return JSON.stringify(body, null, 2);
      try { return JSON.stringify(JSON.parse(body), null, 2); } catch(e) { return body; }
    }

    function usagePct(u) {
      if (typeof u !== 'number') return 'n/a';
      return (u * 100).toFixed(1) + '%';
    }
    function usageWidth(u) {
      if (typeof u !== 'number') return '0%';
      return Math.max(0, Math.min(100, u * 100)).toFixed(1) + '%';
    }
    function usageColor(u) {
      if (typeof u !== 'number') return 'hsl(var(--hairline))';
      if (u >= 0.9) return 'hsl(var(--signal))';
      if (u >= 0.6) return 'hsl(var(--scheduler))';
      return 'hsl(var(--story))';
    }
    function fmtReset(ms) {
      if (typeof ms !== 'number') return '-';
      var diff = ms - Date.now();
      if (diff <= 0) return 'soon';
      var mins = Math.round(diff / 60000);
      if (mins < 60) return 'in ' + mins + 'm';
      var hrs = Math.floor(mins / 60);
      var rem = mins % 60;
      if (hrs < 24) return 'in ' + hrs + 'h' + (rem ? ' ' + rem + 'm' : '');
      var days = Math.floor(hrs / 24);
      var remH = hrs % 24;
      return 'in ' + days + 'd' + (remH ? ' ' + remH + 'h' : '');
    }

    // 用 id 去重：SSE 断线重连后浏览器会重新拿一次 snapshot，里面必然包含
    // 已经显示过的条目。上限 120 条跟后端内存里保留的条数一致。
    function pushEntry(entry) {
      if (renderedIds.has(entry.id)) return;
      renderedIds.add(entry.id);
      entries.value.unshift(entry);
      if (entries.value.length > 120) entries.value.splice(120);
    }

    function pushThought(thought) {
      if (!thought || !thought.id || thoughtIds.has(thought.id)) return;
      thoughtIds.add(thought.id);
      thoughts.value.unshift(thought);
      if (thoughts.value.length > 400) thoughts.value.splice(400);
    }

    function replaceThoughts(items) {
      thoughtIds.clear();
      thoughts.value = [];
      var visible = Array.isArray(items) ? items : [];
      for (var i = 0; i < visible.length; i++) pushThought(visible[i]);
    }

    // 收到快照 = 整页重置。所有 ref 一次性覆盖，包括清空已渲染 id——
    // 快照代表「后端此刻的完整现状」，页面上比它旧的东西一律作废。
    function renderSnapshot(payload) {
      renderedIds.clear();
      wsStatus.value = payload.status;
      convPreview.value = payload.conversationPreview;
      autonomySidebar.value = payload.autonomySidebar || null;
      readOnly.value = !!payload.readOnly;
      replaceThoughts(payload.thoughts || []);
      if (payload.claudeUsage) { claudeUsage.value = payload.claudeUsage; }
      if (payload.tokenStats) { tokenStats.value = payload.tokenStats; }
      entries.value = [];
      var visible = payload.history || [];
      for (var i = visible.length - 1; i >= 0; i--) { pushEntry(visible[i]); }
    }

    function handlePayload(payload) {
      if (payload.type === 'snapshot') { renderSnapshot(payload); return; }
      if (payload.type === 'status') { wsStatus.value = payload.status; return; }
      if (payload.type === 'conversation') { convPreview.value = payload.conversationPreview; return; }
      if (payload.type === 'usage') { if (payload.claudeUsage) { claudeUsage.value = payload.claudeUsage; } return; }
      if (payload.type === 'tokens') { tokenStats.value = payload.tokenStats; if (tab.value === 'usage') { loadUsageHistory(); loadPromptCache(); } return; }
      if (payload.type === 'autonomy') { autonomySidebar.value = payload.autonomySidebar || null; return; }
      if (payload.type === 'archive') { applyArchiveWork(payload.work); return; }
      if (payload.type === 'mode') { readOnly.value = !!payload.readOnly; return; }
      if (payload.type === 'turn') { applyGroupTurn(payload.groupId, payload.turn); return; }
      if (payload.type === 'thought') { pushThought(payload.thought); return; }
      if (payload.type === 'entry') { pushEntry(payload.entry); }
    }

    // 断线重连交给浏览器：EventSource 原生就会自动重连，这里只负责在状态变化时
    // 往流水里记一笔，让人知道刚才断过。streamConn 是为了避免重连过程中
    // 反复刷「已连接/已断开」。
    function connectES() {
      if (es) { es.close(); }
      es = new EventSource('/api/ws/events');
      es.addEventListener('open', function() {
        if (!streamConn) {
          pushEntry({ id: Date.now(), kind: 'status', title: 'Monitor Stream', body: 'Connected to backend event stream.', timestamp: new Date().toISOString() });
          streamConn = true;
        }
      });
      es.addEventListener('snapshot', function(ev) { handlePayload(JSON.parse(ev.data)); });
      es.onmessage = function(ev) { handlePayload(JSON.parse(ev.data)); };
      es.onerror = function() {
        if (!streamConn) return;
        streamConn = false;
        pushEntry({ id: Date.now(), kind: 'error', title: 'Monitor Stream', body: 'Lost connection. Browser will retry automatically.', timestamp: new Date().toISOString() });
      };
    }

    function loadProfiles() {
      return fetch('/api/llm/profiles').then(function(r) {
        return r.json().then(function(d) {
          if (!r.ok) throw new Error(d.error || 'Failed to load profiles');
          profiles.value = d.profiles;
          selProfile.value = d.active;
          profileMeta.value = 'Response: ' + d.displayName + ' · Decision: ' + d.decisionDisplayName;
        });
      }).catch(function(e) {
        profileMeta.value = 'Failed: ' + e.message;
      });
    }

    function switchProfile() {
      if (!selProfile.value) return;
      switching.value = true;
      fetch('/api/llm/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: selProfile.value })
      }).then(function(r) {
        return r.json().then(function(d) {
          if (!r.ok) throw new Error(d.error || 'Failed to switch');
          profileMeta.value = 'Active model: ' + d.displayName;
          pushEntry({ id: Date.now(), kind: 'status', title: 'Profile Switched', body: d.displayName, timestamp: new Date().toISOString() });
        });
      }).catch(function(e) {
        pushEntry({ id: Date.now(), kind: 'error', title: 'Profile Switch Failed', body: e.message, timestamp: new Date().toISOString() });
        return loadProfiles();
      }).finally(function() {
        switching.value = false;
      });
    }

    function reconnect() {
      fetch('/api/ws/reconnect', { method: 'POST' }).then(function(r) {
        return r.json().then(function(d) {
          if (!r.ok) throw new Error(d.error || 'Reconnect failed');
          pushEntry({ id: Date.now(), kind: 'status', title: 'Reconnect Requested', body: d.message, timestamp: new Date().toISOString() });
        });
      }).catch(function(e) {
        pushEntry({ id: Date.now(), kind: 'error', title: 'Reconnect Failed', body: e.message, timestamp: new Date().toISOString() });
      });
    }

    function loadMemories() {
      var f = mf.value;
      var p = new URLSearchParams();
      if (f.groupId && f.groupId.trim()) p.set('group_id', f.groupId.trim());
      if (f.userId && f.userId.trim()) p.set('user_id', f.userId.trim());
      if (f.messageType && f.messageType.trim()) p.set('message_type', f.messageType.trim());
      if (f.limit) p.set('limit', String(f.limit));
      var path = '/api/memories' + (p.toString() ? '?' + p.toString() : '');
      memPath.value = path;
      memLoading.value = true;
      memErr.value = '';
      memMsg.value = 'Loading memories...';
      fetch(path).then(function(r) {
        return r.json().then(function(d) {
          if (!r.ok) throw new Error(d.error || 'Failed to load memories');
          memItems.value = d.items;
          memCollection.value = d.collection || '';
          memMsg.value = 'Showing most recent matching records.';
        });
      }).catch(function(e) {
        memErr.value = e.message;
        memItems.value = [];
        memMsg.value = e.message;
      }).finally(function() {
        memLoading.value = false;
      });
    }

    function loadThoughts() {
      fetch('/api/thoughts?limit=400').then(function(r) {
        return r.json().then(function(d) {
          if (!r.ok) throw new Error(d.error || 'Failed to load thoughts');
          replaceThoughts(d.items || []);
        });
      }).catch(function(e) {
        pushEntry({ id: Date.now(), kind: 'error', title: 'Thoughts Load Failed', body: e.message, timestamp: new Date().toISOString() });
      });
    }

    function loadArchive() {
      archiveLoading.value = true;
      archiveErr.value = '';
      fetch('/api/archive').then(function(r) {
        return r.json().then(function(d) {
          if (!r.ok) throw new Error(d.error || 'Failed to load archive');
          archiveItems.value = d.items || [];
        });
      }).catch(function(e) {
        archiveErr.value = e.message;
        archiveItems.value = [];
      }).finally(function() {
        archiveLoading.value = false;
      });
    }

    function applyArchiveWork(work) {
      if (!work || !work.id) return;
      var exists = archiveItems.value.some(function(w) { return w.id === work.id; });
      if (!exists) archiveItems.value.unshift(work);
    }

    // 勾一个「话题→群」。服务端保存后把最新的全量设置回给我们，直接用它覆盖，省得本地再拼一遍
    // 状态——本地拼错的话，页面显示的和真正会发的就对不上了。
    function toggleWorldBroadcast(topic, groupId, enabled) {
      if (bcSwitching.value) return;
      bcSwitching.value = true;
      bcError.value = '';
      fetch('/api/world-broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: topic, group_id: groupId, enabled: enabled })
      }).then(function(r) {
        return r.json().then(function(d) {
          if (!r.ok) throw new Error(d.error || 'Failed to switch broadcast');
          applyBroadcastSettings(d);
        });
      }).catch(function(e) {
        bcError.value = e.message;
        pushEntry({ id: Date.now(), kind: 'error', title: 'Broadcast Switch Failed', body: e.message, timestamp: new Date().toISOString() });
      }).finally(function() {
        bcSwitching.value = false;
      });
    }

    function toggleReadOnly() {
      if (modeSwitching.value) return;
      var next = !readOnly.value;
      modeSwitching.value = true;
      fetch('/api/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ read_only: next })
      }).then(function(r) {
        return r.json().then(function(d) {
          if (!r.ok) throw new Error(d.error || 'Failed to switch mode');
          readOnly.value = !!d.readOnly;
        });
      }).catch(function(e) {
        pushEntry({ id: Date.now(), kind: 'error', title: 'Mode Switch Failed', body: e.message, timestamp: new Date().toISOString() });
      }).finally(function() {
        modeSwitching.value = false;
      });
    }

    function loadGroups() {
      fetch('/api/conversations').then(function(r) {
        return r.json().then(function(d) { groups.value = d.groups || []; });
      }).catch(function() { groups.value = []; });
    }

    function loadGroupTurns(groupId) {
      fetch('/api/conversations/' + encodeURIComponent(groupId)).then(function(r) {
        return r.json().then(function(d) { groupTurns.value = d.turns || []; });
      }).catch(function() { groupTurns.value = []; });
    }

    function selectGroup(groupId) {
      selGroupId.value = groupId;
      loadGroupTurns(groupId);
    }

    function onPickShortTermGroup() {
      if (selGroupId.value) { loadGroupTurns(selGroupId.value); }
      else { groupTurns.value = []; }
    }

    function applyGroupTurn(groupId, turn) {
      if (!groupId || !turn) return;
      var existingIndex = groups.value.findIndex(function(g) { return g.groupId === groupId; });
      if (existingIndex === -1) {
        groups.value.unshift({ groupId: groupId, turnCount: 1, lastTurn: turn });
      } else {
        var existing = groups.value[existingIndex];
        groups.value.splice(existingIndex, 1, {
          groupId: groupId,
          turnCount: (existing.turnCount || 0) + 1,
          lastTurn: turn
        });
      }
      if (selGroupId.value === groupId) {
        groupTurns.value.push(turn);
      }
    }

    watch(tab, function(t) {
      if (t === 'thoughts') { loadThoughts(); }
      if (t === 'memory') { loadMemories(); loadGroups(); }
      if (t === 'group') { loadGroups(); }
      if (t === 'usage') { loadUsageHistory(); loadPromptCache(); }
      if (t === 'archive') { loadArchive(); }
    });

    function fmtNum(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '0';
      return n.toLocaleString('en-US');
    }

    // null means "no cache-eligible input in this window", which is not 0%.
    function fmtPct(rate) {
      if (typeof rate !== 'number' || !isFinite(rate)) return '—';
      return Math.round(rate * 100) + '%';
    }

    function refreshUsage() {
      fetch('/api/usage/refresh', { method: 'POST' }).then(function(r) { return r.json(); }).then(function(d) {
        if (d.claudeUsage) { claudeUsage.value = d.claudeUsage; }
        if (d.tokenStats) { tokenStats.value = d.tokenStats; }
      }).catch(function() {});
    }

    // The window figure is re-derived from the window's own totals, never
    // averaged from the per-hour percentages: an hour with 12 calls must not
    // weigh the same as an hour with 400.
    function sumCacheWindow() {
      return cacheHours.value.reduce(function(acc, point) {
        acc.read += point.cacheReadInputTokens || 0;
        acc.write += point.cacheCreationInputTokens || 0;
        acc.miss += point.uncachedInputTokens || 0;
        acc.uncacheable += point.uncacheableInputTokens || 0;
        acc.calls += point.calls || 0;
        return acc;
      }, { read: 0, write: 0, miss: 0, uncacheable: 0, calls: 0 });
    }

    var cacheWindowHitRate = computed(function() {
      var totals = sumCacheWindow();
      var eligible = totals.read + totals.write + totals.miss;
      return eligible === 0 ? null : totals.read / eligible;
    });
    var cacheWindowCalls = computed(function() { return sumCacheWindow().calls; });
    var cacheWindowUncacheable = computed(function() { return sumCacheWindow().uncacheable; });
    var cacheLatestHitRate = computed(function() {
      var last = cacheHours.value[cacheHours.value.length - 1];
      return last ? last.hitRate : null;
    });

    function loadPromptCache() {
      fetch('/api/usage/cache?hours=48').then(function(r) {
        return r.json().then(function(d) {
          cacheHours.value = d.hours || [];
          cachePurposes.value = d.purposes || [];
          cacheDate.value = d.date || '';
        });
      }).catch(function() { cacheHours.value = []; cachePurposes.value = []; });
    }

    function loadUsageHistory() {
      fetch('/api/usage/history').then(function(r) {
        return r.json().then(function(d) {
          usageHistory.value = d.days || [];
          usageGrandTotal.value = d.grandTotal || 0;
        });
      }).catch(function() { usageHistory.value = []; usageGrandTotal.value = 0; });
    }

    onMounted(function() {
      connectES();
      loadProfiles();
      refreshUsage();
    });

    onUnmounted(function() {
      if (es) { es.close(); }
    });

    return {
      tab, wsTargetUrl, wsStatus, wsStatusLabel,
      entries, groupEntries, convPreview, convMetaText, claudeUsage, tokenStats,
      thoughts, thoughtKindFilter, filteredThoughts,
      usageHistory, usageGrandTotal,
      cacheHours, cachePurposes, cacheDate,
      cacheWindowHitRate, cacheWindowCalls, cacheWindowUncacheable, cacheLatestHitRate,
      fmtPct, loadPromptCache,
      profiles, selProfile, profileMeta, switching,
      mf, memItems, memCollection, memLoading, memErr, memMsg, memPath,
      autonomySidebar, reflectMemories, reflectWorldObservations,
      bcGroups, bcTopics, bcChecked, bcLoading, bcError, bcSwitching,
      loadWorldBroadcast, toggleWorldBroadcast,
      archiveItems, archiveLoading, archiveErr,
      readOnly, modeSwitching, toggleReadOnly,
      theme, toggleTheme,
      groups, selGroupId, groupTurns, reversedGroupTurns,
      gpLiveHeight, gpDragging, onResizerMousedown,
      fmtTime, fmtDateTime, fmtDuration, fmtBody, thoughtKindLabel, thoughtOutcomeLabel, outcomeClass, usagePct, usageWidth, usageColor, fmtReset, fmtNum,
      clearEntries, reconnect, switchProfile, loadMemories, loadGroups, loadGroupTurns, selectGroup, onPickShortTermGroup,
      loadThoughts, loadUsageHistory, loadArchive
    };
  }
}).mount('#app');
</script>
</body>
</html>`;
}
