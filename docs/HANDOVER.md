# Octa Assistant — التوثيق الكامل / Complete handover

النسخة 0.1.0 — 8 سبتمبر 2026. الجزء العربي الأول، وبعده الإنجليزي.

---

## الجزء العربي

### 1. إيه هو Octa

Octa مساعد مكتبي (Windows) بيتكلم معاك بالصوت أو الكتابة، بالعربي المصري أو الإنجليزي، ويحوّل الكلام لخطة مدروسة وشغل خالص. مبني من الصفر (Electron + TypeScript) وبيجمع فكرتين: Tamim OS (المهام والعملاء والفواتير والمستندات) وOcta Code (بناء الكود).

بيقدر يعمل:

- **مراجعة موقع**: CRO وSEO وسرعة وواجهة وكوبي ومنافسين، وتقرير PDF مرتّب بالأولوية.
- **بناء موقع**: هيكل الصفحات، الكوبي، نظام التصميم، بناء فعلي بـ Astro في مساحة معزولة، فحص، وتسليم.
- **ماركتنج لأي مشروع**: بحث بـ 100 مصدر في 5 لغات، persona، منافسين، عرض، خطة 13 قسم، محتوى وإعلانات أول أسبوع.
- **تفكير في قرار**: جلسة منظمة (six hats أو concept fan) ومذكرة قرار ومهام.
- **فاتورة**: من الوقت المسجّل لـ PDF بالبراند، موافقة، إرسال، متابعة +7/+14/+21.
- **بحث عام**: أي سؤال، بنفس قاعدة الـ 100 مصدر.

### 2. الفكرة الأساسية: تلات عقول وحارس

| الدور | الموديل | بيعمل إيه |
|---|---|---|
| الصوت والمحادثة | Gemini Live | يسمعك ويرد بلغتك، wake word "يا أوكتا" أو ضغطة زرار |
| التخطيط (مناظرة) | Claude Fable 5.1 + GPT-6 Astra | Fable يكتب الخطة، Astra ينتقدها، يتفقوا في 4 جولات بحد أقصى، وأي حاجة مش واضحة **بيسألوك عليها قبل أي تنفيذ** |
| البحث والتنفيذ وكتابة الكود | GPT-5.6 Luna | رخيص وسريع، بيقرأ مئات الصفحات، بينفذ الـ skills، بيبني الكود |
| المراجعة | GPT-5.6 Sol | بيراجع كل خطوة قبل ما توصلك |

**قواعد مش بتتكسر** (متنفذة في الكود مش في البرومبت): الرد بلغتك، الأسئلة قبل التنفيذ، أي بحث لازم 100 مصدر و40 domain و5 لغات (عربي، إنجليزي، فرنساوي، ألماني، روسي)، كل رقم له مصدر، أي إرسال أو نشر أو دفع بيستنى موافقتك (في البرنامج أو على الموبايل أو بالصوت بعد ما يقرالك النص).

### 3. أول تشغيل (10 دقايق)

1. افتح Octa. هيفتح معالج الإعداد (7 خطوات): اللغة، المفاتيح، المجلدات، فحص الصحة، تسجيلات دخول البحث، Photoshop، تم.
2. **المفاتيح**: مفتاح Gemini من AI Studio (إجباري). Brave Search اختياري. ntfy topic للإشعارات على الموبايل.
3. **المجلدات**: مسار الـ vault بتاع Obsidian (فيه مجلد `knowledge/` هو عقل الشركة)، وOcta home (الافتراضي `C:\Octa`).
4. **الأدوات**: Claude Code وCodex لازم يكونوا متسطبين ومسجلين دخول (`claude` ثم `/login`، و`codex login`). Python 3.12 وPlaywright بيتسطبوا من زرار في المعالج.
5. **تسجيلات الدخول**: Facebook وX لو عايز البحث يقرأ منهم (نافذة بتفتح وتسجل بنفسك، والبرنامج بيقرأ بس).
6. **Photoshop**: حط مسار الـ exe أو سيبه فاضي (فيه بديل بيكتب PSD من غير Photoshop).
7. آخر صفحة فحص صحة حي: كل صف أحمر جنبه طريقة الإصلاح.

بعد كده من صفحة Brain ابدأ **المقابلة** (20 سؤال بالعربي عن شغلك وأسعارك وعميلك المثالي وصوتك). دي اللي بتخلي كل نتيجة بصوتك وأرقامك.

