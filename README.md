# Octa Assistant

Octa is a voice-first desktop assistant for Windows that turns a conversation into a researched plan and finished work: website reviews, website builds, marketing for any project, decision memos, invoices, and client operations. It runs a library of 87 skills through a planner debate (Claude Fable + GPT Astra), a 100-source multilingual research engine (GPT Luna), a native build pipeline, and a reviewer (GPT Sol), with every outward action gated by the owner.

- Full handover and user guide: [docs/HANDOVER.md](docs/HANDOVER.md) (Arabic + English)
- Setup on a new machine: [SETUP.md](SETUP.md)
- Design docs: [docs/00-OCTA-ASSISTANT.md](docs/00-OCTA-ASSISTANT.md) through [docs/07-DECISIONS.md](docs/07-DECISIONS.md)
- Skills library: [skills-library/REVIEW.md](skills-library/REVIEW.md)

## Run from source

```powershell
npm install
npm run rebuild:electron   # native modules for Electron
npm run build
npx electron-vite preview  # or: npm run dev
```

Before running the test suite after an Electron rebuild:

```powershell
npm rebuild better-sqlite3
npm test
```

Installer: `npm run dist` → `release/`.

## Releases and updates

Pushing a tag `vX.Y.Z` runs the Release workflow, which builds the NSIS installer and attaches
three files to the GitHub release: `Octa-Setup-X.Y.Z.exe`, its `.blockmap`, and `latest.yml`.
Installed copies check that repository on start; when a newer version exists, the banner offers a
**differential download**: electron-updater compares the two blockmaps and fetches only the blocks
of the installer that changed, then installs silently on restart. Keep the old releases' assets
online, otherwise the updater falls back to a full download.

Two kinds of release:

- **App-only** (default, a few MB): `npm run release:app`. Uploads `octa-app-<version>.asar` and
  `app-update.json`. Installed copies download just that file and swap it on restart.
- **Full** (~220 MB): `npm run release:full`. Needed when Electron or anything in node_modules changed
  (the script warns when the runtime id differs from the previous release). Uploads the NSIS installer,
  its blockmap, latest.yml and the app-only files.

Both scripts bump nothing: run `npm version patch` first, push main and the tag, then release.

```powershell
npm version patch
git push origin main --follow-tags
npm run release:app        # or release:full
```

## License

MIT for Octa's own code. The build pipeline design follows Auto-Claude (AGPL-3.0), credited in [NOTICE.md](NOTICE.md); no Auto-Claude code is included.