### 4. الاستخدام اليومي

- قول "يا أوكتا" أو اضغط الزرار، واحكي. أو اكتب في صفحة Octa.
- لما تقول "خطط" أو تدوس Start على أي workflow، الخطة بتطلع مع الأسئلة. جاوب، ووافق.
- الخطوات بتتنفذ وبتشوفها لايف. أي بوابة موافقة بتظهر بالنص الحرفي اللي هيتبعت.
- النتائج في صفحة Octa وفي `C:\Octa\jobs\<id>\out`، والتقارير بتتحفظ في الـ vault.
- **الخريطة (Map)**: كل الـ skills على شجرة أقسام، بتنوّر حسب آخر تشغيل.
- **Builds**: بناء أدوات ومواقع (spec → plan → build في worktree → QA → merge).
- **Jobs / Workflows / Skills / Brain / Tasks / Clients / Health / Settings**: كل واحدة واضحة من اسمها.

### 5. الصفحات والمجلدات

```
C:\Octa\                Octa home: octa.db (الإعدادات والمهام)، jobs\، knowledge\ (نسخة من الـ vault)، browser\ (profile البحث)، models\ (wake word)، builds\
<vault>\knowledge\      عقل الشركة: company.md, offers\, icp.md, voice.md, sops\, pricing.md, clients\, projects\, personas\, competitors\, decisions.md
skills-library\         87 skill (+ مراجع) مع MANIFEST.json وREVIEW.md
docs\00..07             التصميم الكامل والقرارات
```

### 6. اللي لازم تعمله إنت (مش هيشتغل من غيره)

| البند | ليه |
|---|---|
| `claude` → `/login` | جلسة Claude Code منتهية |
| تفعيل موديل Fable في حساب Anthropic (أو اختيار Opus مؤقتاً من الإعدادات) | الحساب بيرجّع 403 |
| مفتاح Gemini في المعالج | الصوت والمحادثة |
| مسار الـ vault + المقابلة | من غيره النتائج عامة |
| ملفات wake word (3 ONNX في `C:\Octa\models`) | لحد ما تتعمل الزرار شغال |
| مسح الـ token من `.env` بتاع Octa Code القديم | قبل أي نشر |

### 7. لعبد الرحمن (بيدو موسى): تسطيب على جهاز تاني

اتبع `SETUP.md` (عربي وإنجليزي): سطّب Node 22 وClaude Code وCodex، سجّل دخول فيهم، افتح Octa، امشي مع المعالج، اعمل المقابلة. الـ skills والكود مشتركين من GitHub، بس كل واحد له عقل شركة ومفاتيح خاصة.

**التحديثات:** أول مرة بس بتسطّب المثبّت من صفحة الإصدارات. بعد كده البرنامج بيفحص GitHub لوحده لما يفتح، ولو فيه إصدار أجدد بيظهر شريط فوق: "نزّل التحديث". التنزيل تفاضلي، يعني بينزّل الجزء اللي اتغيّر من المثبّت بس مش البرنامج كله، وبيوريك النسبة والحجم، وبعدها زرار "أعد التشغيل وحدّث" بيسطّب بصمت ويفتح البرنامج تاني. علشان كده ما تمسحش ملفات الإصدارات القديمة من GitHub.

### 8. حالة الاختبار بصراحة

- 220 اختبار آلي خضر على كل الوحدات.
- اتجرّب حقيقي: بحث 100 مصدر في 5 لغات (15 دقيقة)، تنظيف نص بـ Luna، بناء موقع Astro عربي في worktree، مراجعة Sol، مذكرة قرار W4، مسودة فاتورة W5.
- **ما اتجرّبش حقيقي**: الصوت بالميكروفون (محتاج مفتاح Gemini وموديلات wake word)، مناظرة Fable/Astra كاملة (Claude واقف على login)، مراجعة موقع حي (الموقع المستهدف ما فتحش وقت التجربة).

---

## English part

### 1. What Octa is

Octa is a voice-first Windows desktop assistant. It listens in Egyptian Arabic or English, turns the conversation into a researched plan, asks back whenever something is unclear, and executes through a library of 87 skills and six launch workflows: review a website, build a website, market a project, think through a decision, send an invoice, research a question. It is a new Electron + TypeScript codebase that merges the ideas of Tamim OS (tasks, clients, invoices, documents) and Octa Code (autonomous code building).

### 2. Architecture

| Role | Model | Notes |
|---|---|---|
| Voice and conversation | Gemini Live | language mirror, wake word "يا أوكتا", push-to-talk |
| Planning debate | Claude Fable 5.1 (medium) + GPT-6 Astra (xhigh) | Fable drafts, Astra critiques, up to 4 rounds; blocking questions stop execution |
| Research, execution, code | GPT-5.6 Luna (fast, max reasoning) | `codex exec` subprocess; skills mounted per job |
| Review | GPT-5.6 Sol | every executor step before a gate |

Hard rules enforced in code: language mirror; questions before execution; every research job ≥100 sources, ≥40 domains, five languages (ar, en, fr, de, ru) plus any relevant extras; every number cites a source; send/publish/pay/delete wait for approval (in-app, ntfy on phone, or voice after read-back); every run is a `job_runs` row; autonomy is earned (10 clean runs).

Runtime: jobs live under `C:\Octa\jobs\<id>` (brief, inputs, evidence, out, result.json). Skills run in `claude -p` or `codex exec` subprocesses. Research uses Codex search, a persistent Playwright profile (owner logs in to Facebook/X once, read-only automation), and Brave as fallback. The build pipeline (spec → plan → worktree → coder sessions → QA → merge → register) is native TypeScript; the old Python Octa Code is design reference only.

### 3. Repository map

```
electron/core/jobs        job runner, job_runs, skill mounting
electron/core/skills      registry, frontmatter, runner policy
electron/core/octa        planner (debate), research, browser, mcp-server, brain, intake, workflows, review, build/, quality, sources, health, update
electron/cloud            gemini, gemini-live, gemini-tts, vertex, codex-chat, fallback
electron/db               settings, jobs, documents, tasks, operations
src/components            OctaPage, JobsPage, WorkflowsPage, SkillsPage, BrainPage, MapPage, BuildsPage, HealthPage, FirstRun, Settings, Tasks, Clients, DocumentEditor, VoiceBar
skills-library            MANIFEST.json, REVIEW.md, skills/<name>/SKILL.md
docs/00..07               plan, runtime contract, research engine, brain, workflows, environment, specs, decisions
.octa/tasks               the spec tasks (build reports and screenshots stay local, ignored by git)
```

### 4. Commands

```powershell
npm install
npm run rebuild:electron      # before launching Electron
npm run build && npx electron-vite preview
npm rebuild better-sqlite3    # before npm test (host ABI)
npm test                      # 220 tests
npm run dist                  # NSIS installer in release/
npm version patch             # bump + tag; pushing the tag publishes a GitHub release
```

### 4b. Releases and differential updates

**App-only releases (default).** `npm run release:app` after `npm version patch` publishes only
`octa-app-<version>.asar` (the compiled app, ~3 MB) and `app-update.json`. Installed copies download
that file, verify its SHA-512, and swap `resources/app.asar` on "Restart and update". Use
`npm run release:full` only when Electron or node_modules changed; the build script warns when the
runtime id differs from the previous release.


The Release workflow (`.github/workflows/release.yml`) runs on every `v*` tag and attaches the
installer, its `.blockmap` and `latest.yml` to the GitHub release. Installed copies check the
repository configured in Settings; the update banner downloads **only the changed blocks** of the
new installer (electron-updater differential download over the blockmaps), shows progress, and
installs silently when the user clicks "Restart and update". Do not delete old release assets: the
old blockmap is what makes the next update small. Dev builds (`electron-vite preview`) cannot
self-update and open the release page instead.

### 5. Owner checklist before daily use

1. `claude` then `/login`; enable Fable access on the Anthropic account (403 today) or pick Opus in Settings.
2. Gemini AI Studio key, ntfy topic, vault path in the first-run wizard.
3. Run the 20-question intake (Brain page).
4. Optional: Brave key, Facebook/X logins in the research browser, Photoshop path, wake-word ONNX models in `C:\Octa\models`.
5. Remove the token from the old Octa Code `.env` before any publishing.

### 6. Verified vs. not yet verified

Verified with real runs: 100-source five-language research (15 min), Luna stop-slop, Astro RTL site build in an isolated worktree, Sol review loop, W4 decision memo, W5 invoice draft, packaged installer smoke test. Not yet verified end to end: microphone voice (needs key + wake-word models), a full Fable/Astra debate (Claude login), a live website review (target site unreachable during the test).
